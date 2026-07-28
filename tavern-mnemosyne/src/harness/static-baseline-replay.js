import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'yaml';

import { canonicalJson, sha256 } from '../contracts/hash.js';
import { MnemosyneRequestError } from '../contracts/errors.js';
import {
  parseOkfConcept,
  validateOkfBundle,
} from '../okf/bundle.js';
import {
  staticLoreSnapshotHash,
} from '../intake/static-lore-source-identity.js';
import {
  runStagedFileTransaction,
} from '../storage/staged-file-transaction.js';
import {
  inspectStaticBaseline,
  verifyStaticBaselineBinding,
} from './static-baseline-binding.js';

const PACKAGE_SCHEMA = 'mnemosyne.static-baseline-replay-package.v1';
const APPLY_RESULT_SCHEMA =
  'mnemosyne.static-baseline-replay-apply-result.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PACKAGE_KEYS = [
  'baseline',
  'character_id',
  'chat_id',
  'files',
  'intake',
  'package_hash',
  'schema',
  'snapshot',
];
const FIXED_FILE_PATHS = [
  'derived/runtime-world.json',
  'story-memory/attribute-registry.yaml',
  'story-memory/index.md',
  'story-memory/log.md',
  'story-memory/redirects.yaml',
  'story-memory/relation-registry.yaml',
];

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function isObject(value) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
  );
}

function exactKeys(value, expected) {
  return (
    isObject(value)
    && Object.keys(value).sort().join('\n')
      === [...expected].sort().join('\n')
  );
}

function assertHash(value, field) {
  if (!HASH_PATTERN.test(value ?? '')) {
    fail(
      'static_baseline_replay_package_invalid',
      `${field} must be a lowercase SHA-256 hash.`,
      { field },
    );
  }
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return (
    Number.isFinite(timestamp.getTime())
    && timestamp.toISOString() === value
  );
}

function assertSafeRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string'
    || !relativePath
    || path.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).includes('..')
    || relativePath.includes('\\')
  ) {
    fail(
      'static_baseline_replay_package_invalid',
      'Static Baseline replay contains an unsafe file path.',
      { relative_path: relativePath ?? null },
    );
  }
}

function packagePayload(replayPackage) {
  const {
    package_hash: _packageHash,
    ...payload
  } = replayPackage;
  return payload;
}

function assertRecordArray(records, label) {
  if (!Array.isArray(records)) {
    fail(
      'static_baseline_replay_package_invalid',
      `${label} must be an array.`,
    );
  }
}

function compareFields(left, right, fields) {
  for (const field of fields) {
    const order = String(left[field]).localeCompare(String(right[field]));
    if (order !== 0) return order;
  }
  return 0;
}

