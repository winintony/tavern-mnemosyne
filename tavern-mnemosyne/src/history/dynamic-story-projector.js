import {
  access,
  readdir,
  readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  parseOkfConcept,
  serializeOkfConcept,
  validateOkfBundle,
} from '../okf/bundle.js';
import {
  OKF_ENTITY_PREFIXES,
  OKF_TYPE_DIRECTORIES,
} from '../okf/schema.js';
import {
  createDynamicProjectionTransaction,
} from '../storage/dynamic-projection-transaction.js';
import {
  resolveBranchSegments,
  selectActiveTurnMemoryRows,
} from './active-history-resolver.js';
import {
  authorityEditPseudoRows,
  readVerifiedAuthorityEdits,
} from './authority-edit-resolver.js';
import {
  CANONICAL_DYNAMIC_WRITER_OWNER,
  compileCanonicalDynamicConcept,
  isCanonicalDynamicRecordKind,
} from './canonical-dynamic-concept.js';

const PROJECTOR_OWNER = 'mnemosyne.dynamic-story-projector.v1';
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function assertSafeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    fail('dynamic_projection_coordinate_invalid', `${field} is invalid.`, {
      field,
    });
  }
}

function assertOpaqueHostId(value, field) {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 2048
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail('dynamic_projection_coordinate_invalid', `${field} is invalid.`, {
      field,
    });
  }
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    fail(
      'dynamic_projection_coordinate_invalid',
      `${field} must be a non-negative integer.`,
      { field },
    );
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function activeCandidateRows(database, {
  chatId,
  branchId,
  segments,
}) {
  const statement = database.prepare(`
    SELECT
      turns.chat_id,
      turns.turn_index,
      turns.branch_id,
      turns.branch_epoch,
      turns.turn_id,
      turn_candidates.candidate_id,
      turn_candidates.artifact_path,
      turn_candidates.artifact_hash,
      turn_candidates.body_hash,
      turn_candidates.delta_hash,
      turn_candidates.prompt_spine_hash,
      patches.patch_id
    FROM turns
    JOIN turn_candidates
      ON turn_candidates.turn_id = turns.turn_id
    JOIN patches
      ON patches.patch_id = turn_candidates.patch_id
    WHERE
      turns.chat_id = ?
      AND turns.branch_id = ?
      AND turns.branch_epoch = ?
      AND turns.turn_index <= ?
      AND turns.status = 'committed'
      AND turn_candidates.status = 'active'
      AND patches.status = 'applied'
    ORDER BY
      turns.turn_index ASC,
      turn_candidates.candidate_id ASC
  `);
  return segments.flatMap(segment => statement.all(
    chatId,
    branchId,
    segment.branch_epoch,
    segment.through_turn_index,
  ));
}

async function loadSealedArtifacts(chatSavePath, candidateRows) {
  const loaded = [];
  for (const candidate of candidateRows) {
    if (
      typeof candidate.artifact_path !== 'string'
      || !candidate.artifact_path
      || typeof candidate.artifact_hash !== 'string'
      || !candidate.artifact_hash
    ) {
      fail(
        'dynamic_projection_artifact_unsealed',
        'An active turn candidate has no sealed turn artifact.',
        { candidate_id: candidate.candidate_id },
      );
    }
    const serialized = await readFile(
      path.join(chatSavePath, candidate.artifact_path),
      'utf8',
    );
    if (sha256(serialized) !== candidate.artifact_hash) {
      fail(
        'dynamic_projection_artifact_hash_mismatch',
        'An active turn artifact no longer matches its sealed hash.',
        { candidate_id: candidate.candidate_id },
      );
    }
    let artifact;
    try {
      artifact = JSON.parse(serialized);
    } catch {
      fail(
        'dynamic_projection_artifact_invalid',
        'An active turn artifact is not valid JSON.',
        { candidate_id: candidate.candidate_id },
      );
    }
    if (
      artifact?.schema !== 'mnemosyne.turn-artifact.v1'
      || artifact.chat_id !== candidate.chat_id
      || artifact.turn_id !== candidate.turn_id
      || artifact.candidate_id !== candidate.candidate_id
      || artifact.turn_index !== candidate.turn_index
      || artifact.branch_id !== candidate.branch_id
      || artifact.branch_epoch !== candidate.branch_epoch
      || artifact.patch_id !== candidate.patch_id
      || sha256(artifact.assistant_message?.content ?? '')
        !== candidate.body_hash
      || sha256(canonicalJson(artifact.delta)) !== candidate.delta_hash
      || artifact.prompt_spine_hash !== candidate.prompt_spine_hash
    ) {
      fail(
        'dynamic_projection_artifact_identity_mismatch',
        'An active turn artifact does not match its ledger identity.',
        { candidate_id: candidate.candidate_id },
      );
    }
    loaded.push({
      ...candidate,
      artifact,
    });
  }
  return loaded;
}

