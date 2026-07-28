import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  CANONICAL_DYNAMIC_WRITER_OWNER,
} from '../history/canonical-dynamic-concept.js';
import { validateOkfBundle } from '../okf/bundle.js';

const DYNAMIC_PROJECTOR_OWNER =
  'mnemosyne.dynamic-story-projector.v1';

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function canonicalStaticConcepts(bundle) {
  return bundle.concepts
    .filter(concept => (
      concept.frontmatter?.projection_owner !== DYNAMIC_PROJECTOR_OWNER
      && concept.frontmatter?.canonical_writer_owner
        !== CANONICAL_DYNAMIC_WRITER_OWNER
    ))
    .map(concept => ({
      path: concept.path,
      frontmatter: concept.frontmatter,
      body: concept.body,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function staticLedgerEvidence(
  database,
  snapshotId,
  runtimeWorldProjectionHash,
) {
  if (snapshotId === null) {
    return {
      active_snapshot: [],
      intake_runs: [],
      static_lore_sources: [],
      source_prompt_fingerprints: [],
      concept_versions: [],
      claims: [],
      claim_sources: [],
      typed_link_changes: [],
      relation_registry: [],
      attribute_registry: [],
      attribute_registry_versions: [],
      derived_state: [],
    };
  }
  const select = (table, columns, orderBy, where = 'snapshot_id = ?') => (
    database.prepare(`
      SELECT ${columns}
      FROM ${table}
      WHERE ${where}
      ORDER BY ${orderBy}
    `).all(snapshotId)
  );
  const selectAll = (table, columns, orderBy, where) => (
    database.prepare(`
      SELECT ${columns}
      FROM ${table}
      ${where ? `WHERE ${where}` : ''}
      ORDER BY ${orderBy}
    `).all()
  );
  return {
    active_snapshot: select(
      'static_lore_snapshots',
      [
        'snapshot_id',
        'chat_id',
        'aggregate_hash',
        'relative_path',
        'host_binding_hash',
        'status',
        'captured_at',
      ].join(', '),
      'snapshot_id',
    ),
    intake_runs: select(
      'intake_runs',
      'intake_id, snapshot_id, mode, status, extractor_id',
      'intake_id',
    ),
    static_lore_sources: select(
      'static_lore_sources',
      [
        'snapshot_id',
        'source_id',
        'source_kind',
        'source_hash',
        'relative_path',
        'host_ref_hash',
      ].join(', '),
      'source_id',
    ),
    source_prompt_fingerprints: select(
      'source_prompt_fingerprints',
      'snapshot_id, identifier, source_label, prompt_message_hash',
      'identifier',
    ),
    concept_versions: select(
      'concept_versions',
      [
        'entity_id',
        'version_hash',
        'relative_path',
        'status',
        'snapshot_id',
        'intake_id',
      ].join(', '),
      'entity_id, version_hash',
    ),
    claims: select(
      'claims',
      [
        'claim_id',
        'concept_entity_id',
        'section_ref',
        'claim_hash',
        'status',
        'snapshot_id',
        'intake_id',
      ].join(', '),
      'claim_id',
    ),
    claim_sources: database.prepare(`
      SELECT
        claim_sources.claim_id,
        claim_sources.source_ref
      FROM claim_sources
      JOIN claims
        ON claims.claim_id = claim_sources.claim_id
      WHERE claims.snapshot_id = ?
      ORDER BY
        claim_sources.claim_id,
        claim_sources.source_ref
    `).all(snapshotId),
    typed_link_changes: select(
      'typed_link_changes',
      [
        'link_change_id',
        'source_entity_id',
        'target_entity_id',
        'relation_id',
        'operation',
        'source_ref',
        'status',
        'snapshot_id',
        'intake_id',
      ].join(', '),
      'link_change_id',
    ),
    relation_registry: selectAll(
      'relation_registry',
      [
        'relation_id',
        'parent_relation_id',
        'definition_hash',
        'status',
      ].join(', '),
      'relation_id',
      'patch_id IS NULL',
    ),
    attribute_registry: selectAll(
      'attribute_registry',
      'attribute_id, definition_hash, status',
      'attribute_id',
      'patch_id IS NULL',
    ),
    attribute_registry_versions: select(
      'attribute_registry_versions',
      [
        'attribute_id',
        'definition_hash',
        'snapshot_id',
        'intake_id',
        'status',
      ].join(', '),
      'attribute_id, intake_id',
    ),
    derived_state: database.prepare(`
      SELECT
        projection_id,
        chat_id,
        projection_kind,
        source_version_hash,
        status
      FROM derived_state
      WHERE source_version_hash = ?
      ORDER BY projection_kind, projection_id
    `).all(runtimeWorldProjectionHash),
  };
}

function bindingPayload(binding) {
  const {
    binding_hash: _bindingHash,
    ...payload
  } = binding;
  return payload;
}

export function verifyStaticBaselineBinding(binding) {
  if (
    !binding
    || binding.schema !== 'mnemosyne.static-baseline-binding.v2'
    || !['none', 'ready'].includes(binding.status)
    || !/^[a-f0-9]{64}$/.test(binding.runtime_world_hash)
    || !/^[a-f0-9]{64}$/.test(binding.runtime_world_projection_hash)
    || !/^[a-f0-9]{64}$/.test(binding.canonical_static_okf_hash)
    || !/^[a-f0-9]{64}$/.test(binding.snapshot_evidence_hash)
    || !/^[a-f0-9]{64}$/.test(binding.static_support_files_hash)
    || !/^[a-f0-9]{64}$/.test(binding.static_ledger_hash)
    || !/^[a-f0-9]{64}$/.test(binding.source_set_hash)
    || !/^[a-f0-9]{64}$/.test(binding.binding_hash)
    || sha256(canonicalJson(bindingPayload(binding))) !== binding.binding_hash
  ) {
    throw new Error('Static baseline binding is invalid.');
  }
  if (
    binding.status === 'ready'
      ? (
        typeof binding.snapshot_id !== 'string'
        || !binding.snapshot_id
        || !/^[a-f0-9]{64}$/.test(binding.snapshot_hash)
      )
      : binding.snapshot_id !== null || binding.snapshot_hash !== null
  ) {
    throw new Error('Static baseline snapshot binding is invalid.');
  }
  return structuredClone(binding);
}

export async function inspectStaticBaseline({ store, chatId }) {
  if (
    !store?.openChatForAdmin
    || !store?.getActiveStaticLoreSnapshotForAdmin
  ) {
    throw new Error('Static baseline inspection requires a chat-save store.');
  }
  const opened = await store.openChatForAdmin({ chatId });
  const active = await store.getActiveStaticLoreSnapshotForAdmin({ chatId });
  const runtimeWorld = await readOptional(path.join(
    opened.chat_save_path,
    'derived',
    'runtime-world.json',
  ));
  const snapshotEvidence = active
    ? await readFile(path.join(
        opened.chat_save_path,
        'author-sources',
        'static-lore',
        active.snapshot_id,
        'snapshot.json',
      ), 'utf8')
    : null;
  const staticSupportFiles = [];
  for (const relativePath of [
    'story-memory/redirects.yaml',
    'story-memory/relation-registry.yaml',
    'story-memory/attribute-registry.yaml',
  ]) {
    staticSupportFiles.push({
      relative_path: relativePath,
      content: await readOptional(path.join(
        opened.chat_save_path,
        relativePath,
      )),
    });
  }
  const bundle = await validateOkfBundle({
    chatSavePath: opened.chat_save_path,
  });
  const runtimeWorldHash = sha256(runtimeWorld ?? '');
  const runtimeWorldProjectionHash = sha256(canonicalJson(
    runtimeWorld === null
      ? null
      : JSON.parse(runtimeWorld),
  ));
  const database = new DatabaseSync(opened.ledger_path, {
    readOnly: true,
  });
  let ledgerEvidence;
  try {
    ledgerEvidence = staticLedgerEvidence(
      database,
      active?.snapshot_id ?? null,
      runtimeWorldProjectionHash,
    );
  } finally {
    database.close();
  }
  const sources = ledgerEvidence.static_lore_sources;
  const payload = {
    schema: 'mnemosyne.static-baseline-binding.v2',
    status: active ? 'ready' : 'none',
    snapshot_id: active?.snapshot_id ?? null,
    snapshot_hash: active?.snapshot_hash ?? null,
    runtime_world_hash: runtimeWorldHash,
    runtime_world_projection_hash: runtimeWorldProjectionHash,
    canonical_static_okf_hash: sha256(canonicalJson(
      canonicalStaticConcepts(bundle),
    )),
    snapshot_evidence_hash: sha256(canonicalJson(snapshotEvidence)),
    static_support_files_hash: sha256(canonicalJson(staticSupportFiles)),
    static_ledger_hash: sha256(canonicalJson(ledgerEvidence)),
    source_set_hash: sha256(canonicalJson(sources)),
  };
  return {
    ...payload,
    binding_hash: sha256(canonicalJson(payload)),
  };
}