function assertReplayRecipeShape(replayPackage) {
  const { snapshot, intake } = replayPackage;
  if (
    !exactKeys(snapshot, [
      'captured_at',
      'character_id',
      'chat_id',
      'host_binding',
      'prompt_fingerprints',
      'schema',
      'snapshot_hash',
      'snapshot_id',
      'sources',
    ])
    || !Array.isArray(snapshot.sources)
    || snapshot.sources.length === 0
    || !Array.isArray(snapshot.prompt_fingerprints)
    || staticLoreSnapshotHash(snapshot.sources) !== snapshot.snapshot_hash
    || snapshot.snapshot_id
      !== `snapshot_${snapshot.snapshot_hash.slice(0, 24)}`
    || !exactKeys(intake, [
      'concepts',
      'extractor',
      'intake_id',
      'mode',
      'projection',
      'registry_definitions',
      'snapshot_id',
      'timestamp',
    ])
    || !exactKeys(intake.extractor, [
      'id',
      'input_tokens',
      'output_tokens',
    ])
    || !exactKeys(intake.projection, [
      'projection_id',
      'projection_kind',
      'source_version_hash',
    ])
  ) {
    fail(
      'static_baseline_replay_package_invalid',
      'Static Baseline replay snapshot or intake has an invalid shape.',
    );
  }
  const sourceIds = new Set();
  for (const source of snapshot.sources) {
    const sourceKeys = [
      'data',
      'host_ref',
      'source_id',
      'source_kind',
    ];
    if (
      !(
        exactKeys(source, sourceKeys)
        || exactKeys(source, [...sourceKeys, 'raw_data'])
      )
      || typeof source.source_id !== 'string'
      || !source.source_id
      || sourceIds.has(source.source_id)
      || typeof source.source_kind !== 'string'
      || !source.source_kind
      || typeof source.host_ref !== 'string'
      || !source.host_ref
      || source.data === undefined
    ) {
      fail(
        'static_baseline_replay_package_invalid',
        'Static Baseline replay contains an invalid source record.',
      );
    }
    sourceIds.add(source.source_id);
  }
  const fingerprintIds = new Set();
  for (const fingerprint of snapshot.prompt_fingerprints) {
    if (
      !exactKeys(fingerprint, [
        'identifier',
        'prompt_message_hash',
        'source_label',
      ])
      || typeof fingerprint.identifier !== 'string'
      || !fingerprint.identifier
      || fingerprintIds.has(fingerprint.identifier)
      || typeof fingerprint.source_label !== 'string'
      || !fingerprint.source_label
      || !HASH_PATTERN.test(fingerprint.prompt_message_hash ?? '')
    ) {
      fail(
        'static_baseline_replay_package_invalid',
        'Static Baseline replay contains an invalid prompt fingerprint.',
      );
    }
    fingerprintIds.add(fingerprint.identifier);
  }

  const entityIds = new Set();
  const relativePaths = new Set();
  const claimIds = new Set();
  const linkIds = new Set();
  for (const concept of intake.concepts) {
    if (
      !exactKeys(concept, [
        'claims',
        'entity_id',
        'links',
        'relative_path',
        'version_hash',
      ])
      || entityIds.has(concept.entity_id)
      || relativePaths.has(concept.relative_path)
    ) {
      fail(
        'static_baseline_replay_package_invalid',
        'Static Baseline replay concept recipe has an invalid shape.',
      );
    }
    entityIds.add(concept.entity_id);
    relativePaths.add(concept.relative_path);
    for (const claim of concept.claims) {
      if (
        !exactKeys(claim, [
          'claim_hash',
          'claim_id',
          'section_ref',
          'source_refs',
        ])
        || typeof claim.claim_id !== 'string'
        || !claim.claim_id
        || claimIds.has(claim.claim_id)
        || typeof claim.section_ref !== 'string'
        || !claim.section_ref
        || !HASH_PATTERN.test(claim.claim_hash ?? '')
        || !Array.isArray(claim.source_refs)
        || claim.source_refs.some(sourceRef => (
          typeof sourceRef !== 'string' || !sourceRef
        ))
      ) {
        fail(
          'static_baseline_replay_package_invalid',
          'Static Baseline replay claim recipe is invalid.',
        );
      }
      claimIds.add(claim.claim_id);
    }
    for (const link of concept.links) {
      if (
        !exactKeys(link, [
          'link_change_id',
          'relation_id',
          'source_ref',
          'target_entity_id',
        ])
        || typeof link.link_change_id !== 'string'
        || !link.link_change_id
        || linkIds.has(link.link_change_id)
        || typeof link.relation_id !== 'string'
        || !link.relation_id
        || typeof link.source_ref !== 'string'
        || !link.source_ref
        || typeof link.target_entity_id !== 'string'
        || !link.target_entity_id
      ) {
        fail(
          'static_baseline_replay_package_invalid',
          'Static Baseline replay link recipe is invalid.',
        );
      }
      linkIds.add(link.link_change_id);
    }
  }
  const attributeIds = new Set();
  for (const definition of intake.registry_definitions) {
    if (
      !exactKeys(definition, ['attribute_id', 'definition_hash'])
      || typeof definition.attribute_id !== 'string'
      || !definition.attribute_id
      || attributeIds.has(definition.attribute_id)
      || !HASH_PATTERN.test(definition.definition_hash ?? '')
    ) {
      fail(
        'static_baseline_replay_package_invalid',
        'Static Baseline replay registry recipe is invalid.',
      );
    }
    attributeIds.add(definition.attribute_id);
  }
}