function assertRowsMatchArtifacts(rows, artifactByCandidate) {
  for (const row of rows) {
    const artifact = artifactByCandidate.get(row.candidate_id)?.artifact;
    const record = artifact?.delta?.records?.[row.sequence_index];
    const stateOperation = record?.state?.operation ?? 'set';
    const stateValueJson = record?.state?.value === undefined
      ? null
      : canonicalJson(record.state.value);
    const recordPayloadJson = (
      record?.payload === undefined
      && record?.event === undefined
    )
      ? null
      : canonicalJson(record.payload ?? record.event);
    const expectedSourceRef = [
      `chat://${encodeURIComponent(artifact?.chat_id)}`,
      `/turn/${encodeURIComponent(artifact?.turn_id)}`,
      `/candidate/${encodeURIComponent(artifact?.candidate_id)}`,
      `#chars=${record?.source_span?.start}-${record?.source_span?.end}`,
    ].join('');
    if (
      !record
      || record.kind !== row.record_kind
      || record.entity_ref !== row.entity_ref
      || record.summary !== row.summary
      || (record.state?.domain ?? null) !== row.state_domain
      || (record.state?.key ?? null) !== row.state_key
      || stateValueJson !== row.state_value_json
      || stateOperation !== row.state_operation
      || recordPayloadJson !== row.record_payload_json
      || record.source_span?.start !== row.source_start
      || record.source_span?.end !== row.source_end
      || (record.source_span?.source_mode ?? null) !== row.source_mode
      || record.source_span?.support_strength !== row.support_strength
      || expectedSourceRef !== row.source_ref
      || artifact.assistant_message.content.slice(
        row.source_start,
        row.source_end,
      ) !== record.source_span.quote
    ) {
      fail(
        'dynamic_projection_record_mismatch',
        'An active memory row does not match its sealed turn artifact.',
        { record_id: row.record_id },
      );
    }
  }
}