function expectedStaticBaseline(replayPackage, filesByPath) {
  const { snapshot, intake } = replayPackage;
  const snapshotRelativePath = [
    'author-sources',
    'static-lore',
    snapshot.snapshot_id,
    'snapshot.json',
  ].join('/');
  const staticLoreSources = snapshot.sources
    .map(source => ({
      snapshot_id: snapshot.snapshot_id,
      source_id: source.source_id,
      source_kind: source.source_kind,
      source_hash: sha256(canonicalJson(source.data)),
      relative_path: snapshotRelativePath,
      host_ref_hash: sha256(source.host_ref),
    }))
    .sort((left, right) => compareFields(
      left,
      right,
      ['source_id'],
    ));
  const relationRegistry = parse(
    filesByPath.get('story-memory/relation-registry.yaml').content,
  );
  if (
    relationRegistry?.schema !== 'mnemosyne.relation-registry.v1'
    || !Array.isArray(relationRegistry.relations)
  ) {
    fail(
      'static_baseline_replay_package_invalid',
      'Static Baseline replay Relation Registry is invalid.',
    );
  }
  const staticConcepts = intake.concepts.map(concept => {
    const parsed = parseOkfConcept(
      filesByPath.get(`story-memory/${concept.relative_path}`).content,
      { conceptPath: `/${concept.relative_path}` },
    );
    return {
      path: `/${concept.relative_path}`,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const ledgerEvidence = {
    active_snapshot: [{
      snapshot_id: snapshot.snapshot_id,
      chat_id: snapshot.chat_id,
      aggregate_hash: snapshot.snapshot_hash,
      relative_path: snapshotRelativePath,
      host_binding_hash: sha256(canonicalJson(snapshot.host_binding)),
      status: 'active',
      captured_at: snapshot.captured_at,
    }],
    intake_runs: [{
      intake_id: intake.intake_id,
      snapshot_id: snapshot.snapshot_id,
      mode: 'initial',
      status: 'completed',
      extractor_id: intake.extractor.id,
    }],
    static_lore_sources: staticLoreSources,
    source_prompt_fingerprints: snapshot.prompt_fingerprints
      .map(fingerprint => ({
        snapshot_id: snapshot.snapshot_id,
        identifier: fingerprint.identifier,
        source_label: fingerprint.source_label,
        prompt_message_hash: fingerprint.prompt_message_hash,
      }))
      .sort((left, right) => compareFields(
        left,
        right,
        ['identifier'],
      )),
    concept_versions: intake.concepts
      .map(concept => ({
        entity_id: concept.entity_id,
        version_hash: concept.version_hash,
        relative_path: concept.relative_path,
        status: 'baseline',
        snapshot_id: snapshot.snapshot_id,
        intake_id: intake.intake_id,
      }))
      .sort((left, right) => compareFields(
        left,
        right,
        ['entity_id', 'version_hash'],
      )),
    claims: intake.concepts
      .flatMap(concept => concept.claims.map(claim => ({
        claim_id: claim.claim_id,
        concept_entity_id: concept.entity_id,
        section_ref: claim.section_ref,
        claim_hash: claim.claim_hash,
        status: 'baseline',
        snapshot_id: snapshot.snapshot_id,
        intake_id: intake.intake_id,
      })))
      .sort((left, right) => compareFields(left, right, ['claim_id'])),
    claim_sources: intake.concepts
      .flatMap(concept => concept.claims.flatMap(claim => (
        claim.source_refs.map(sourceRef => ({
          claim_id: claim.claim_id,
          source_ref: sourceRef,
        }))
      )))
      .sort((left, right) => compareFields(
        left,
        right,
        ['claim_id', 'source_ref'],
      )),
    typed_link_changes: intake.concepts
      .flatMap(concept => concept.links.map(link => ({
        link_change_id: link.link_change_id,
        source_entity_id: concept.entity_id,
        target_entity_id: link.target_entity_id,
        relation_id: link.relation_id,
        operation: 'initialize',
        source_ref: link.source_ref,
        status: 'active',
        snapshot_id: snapshot.snapshot_id,
        intake_id: intake.intake_id,
      })))
      .sort((left, right) => compareFields(
        left,
        right,
        ['link_change_id'],
      )),
    relation_registry: relationRegistry.relations
      .map(relation => ({
        relation_id: relation.id,
        parent_relation_id: relation.parent ?? null,
        definition_hash: sha256(canonicalJson(relation)),
        status: relation.status,
      }))
      .sort((left, right) => compareFields(
        left,
        right,
        ['relation_id'],
      )),
    attribute_registry: intake.registry_definitions
      .map(definition => ({
        attribute_id: definition.attribute_id,
        definition_hash: definition.definition_hash,
        status: 'active',
      }))
      .sort((left, right) => compareFields(
        left,
        right,
        ['attribute_id'],
      )),
    attribute_registry_versions: intake.registry_definitions
      .map(definition => ({
        attribute_id: definition.attribute_id,
        definition_hash: definition.definition_hash,
        snapshot_id: snapshot.snapshot_id,
        intake_id: intake.intake_id,
        status: 'active',
      }))
      .sort((left, right) => compareFields(
        left,
        right,
        ['attribute_id', 'intake_id'],
      )),
    derived_state: [{
      projection_id: intake.projection.projection_id,
      chat_id: snapshot.chat_id,
      projection_kind: intake.projection.projection_kind,
      source_version_hash: intake.projection.source_version_hash,
      status: 'ready',
    }],
  };
  const payload = {
    schema: 'mnemosyne.static-baseline-binding.v2',
    status: 'ready',
    snapshot_id: snapshot.snapshot_id,
    snapshot_hash: snapshot.snapshot_hash,
    runtime_world_hash:
      filesByPath.get('derived/runtime-world.json').content_hash,
    runtime_world_projection_hash:
      intake.projection.source_version_hash,
    canonical_static_okf_hash: sha256(canonicalJson(staticConcepts)),
    snapshot_evidence_hash: sha256(canonicalJson(
      `${JSON.stringify(snapshot, null, 2)}\n`,
    )),
    static_support_files_hash: sha256(canonicalJson([
      'story-memory/redirects.yaml',
      'story-memory/relation-registry.yaml',
      'story-memory/attribute-registry.yaml',
    ].map(relativePath => ({
      relative_path: relativePath,
      content: filesByPath.get(relativePath).content,
    })))),
    static_ledger_hash: sha256(canonicalJson(ledgerEvidence)),
    source_set_hash: sha256(canonicalJson(staticLoreSources)),
  };
  return {
    ...payload,
    binding_hash: sha256(canonicalJson(payload)),
  };
}

export function verifyStaticBaselineReplayPackage(replayPackage) {
  if (
    !exactKeys(replayPackage, PACKAGE_KEYS)
    || replayPackage.schema !== PACKAGE_SCHEMA
    || typeof replayPackage.chat_id !== 'string'
    || !replayPackage.chat_id
    || typeof replayPackage.character_id !== 'string'
    || !replayPackage.character_id
    || !isObject(replayPackage.snapshot)
    || !isObject(replayPackage.intake)
    || !Array.isArray(replayPackage.files)
  ) {
    fail(
      'static_baseline_replay_package_invalid',
      `Expected an exact ${PACKAGE_SCHEMA} package.`,
    );
  }
  assertHash(replayPackage.package_hash, 'package_hash');
  assertReplayRecipeShape(replayPackage);
  try {
    verifyStaticBaselineBinding(replayPackage.baseline);
  } catch (error) {
    fail(
      'static_baseline_replay_package_invalid',
      error.message,
    );
  }
  if (
    replayPackage.baseline.status !== 'ready'
    || replayPackage.snapshot.schema !== 'mnemosyne.static-lore-snapshot.v1'
    || replayPackage.snapshot.chat_id !== replayPackage.chat_id
    || replayPackage.snapshot.character_id !== replayPackage.character_id
    || replayPackage.snapshot.snapshot_id
      !== replayPackage.baseline.snapshot_id
    || replayPackage.snapshot.snapshot_hash
      !== replayPackage.baseline.snapshot_hash
    || !isCanonicalIsoTimestamp(replayPackage.snapshot.captured_at)
  ) {
    fail(
      'static_baseline_replay_package_invalid',
      'Static Baseline replay snapshot does not match its sealed binding.',
    );
  }

  const intake = replayPackage.intake;
  assertRecordArray(intake.concepts, 'intake.concepts');
  assertRecordArray(
    intake.registry_definitions,
    'intake.registry_definitions',
  );
  if (
    intake.mode !== 'initial'
    || typeof intake.intake_id !== 'string'
    || !/^[A-Za-z0-9_.-]+$/.test(intake.intake_id)
    || intake.snapshot_id !== replayPackage.snapshot.snapshot_id
    || !isObject(intake.extractor)
    || typeof intake.extractor.id !== 'string'
    || !intake.extractor.id
    || !Number.isInteger(intake.extractor.input_tokens)
    || intake.extractor.input_tokens < 0
    || !Number.isInteger(intake.extractor.output_tokens)
    || intake.extractor.output_tokens < 0
    || !isObject(intake.projection)
    || typeof intake.projection.projection_id !== 'string'
    || !intake.projection.projection_id
    || intake.projection.projection_kind !== 'runtime_world'
    || !HASH_PATTERN.test(intake.projection.source_version_hash ?? '')
    || !isCanonicalIsoTimestamp(intake.timestamp)
  ) {
    fail(
      'static_baseline_replay_package_invalid',
      'Static Baseline replay intake recipe is invalid.',
    );
  }

  const expectedPaths = new Set(FIXED_FILE_PATHS);
  for (const concept of intake.concepts) {
    if (
      !isObject(concept)
      || typeof concept.entity_id !== 'string'
      || !concept.entity_id
      || !HASH_PATTERN.test(concept.version_hash ?? '')
      || typeof concept.relative_path !== 'string'
      || !concept.relative_path
      || concept.relative_path.startsWith('story-memory/')
    ) {
      fail(
        'static_baseline_replay_package_invalid',
        'Static Baseline replay concept recipe is invalid.',
      );
    }
    assertSafeRelativePath(concept.relative_path);
    assertRecordArray(concept.claims, 'concept.claims');
    assertRecordArray(concept.links, 'concept.links');
    expectedPaths.add(`story-memory/${concept.relative_path}`);
  }

  const actualPaths = new Set();
  for (const file of replayPackage.files) {
    if (
      !exactKeys(file, ['content', 'content_hash', 'relative_path'])
      || typeof file.content !== 'string'
    ) {
      fail(
        'static_baseline_replay_package_invalid',
        'Static Baseline replay file record is invalid.',
      );
    }
    assertSafeRelativePath(file.relative_path);
    assertHash(file.content_hash, `${file.relative_path}.content_hash`);
    if (
      sha256(file.content) !== file.content_hash
      || actualPaths.has(file.relative_path)
    ) {
      fail(
        'static_baseline_replay_package_invalid',
        'Static Baseline replay file hashes or paths are invalid.',
        { relative_path: file.relative_path },
      );
    }
    actualPaths.add(file.relative_path);
  }
  if (
    actualPaths.size !== expectedPaths.size
    || [...expectedPaths].some(relativePath => !actualPaths.has(relativePath))
  ) {
    fail(
      'static_baseline_replay_package_invalid',
      'Static Baseline replay file set does not match its ledger recipe.',
    );
  }
  const filesByPath = new Map(
    replayPackage.files.map(file => [file.relative_path, file]),
  );
  for (const concept of intake.concepts) {
    const conceptFile = filesByPath.get(
      `story-memory/${concept.relative_path}`,
    );
    if (conceptFile.content_hash !== concept.version_hash) {
      fail(
        'static_baseline_replay_package_invalid',
        'A Static Baseline concept does not match its ledger version.',
        { relative_path: conceptFile.relative_path },
      );
    }
  }
  const runtimeWorld = replayPackage.files.find(
    file => file.relative_path === 'derived/runtime-world.json',
  );
  try {
    if (
      runtimeWorld.content_hash
        !== replayPackage.baseline.runtime_world_hash
      || intake.projection.source_version_hash
        !== replayPackage.baseline.runtime_world_projection_hash
      || sha256(canonicalJson(JSON.parse(runtimeWorld.content)))
        !== intake.projection.source_version_hash
    ) {
      fail(
        'static_baseline_replay_package_invalid',
        'Runtime World does not match the replay projection recipe.',
      );
    }
  } catch (error) {
    if (error instanceof MnemosyneRequestError) throw error;
    fail(
      'static_baseline_replay_package_invalid',
      'Runtime World is not valid JSON.',
    );
  }
  const snapshotSource =
    `${JSON.stringify(replayPackage.snapshot, null, 2)}\n`;
  const staticSupportFiles = [
    'story-memory/redirects.yaml',
    'story-memory/relation-registry.yaml',
    'story-memory/attribute-registry.yaml',
  ].map(relativePath => ({
    relative_path: relativePath,
    content: filesByPath.get(relativePath).content,
  }));
  if (
    sha256(canonicalJson(snapshotSource))
      !== replayPackage.baseline.snapshot_evidence_hash
    || sha256(canonicalJson(staticSupportFiles))
      !== replayPackage.baseline.static_support_files_hash
  ) {
    fail(
      'static_baseline_replay_package_invalid',
      'Static Baseline snapshot or support files do not match the binding.',
    );
  }
  if (
    sha256(canonicalJson(packagePayload(replayPackage)))
    !== replayPackage.package_hash
  ) {
    fail(
      'static_baseline_replay_package_invalid',
      'Static Baseline replay package hash does not match its contents.',
    );
  }
  let expectedBaseline;
  try {
    expectedBaseline = expectedStaticBaseline(replayPackage, filesByPath);
  } catch (error) {
    if (error instanceof MnemosyneRequestError) throw error;
    fail(
      'static_baseline_replay_package_invalid',
      'Static Baseline replay content cannot produce its sealed binding.',
      { cause: error.message },
    );
  }
  if (
    canonicalJson(expectedBaseline)
    !== canonicalJson(replayPackage.baseline)
  ) {
    fail(
      'static_baseline_replay_package_invalid',
      'Static Baseline replay recipe does not match its sealed ledger binding.',
      {
        expected_binding_hash: replayPackage.baseline.binding_hash,
        actual_binding_hash: expectedBaseline.binding_hash,
      },
    );
  }
  return {
    replayPackage: structuredClone(replayPackage),
    chatId: replayPackage.chat_id,
    characterId: replayPackage.character_id,
    snapshot: structuredClone(replayPackage.snapshot),
    intake: structuredClone(intake),
    files: structuredClone(replayPackage.files),
    baseline: structuredClone(replayPackage.baseline),
  };
}

function readBaselineRecipe(database, {
  chatId,
  snapshotId,
  projectionHash,
}) {
  const intakes = database.prepare(`
    SELECT
      intake_id,
      snapshot_id,
      mode,
      extractor_id,
      input_tokens,
      output_tokens,
      completed_at
    FROM intake_runs
    WHERE snapshot_id = ? AND status = 'completed'
    ORDER BY completed_at, intake_id
  `).all(snapshotId);
  if (intakes.length !== 1 || intakes[0].mode !== 'initial') {
    fail(
      'static_baseline_replay_export_unsupported',
      'Portable Static Baseline replay currently requires one initial intake.',
      {
        completed_intake_count: intakes.length,
        modes: intakes.map(intake => intake.mode),
      },
    );
  }
  const sourceIntake = intakes[0];
  const concepts = database.prepare(`
    SELECT entity_id, version_hash, relative_path
    FROM concept_versions
    WHERE
      snapshot_id = ?
      AND intake_id = ?
      AND patch_id IS NULL
      AND status = 'baseline'
    ORDER BY relative_path, entity_id, version_hash
  `).all(snapshotId, sourceIntake.intake_id).map(concept => {
    const claims = database.prepare(`
      SELECT claim_id, section_ref, claim_hash
      FROM claims
      WHERE
        snapshot_id = ?
        AND intake_id = ?
        AND concept_entity_id = ?
        AND patch_id IS NULL
        AND status = 'baseline'
      ORDER BY claim_id
    `).all(
      snapshotId,
      sourceIntake.intake_id,
      concept.entity_id,
    ).map(claim => ({
      ...claim,
      source_refs: database.prepare(`
        SELECT source_ref
        FROM claim_sources
        WHERE claim_id = ?
        ORDER BY source_ref
      `).all(claim.claim_id).map(row => row.source_ref),
    }));
    const links = database.prepare(`
      SELECT
        link_change_id,
        target_entity_id,
        relation_id,
        source_ref,
        operation
      FROM typed_link_changes
      WHERE
        snapshot_id = ?
        AND intake_id = ?
        AND source_entity_id = ?
        AND patch_id IS NULL
        AND status = 'active'
      ORDER BY link_change_id
    `).all(
      snapshotId,
      sourceIntake.intake_id,
      concept.entity_id,
    );
    if (links.some(link => link.operation !== 'initialize')) {
      fail(
        'static_baseline_replay_export_unsupported',
        'Portable initial replay found a non-initial Static Lore link.',
      );
    }
    return {
      ...concept,
      claims,
      links: links.map(({
        operation: _operation,
        ...link
      }) => link),
    };
  });
  const registryDefinitions = database.prepare(`
    SELECT attribute_id, definition_hash
    FROM attribute_registry_versions
    WHERE
      snapshot_id = ?
      AND intake_id = ?
      AND status = 'active'
    ORDER BY attribute_id
  `).all(snapshotId, sourceIntake.intake_id);
  const projections = database.prepare(`
    SELECT projection_id, projection_kind, source_version_hash
    FROM derived_state
    WHERE
      chat_id = ?
      AND projection_kind = 'runtime_world'
      AND source_version_hash = ?
      AND status = 'ready'
    ORDER BY projection_id
  `).all(chatId, projectionHash);
  if (projections.length !== 1) {
    fail(
      'static_baseline_replay_export_invalid',
      'Static Baseline has no unique ready Runtime World projection.',
    );
  }
  return {
    intake_id: sourceIntake.intake_id,
    snapshot_id: sourceIntake.snapshot_id,
    mode: sourceIntake.mode,
    extractor: {
      id: sourceIntake.extractor_id,
      input_tokens: Number(sourceIntake.input_tokens),
      output_tokens: Number(sourceIntake.output_tokens),
    },
    concepts,
    registry_definitions: registryDefinitions,
    projection: projections[0],
    timestamp: sourceIntake.completed_at,
  };
}

async function readFiles(chatSavePath, relativePaths) {
  const files = [];
  for (const relativePath of [...relativePaths].sort()) {
    const content = await readFile(
      path.join(chatSavePath, relativePath),
      'utf8',
    );
    files.push({
      relative_path: relativePath,
      content,
      content_hash: sha256(content),
    });
  }
  return files;
}

export function createStaticBaselineReplay({
  sourceStore,
  targetStore,
} = {}) {
  if (
    sourceStore
    && (
      !sourceStore.openChatForAdmin
      || !sourceStore.getActiveStaticLoreSnapshotForAdmin
      || !sourceStore.readStaticLoreSnapshotForAdmin
    )
  ) {
    throw new Error(
      'Static Baseline replay requires a trusted source chat-save store.',
    );
  }
  if (
    targetStore
    && (
      !targetStore.initializeChat
      || !targetStore.restoreStaticLoreSnapshotForAdmin
      || !targetStore.prepareStaticLoreIntakeForAdmin
      || !targetStore.commitStaticLoreIntake
      || !targetStore.inspectStaticLoreStateForAdmin
    )
  ) {
    throw new Error(
      'Static Baseline replay requires a trusted target chat-save store.',
    );
  }

  return Object.freeze({
    async exportBaseline({ chatId } = {}) {
      if (!sourceStore) {
        throw new Error('Static Baseline replay has no source store.');
      }
      const baseline = await inspectStaticBaseline({
        store: sourceStore,
        chatId,
      });
      if (baseline.status !== 'ready') {
        fail(
          'static_baseline_replay_export_invalid',
          'Only a ready Static Lore baseline can be exported.',
        );
      }
      const opened = await sourceStore.openChatForAdmin({ chatId });
      const snapshot = await sourceStore.readStaticLoreSnapshotForAdmin({
        chatId,
        snapshotId: baseline.snapshot_id,
      });
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      let intake;
      try {
        intake = readBaselineRecipe(database, {
          chatId,
          snapshotId: baseline.snapshot_id,
          projectionHash: baseline.runtime_world_projection_hash,
        });
      } finally {
        database.close();
      }
      const filePaths = new Set([
        ...FIXED_FILE_PATHS,
        ...intake.concepts.map(
          concept => `story-memory/${concept.relative_path}`,
        ),
      ]);
      const files = await readFiles(opened.chat_save_path, filePaths);
      const payload = {
        schema: PACKAGE_SCHEMA,
        chat_id: chatId,
        character_id: opened.manifest.character_id,
        snapshot,
        intake,
        files,
        baseline,
      };
      return {
        ...payload,
        package_hash: sha256(canonicalJson(payload)),
      };
    },

    async applyBaseline({
      replayPackage,
      targetChatId,
    } = {}) {
      if (!targetStore) {
        throw new Error('Static Baseline replay has no target store.');
      }
      const verified = verifyStaticBaselineReplayPackage(replayPackage);
      if (
        typeof targetChatId !== 'string'
        || !targetChatId
        || targetChatId !== verified.chatId
      ) {
        fail(
          'static_baseline_replay_target_invalid',
          'Exact Static Baseline replay requires the same logical chat id.',
        );
      }
      await targetStore.initializeChat({
        chatId: targetChatId,
        characterId: verified.characterId,
      });
      const current = await inspectStaticBaseline({
        store: targetStore,
        chatId: targetChatId,
      });
      if (canonicalJson(current) === canonicalJson(verified.baseline)) {
        return {
          schema: APPLY_RESULT_SCHEMA,
          status: 'existing',
          chat_id: targetChatId,
          snapshot_id: verified.snapshot.snapshot_id,
          baseline_binding_hash: current.binding_hash,
          package_hash: replayPackage.package_hash,
        };
      }
      if (current.status !== 'none') {
        fail(
          'static_baseline_replay_target_not_empty',
          'Static Baseline replay refuses to replace an active baseline.',
          {
            expected: verified.baseline.binding_hash,
            actual: current.binding_hash,
          },
        );
      }
      const opened = await targetStore.openChatForAdmin({
        chatId: targetChatId,
      });
      const targetBundle = await validateOkfBundle({
        chatSavePath: opened.chat_save_path,
      });
      const targetState = await targetStore.inspectStaticLoreStateForAdmin({
        chatId: targetChatId,
      });
      if (
        targetBundle.concepts.length !== 0
        || targetState.active_snapshot !== null
        || targetState.baseline_concepts.length !== 0
        || targetState.ready_runtime_projection_hashes.length !== 0
        || targetState.active_static_registry_hashes.length !== 0
        || targetState.dynamic_state.has_dynamic_state
      ) {
        fail(
          'static_baseline_replay_target_not_empty',
          'Static Baseline replay requires a completely empty governed store.',
        );
      }

      await targetStore.restoreStaticLoreSnapshotForAdmin({
        chatId: targetChatId,
        snapshot: verified.snapshot,
      });
      const writes = new Map(
        verified.files.map(file => [file.relative_path, file.content]),
      );
      await runStagedFileTransaction({
        chatSavePath: opened.chat_save_path,
        transactionId: verified.intake.intake_id,
        targetSnapshotId: verified.snapshot.snapshot_id,
        previousSnapshotId: null,
        writes,
        removals: new Set(),
        getActiveSnapshotId: async () => (
          await targetStore.getActiveStaticLoreSnapshotForAdmin({
            chatId: targetChatId,
          })
        )?.snapshot_id ?? null,
        validateFiles: async () => validateOkfBundle({
          chatSavePath: opened.chat_save_path,
        }),
        prepareLedger: async () => (
          targetStore.prepareStaticLoreIntakeForAdmin({
            chatId: targetChatId,
            snapshotId: verified.snapshot.snapshot_id,
            intakeId: verified.intake.intake_id,
            extractor: verified.intake.extractor,
            previousSnapshotId: null,
            timestamp: verified.intake.timestamp,
          })
        ),
        commitLedger: async () => targetStore.commitStaticLoreIntake({
          chatId: targetChatId,
          snapshotId: verified.snapshot.snapshot_id,
          intakeId: verified.intake.intake_id,
          extractor: verified.intake.extractor,
          concepts: verified.intake.concepts,
          registryDefinitions: verified.intake.registry_definitions,
          projection: verified.intake.projection,
          previousSnapshotId: null,
          supersededEntityIds: [],
          timestamp: verified.intake.timestamp,
        }),
      });
      const applied = await inspectStaticBaseline({
        store: targetStore,
        chatId: targetChatId,
      });
      if (canonicalJson(applied) !== canonicalJson(verified.baseline)) {
        fail(
          'static_baseline_replay_result_mismatch',
          'Applied Static Baseline does not match the sealed source binding.',
          {
            expected: verified.baseline.binding_hash,
            actual: applied.binding_hash,
          },
        );
      }
      return {
        schema: APPLY_RESULT_SCHEMA,
        status: 'applied',
        chat_id: targetChatId,
        snapshot_id: verified.snapshot.snapshot_id,
        baseline_binding_hash: applied.binding_hash,
        package_hash: replayPackage.package_hash,
      };
    },
  });
}