// Shared authority read for every model-visible consumer of typed ledger rows.
// A ready projection hash alone cannot protect non-state payload columns from
// later database drift, so callers rebind every active row to its sealed turn
// artifact immediately before deriving payload data.
export async function readVerifiedActiveHistory({
  ledgerPath,
  chatSavePath,
  chatId,
  branchId,
  branchEpoch,
  turnIndex,
} = {}) {
  assertOpaqueHostId(chatId, 'chatId');
  assertSafeId(branchId, 'branchId');
  assertNonNegativeInteger(branchEpoch, 'branchEpoch');
  assertNonNegativeInteger(turnIndex, 'turnIndex');
  if (
    typeof ledgerPath !== 'string' || !ledgerPath
    || typeof chatSavePath !== 'string' || !chatSavePath
  ) {
    fail(
      'dynamic_projection_authority_path_invalid',
      'Verified active history needs exact ledger and chat-save paths.',
    );
  }
  const database = new DatabaseSync(ledgerPath, { readOnly: true });
  let rows;
  let candidates;
  try {
    const segments = resolveBranchSegments(database, {
      chatId,
      branchId,
      branchEpoch,
      turnIndex,
    });
    rows = selectActiveTurnMemoryRows(database, {
      chatId,
      branchId,
      segments,
      order: 'ascending',
    });
    candidates = activeCandidateRows(database, {
      chatId,
      branchId,
      segments,
    });
  } finally {
    database.close();
  }
  const artifacts = await loadSealedArtifacts(chatSavePath, candidates);
  const artifactByCandidate = new Map(
    artifacts.map(artifact => [artifact.candidate_id, artifact]),
  );
  assertRowsMatchArtifacts(rows, artifactByCandidate);
  const authorityEdits = await readVerifiedAuthorityEdits({
    ledgerPath,
    chatSavePath,
    chatId,
    branchId,
    branchEpoch,
    turnIndex,
  });
  rows = [
    ...rows,
    ...authorityEditPseudoRows(authorityEdits),
  ].sort((left, right) => (
    left.turn_index - right.turn_index
    || left.sequence_index - right.sequence_index
    || left.record_id.localeCompare(right.record_id)
  ));
  return {
    rows,
    artifacts,
    artifactByCandidate,
    authorityEdits,
  };
}

async function verifiedCanonicalConcepts({
  ledgerPath,
  chatSavePath,
  rows,
  artifactByCandidate,
  authorityEdits,
}) {
  const editedEntityIds = new Set(
    authorityEdits.map(edit => edit.row.entity_id),
  );
  const concepts = rows
    .filter(row => (
      isCanonicalDynamicRecordKind(row.record_kind)
      && row.authority_edit_id === undefined
    ))
    .map(row => {
      const artifact = artifactByCandidate.get(
        row.candidate_id,
      )?.artifact;
      const sourceRecord = artifact?.delta?.records?.[row.sequence_index];
      return compileCanonicalDynamicConcept({
        recordId: row.record_id,
        record: {
          ...sourceRecord,
          source_ref: row.source_ref,
        },
        patchId: row.patch_id,
        turnIndex: row.turn_index,
        turnId: row.turn_id,
        candidateId: row.candidate_id,
        committedAt: artifact?.committed_at,
        sequenceIndex: row.sequence_index,
      });
    })
    .filter(concept => !editedEntityIds.has(concept.entityId));
  concepts.push(...authorityEdits.map(({ row, artifact }) => ({
    recordId: `authority-edit-record-${row.edit_id}`,
    entityId: row.entity_id,
    patchId: row.patch_id,
    sequenceIndex: 0,
    relativePath: `story-memory/${row.relative_path}`,
    conceptRelativePath: row.relative_path,
    document: artifact.concept.document,
    versionHash: row.version_hash,
    contractHash: artifact.concept.contract_hash,
  })));
  if (concepts.length === 0) return concepts;

  const database = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    const selectVersion = database.prepare(`
      SELECT
        concept_versions.version_hash,
        concept_versions.relative_path,
        concept_versions.patch_id,
        concept_versions.status,
        patches.status AS patch_status
      FROM concept_versions
      LEFT JOIN patches
        ON patches.patch_id = concept_versions.patch_id
      WHERE concept_versions.entity_id = ?
    `);
    for (const concept of concepts) {
      const version = selectVersion.all(concept.entityId).find(row => (
        row.version_hash === concept.versionHash
        && row.relative_path === concept.conceptRelativePath
        && row.patch_id === concept.patchId
        && row.status === 'active'
        && row.patch_status === 'applied'
      ));
      let source;
      try {
        source = await readFile(
          path.join(chatSavePath, concept.relativePath),
          'utf8',
        );
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        source = null;
      }
      if (
        !version
        || (source !== null && source !== concept.document)
      ) {
        fail(
          'dynamic_okf_concept_hash_mismatch',
          'A canonical Dynamic Story concept no longer matches its sealed record.',
          {
            entity_id: concept.entityId,
            path: concept.relativePath,
          },
        );
      }
    }
  } finally {
    database.close();
  }
  return concepts;
}

function reconstructCurrentState(rows) {
  const state = new Map();
  for (const row of rows) {
    if (row.state_domain === null || row.state_key === null) continue;
    const key = canonicalJson([
      row.entity_ref,
      row.state_domain,
      row.state_key,
    ]);
    if (row.state_operation === 'unset') {
      state.delete(key);
      continue;
    }
    state.set(key, {
      entity_ref: row.entity_ref,
      state_domain: row.state_domain,
      state_key: row.state_key,
      current_value: JSON.parse(row.state_value_json),
      source_refs: [row.source_ref],
      certainty: row.support_strength,
      valid_from_turn: row.turn_index,
    });
  }
  return [...state.values()].sort((left, right) => (
    left.entity_ref.localeCompare(right.entity_ref)
    || left.state_domain.localeCompare(right.state_domain)
    || left.state_key.localeCompare(right.state_key)
  ));
}

function conceptIdentity(row) {
  const type = Object.hasOwn(OKF_TYPE_DIRECTORIES, row.record_kind)
    ? row.record_kind
    : 'scene_event';
  const digest = sha256(canonicalJson({
    record_id: row.record_id,
    patch_id: row.patch_id,
  })).slice(0, 24);
  const slug = `turn-record-${digest}`;
  return {
    type,
    entityId: `${OKF_ENTITY_PREFIXES[type]}_${digest}`,
    slug,
    relativePath: path.posix.join(
      'story-memory',
      OKF_TYPE_DIRECTORIES[type],
      `${slug}.md`,
    ),
  };
}

function conceptTitle(row) {
  const label = row.record_kind
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return `${label} · Turn ${row.turn_index}`;
}

function dynamicConcept(row, artifact) {
  const identity = conceptIdentity(row);
  const sourceRecord = artifact.delta.records[row.sequence_index];
  const frontmatter = {
    type: identity.type,
    title: conceptTitle(row),
    timestamp: artifact.committed_at,
    entity_id: identity.entityId,
    slug: identity.slug,
    aliases: [],
    status: 'active',
    source_refs: [row.source_ref],
    links: [],
    no_links_reason: 'This turn fact is grounded directly in its sealed source artifact.',
    projection_owner: PROJECTOR_OWNER,
    record_id: row.record_id,
    record_kind: row.record_kind,
    subject_ref: row.entity_ref,
    turn_id: row.turn_id,
    candidate_id: row.candidate_id,
    patch_id: row.patch_id,
    support_strength: row.support_strength,
  };
  if (row.state_domain !== null && row.state_key !== null) {
    frontmatter.state = {
      domain: row.state_domain,
      key: row.state_key,
      operation: row.state_operation,
      ...(row.state_value_json === null
        ? {}
        : { value: JSON.parse(row.state_value_json) }),
    };
  }
  const bodySections = [
    '# Recorded Fact',
    '',
    row.summary,
    '',
    '# Evidence',
    '',
    `> ${sourceRecord.source_span.quote.replaceAll('\n', '\n> ')}`,
    '',
    `Source: \`${row.source_ref}\``,
  ];
  if (row.state_domain !== null && row.state_key !== null) {
    bodySections.push(
      '',
      '# State Change',
      '',
      `- Domain: \`${row.state_domain}\``,
      `- Key: \`${row.state_key}\``,
      `- Operation: \`${row.state_operation}\``,
      ...(row.state_value_json === null
        ? []
        : [`- Value: \`${row.state_value_json}\``]),
    );
  }
  return {
    ...identity,
    document: serializeOkfConcept({
      frontmatter,
      body: bodySections.join('\n'),
    }),
  };
}

function chronicleEntries(artifacts, rows) {
  const rowsByCandidate = new Map();
  for (const row of rows) {
    const candidateRows = rowsByCandidate.get(row.candidate_id) ?? [];
    candidateRows.push(row);
    rowsByCandidate.set(row.candidate_id, candidateRows);
  }
  return artifacts.map(({ artifact, artifact_path, artifact_hash }) => ({
    turn_index: artifact.turn_index,
    branch_epoch: artifact.branch_epoch,
    turn_id: artifact.turn_id,
    candidate_id: artifact.candidate_id,
    committed_at: artifact.committed_at,
    artifact_path,
    artifact_hash,
    user_message: structuredClone(artifact.user_message),
    assistant_message: structuredClone(artifact.assistant_message),
    writeback_reason: artifact.delta.reason ?? null,
    facts: (rowsByCandidate.get(artifact.candidate_id) ?? []).map(row => ({
      record_id: row.record_id,
      kind: row.record_kind,
      entity_ref: row.entity_ref,
      summary: row.summary,
      source_ref: row.source_ref,
    })),
  }));
}

function quoteBlock(value) {
  const content = typeof value === 'string' ? value : canonicalJson(value);
  return content.split('\n').map(line => `> ${line}`).join('\n');
}

function renderChronicle({
  chatId,
  branchId,
  branchEpoch,
  turnIndex,
  entries,
}) {
  const lines = [
    '# Chronicle',
    '',
    'This file is a deterministic projection of sealed, active turn artifacts.',
    '',
    `- Chat: \`${chatId}\``,
    `- Branch: \`${branchId}\``,
    `- Branch epoch: \`${branchEpoch}\``,
    `- Through turn: \`${turnIndex}\``,
  ];
  if (entries.length === 0) {
    lines.push('', '_No active turns at this coordinate._');
  }
  for (const entry of entries) {
    lines.push(
      '',
      `## Turn ${entry.turn_index}`,
      '',
      `- Turn id: \`${entry.turn_id}\``,
      `- Candidate id: \`${entry.candidate_id}\``,
      `- Committed at: \`${entry.committed_at}\``,
      `- Sealed artifact: \`${entry.artifact_path}\``,
      `- Writeback reason: ${entry.writeback_reason ?? '_Legacy artifact did not record one._'}`,
      '',
      '### User',
      '',
      quoteBlock(entry.user_message?.content ?? ''),
      '',
      '### Assistant',
      '',
      quoteBlock(entry.assistant_message?.content ?? ''),
      '',
      '### Recorded Facts',
      '',
    );
    if (entry.facts.length === 0) {
      lines.push('_No story-state change was recorded._');
    } else {
      for (const fact of entry.facts) {
        lines.push(
          `- **${fact.kind}**: ${fact.summary} (\`${fact.source_ref}\`)`,
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function canonicalBundle(bundle) {
  return bundle.concepts
    .map(concept => ({
      path: concept.path,
      frontmatter: concept.frontmatter,
      body: concept.body,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function bundlePath(relativePath) {
  const prefix = 'story-memory/';
  if (!relativePath.startsWith(prefix)) {
    fail(
      'dynamic_projection_path_invalid',
      'A Dynamic Story concept path is outside Story Memory.',
      { path: relativePath },
    );
  }
  return `/${relativePath.slice(prefix.length)}`;
}

function plannedCanonicalBundle({
  currentBundle,
  concepts,
  staleConceptPaths,
}) {
  const byPath = new Map(
    currentBundle.concepts.map(concept => [
      concept.path,
      {
        path: concept.path,
        frontmatter: concept.frontmatter,
        body: concept.body,
      },
    ]),
  );
  for (const relativePath of staleConceptPaths) {
    byPath.delete(bundlePath(relativePath));
  }
  for (const concept of concepts) {
    const conceptPath = bundlePath(concept.relativePath);
    const parsed = parseOkfConcept(concept.document, { conceptPath });
    byPath.set(conceptPath, {
      path: conceptPath,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  }
  return [...byPath.values()].sort((left, right) => (
    left.path.localeCompare(right.path)
  ));
}

function assertPlannedBundleConsistent(concepts) {
  const paths = new Set();
  const entityIds = new Set();
  for (const concept of concepts) {
    const entityId = concept.frontmatter?.entity_id;
    if (paths.has(concept.path) || entityIds.has(entityId)) {
      fail(
        'dynamic_projection_bundle_conflict',
        'The planned Dynamic Story bundle has a duplicate identity.',
        {
          path: concept.path,
          entity_id: entityId ?? null,
        },
      );
    }
    paths.add(concept.path);
    entityIds.add(entityId);
  }
  for (const concept of concepts) {
    for (const link of concept.frontmatter?.links ?? []) {
      if (!paths.has(link?.target)) {
        fail(
          'dynamic_projection_bundle_link_missing',
          'The planned Dynamic Story bundle would break a typed link.',
          {
            path: concept.path,
            target: link?.target ?? null,
          },
        );
      }
    }
  }
}

async function validatePublishedProjection({
  chatSavePath,
  result,
}) {
  const bundle = await validateOkfBundle({ chatSavePath });
  const canonicalBundleHash = sha256(
    canonicalJson(canonicalBundle(bundle)),
  );
  if (canonicalBundleHash !== result?.canonical_bundle_hash) {
    fail(
      'dynamic_projection_bundle_hash_mismatch',
      'The published Dynamic Story bundle does not match its manifest.',
    );
  }
  let world;
  try {
    world = JSON.parse(await readFile(
      path.join(chatSavePath, 'derived', 'dynamic-world.json'),
      'utf8',
    ));
  } catch {
    fail(
      'dynamic_projection_world_invalid',
      'The published Dynamic World manifest is not valid JSON.',
    );
  }
  if (
    world?.schema !== 'mnemosyne.dynamic-world.v1'
    || world.chat_id !== result?.chat_id
    || world.branch_id !== result?.branch_id
    || world.branch_epoch !== result?.branch_epoch
    || world.through_turn_index !== result?.through_turn_index
    || world.canonical_active_state_hash
      !== result?.canonical_active_state_hash
    || world.canonical_chronicle_hash
      !== result?.canonical_chronicle_hash
    || world.canonical_bundle_hash !== result?.canonical_bundle_hash
    || canonicalJson(world.dynamic_concept_paths)
      !== canonicalJson(result?.dynamic_concept_paths)
  ) {
    fail(
      'dynamic_projection_world_manifest_mismatch',
      'The published Dynamic World does not match its transaction manifest.',
    );
  }
}

async function assertWritableConceptPaths(chatSavePath, concepts) {
  for (const concept of concepts) {
    const conceptPath = path.join(chatSavePath, concept.relativePath);
    if (!await exists(conceptPath)) continue;
    const existing = parseOkfConcept(await readFile(conceptPath, 'utf8'), {
      conceptPath: `/${concept.relativePath.slice('story-memory/'.length)}`,
    });
    if (existing.frontmatter.projection_owner !== PROJECTOR_OWNER) {
      fail(
        'dynamic_projection_path_conflict',
        'A dynamic projection path is owned by another concept.',
        { path: concept.relativePath },
      );
    }
  }
}

async function ownedConceptPaths(
  chatSavePath,
  {
    ownerField,
    owner,
  },
) {
  const owned = [];
  const storyMemoryPath = path.join(chatSavePath, 'story-memory');
  for (const directory of new Set(Object.values(OKF_TYPE_DIRECTORIES))) {
    const directoryPath = path.join(storyMemoryPath, directory);
    const pending = [directoryPath];
    while (pending.length > 0) {
      const currentPath = pending.pop();
      let entries;
      try {
        entries = await readdir(currentPath, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        const entryPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        let parsed;
        try {
          parsed = parseOkfConcept(await readFile(entryPath, 'utf8'), {
            conceptPath: `/${path.relative(storyMemoryPath, entryPath)
              .split(path.sep)
              .join('/')}`,
          });
        } catch {
          continue;
        }
        if (parsed.frontmatter[ownerField] !== owner) continue;
        owned.push(
          path.relative(chatSavePath, entryPath)
            .split(path.sep)
            .join('/'),
        );
      }
    }
  }
  return owned.sort((left, right) => left.localeCompare(right));
}

async function projectorOwnedConceptPaths(chatSavePath) {
  return ownedConceptPaths(chatSavePath, {
    ownerField: 'projection_owner',
    owner: PROJECTOR_OWNER,
  });
}

async function canonicalWriterOwnedConceptPaths(chatSavePath) {
  return ownedConceptPaths(chatSavePath, {
    ownerField: 'canonical_writer_owner',
    owner: CANONICAL_DYNAMIC_WRITER_OWNER,
  });
}

export function createDynamicStoryProjector({
  store,
  now = () => new Date(),
  projectionTransaction = null,
} = {}) {
  if (!store?.openChatForAdmin) {
    throw new Error(
      'Dynamic Story Projector requires a trusted chat-save store.',
    );
  }
  if (typeof now !== 'function') {
    throw new Error('Dynamic Story Projector clock must be a function.');
  }
  const durableProjectionTransaction = projectionTransaction
    ?? createDynamicProjectionTransaction({ now });
  if (!durableProjectionTransaction?.run) {
    throw new Error(
      'Dynamic Story Projector transaction must expose run.',
    );
  }

  return Object.freeze({
    async rebuild({
      chatId,
      branchId = 'main',
      branchEpoch,
      turnIndex,
    } = {}) {
      assertOpaqueHostId(chatId, 'chatId');
      assertSafeId(branchId, 'branchId');
      assertNonNegativeInteger(branchEpoch, 'branchEpoch');
      assertNonNegativeInteger(turnIndex, 'turnIndex');

      const opened = await store.openChatForAdmin({ chatId });
      const {
        rows,
        artifacts,
        artifactByCandidate,
        authorityEdits,
      } = await readVerifiedActiveHistory({
        ledgerPath: opened.ledger_path,
        chatSavePath: opened.chat_save_path,
        chatId,
        branchId,
        branchEpoch,
        turnIndex,
      });

      const projectionRows = rows.filter(row => (
        !isCanonicalDynamicRecordKind(row.record_kind)
      ));
      const projectionConcepts = projectionRows.map(row => dynamicConcept(
        row,
        artifactByCandidate.get(row.candidate_id).artifact,
      )).sort((left, right) => (
        left.relativePath.localeCompare(right.relativePath)
      ));
      const canonicalConcepts = await verifiedCanonicalConcepts({
        ledgerPath: opened.ledger_path,
        chatSavePath: opened.chat_save_path,
        rows,
        artifactByCandidate,
        authorityEdits,
      });
      const authorityConcepts = [
        ...projectionConcepts,
        ...canonicalConcepts,
      ].sort((left, right) => (
        left.relativePath.localeCompare(right.relativePath)
      ));
      const entries = chronicleEntries(artifacts, rows);
      const chronicle = renderChronicle({
        chatId,
        branchId,
        branchEpoch,
        turnIndex,
        entries,
      });
      const currentState = reconstructCurrentState(rows);
      const canonicalActiveStateHash = sha256(canonicalJson(currentState));
      const canonicalChronicleHash = sha256(canonicalJson(entries));
      const dynamicConceptPaths = authorityConcepts.map(concept => (
        concept.relativePath
      ));
      const activeRecordIds = rows
        .map(row => row.record_id)
        .sort((left, right) => left.localeCompare(right));
      const authorityHash = sha256(canonicalJson({
        schema: 'mnemosyne.dynamic-projection-authority.v1',
        chat_id: chatId,
        branch_id: branchId,
        branch_epoch: branchEpoch,
        through_turn_index: turnIndex,
        canonical_active_state_hash: canonicalActiveStateHash,
        canonical_chronicle_hash: canonicalChronicleHash,
        active_record_ids: activeRecordIds,
        concepts: authorityConcepts.map(concept => ({
          path: concept.relativePath,
          document_hash: sha256(concept.document),
        })),
        active_artifacts: artifacts.map(({
          candidate_id: candidateId,
          artifact_hash: artifactHash,
        }) => ({
          candidate_id: candidateId,
          artifact_hash: artifactHash,
        })),
      }));
      const transactionId = (
        `dynamic-${authorityHash.slice(0, 32)}`
      );

      return durableProjectionTransaction.run({
        chatSavePath: opened.chat_save_path,
        transactionId,
        authorityHash,
        buildPlan: async () => {
          await assertWritableConceptPaths(
            opened.chat_save_path,
            projectionConcepts,
          );
          const currentProjectionPathSet = new Set(
            projectionConcepts.map(concept => concept.relativePath),
          );
          const currentCanonicalPathSet = new Set(
            canonicalConcepts.map(concept => concept.relativePath),
          );
          const staleProjectionPaths = (
            await projectorOwnedConceptPaths(opened.chat_save_path)
          ).filter(relativePath => (
            !currentProjectionPathSet.has(relativePath)
          ));
          const staleCanonicalPaths = (
            await canonicalWriterOwnedConceptPaths(
              opened.chat_save_path,
            )
          ).filter(relativePath => (
            !currentCanonicalPathSet.has(relativePath)
          ));
          const staleConceptPaths = [...new Set([
            ...staleProjectionPaths,
            ...staleCanonicalPaths,
          ])].sort((left, right) => left.localeCompare(right));
          const currentBundle = await validateOkfBundle({
            chatSavePath: opened.chat_save_path,
          });
          const plannedBundle = plannedCanonicalBundle({
            currentBundle,
            concepts: authorityConcepts,
            staleConceptPaths,
          });
          assertPlannedBundleConsistent(plannedBundle);
          const canonicalBundleHash = sha256(
            canonicalJson(plannedBundle),
          );
          const world = {
            schema: 'mnemosyne.dynamic-world.v1',
            chat_id: chatId,
            branch_id: branchId,
            branch_epoch: branchEpoch,
            through_turn_index: turnIndex,
            canonical_active_state_hash: canonicalActiveStateHash,
            canonical_chronicle_hash: canonicalChronicleHash,
            canonical_bundle_hash: canonicalBundleHash,
            current_state: currentState,
            chronicle: entries,
            active_record_ids: activeRecordIds,
            dynamic_concept_paths: dynamicConceptPaths,
          };
          const result = {
            schema: 'mnemosyne.dynamic-story-projection-result.v1',
            status: 'ready',
            chat_id: chatId,
            branch_id: branchId,
            branch_epoch: branchEpoch,
            through_turn_index: turnIndex,
            canonical_active_state_hash: canonicalActiveStateHash,
            canonical_chronicle_hash: canonicalChronicleHash,
            canonical_bundle_hash: canonicalBundleHash,
            dynamic_concept_paths: dynamicConceptPaths,
          };
          const writes = new Map(
            authorityConcepts.map(concept => [
              concept.relativePath,
              concept.document,
            ]),
          );
          writes.set('story-memory/chronicle.md', chronicle);
          writes.set(
            'derived/dynamic-world.json',
            `${JSON.stringify(world, null, 2)}\n`,
          );
          return {
            writes,
            removals: new Set(staleConceptPaths),
            result,
          };
        },
        validateFiles: async ({ result }) => {
          await validatePublishedProjection({
            chatSavePath: opened.chat_save_path,
            result,
          });
        },
      });
    },
  });
}
