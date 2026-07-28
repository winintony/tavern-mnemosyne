import { DatabaseSync } from 'node:sqlite';

import { canonicalJson, sha256 } from '../contracts/hash.js';
import { MnemosyneRequestError } from '../contracts/errors.js';
import {
  sourceLabelForPromptIdentifier,
} from '../contracts/author-source-route.js';
import {
  staticLoreSnapshotHash,
} from '../intake/static-lore-source-identity.js';
import {
  resolvePromptFingerprintSourceUnits,
} from './source-coverage-registry.js';

const LABEL_BY_SOURCE_KIND = new Map([
  ['character_card', 'raw_character_card'],
  ['worldbook', 'raw_worldbook'],
  ['persona', 'raw_persona'],
  ['scenario', 'raw_scenario'],
]);
const COVERAGE_REQUEST_SCHEMA =
  'mnemosyne.source-removal-coverage-request.v3';
const COVERAGE_DECISION_SCHEMA =
  'mnemosyne.source-removal-coverage-decision.v3';
const COVERAGE_BINDING_SCHEMA =
  'mnemosyne.source-removal-coverage-binding.v3';
const GRANT_SCHEMA = 'mnemosyne.source-removal-grant.v3';
const GRANT_RESULT_SCHEMA =
  'mnemosyne.source-removal-grant-result.v3';
const ADMISSION_EVIDENCE_SCHEMA =
  'mnemosyne.source-removal-admission-evidence.v1';
const READER_CAPABILITY_VERSION = 'mnemosyne.memory-reader.v2';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CERTIFICATE_ID_PATTERN = /^coverage_[a-f0-9]{24}$/;
const RUN_SCOPE_KEYS = new Set([
  'branch_epoch',
  'branch_id',
  'chat_id',
  'run_id',
  'turn_index',
]);
const DECISION_KEYS = new Set([
  'accepted_targets_hash',
  'certificate_ids',
  'certificate_ids_hash',
  'coverage_binding',
  'coverage_binding_hash',
  'coverage_ready',
  'okf_versions',
  'projection_hash',
  'projection_id',
  'prompt_fingerprints_hash',
  'reader_capability_version',
  'reason_code',
  'run_scope',
  'runtime_view_hash',
  'schema',
  'snapshot_id',
  'source_set_hash',
  'source_snapshot_hash',
  'source_unit_refs',
  'source_unit_refs_hash',
  'status',
]);
const BINDING_KEYS = new Set([
  'accepted_targets_hash',
  'certificate_ids',
  'coverage_policy',
  'fingerprint_units',
  'okf_versions',
  'projection_hash',
  'projection_id',
  'prompt_fingerprints_hash',
  'read_scope',
  'reader_capability_version',
  'run_scope',
  'runtime_view_hash',
  'schema',
  'snapshot_id',
  'source_set_hash',
  'source_snapshot_hash',
  'source_unit_evidence',
  'source_unit_refs',
]);
const FINGERPRINT_UNIT_KEYS = new Set([
  'component_hash',
  'identifier',
  'source_unit_refs',
]);
const SOURCE_UNIT_EVIDENCE_KEYS = new Set([
  'certificate_id',
  'manifest_hash',
  'source_unit_ref',
]);
const OKF_VERSION_KEYS = new Set([
  'entity_ref',
  'version_hash',
]);
const GRANT_KEYS = new Set([
  'certificate_ids',
  'component_hash',
  'coverage_binding_hash',
  'coverage_policy',
  'grant_id',
  'identifier',
  'issued_at',
  'prompt_message_hash',
  'reader_capability_version',
  'run_scope',
  'schema',
  'snapshot_id',
  'source_label',
  'source_snapshot_hash',
  'source_unit_refs',
]);
const PROVIDER_FINGERPRINT_KEYS = new Set([
  'component_hash',
  'identifier',
  'prompt_message_hash',
]);

function fail(reasonCode, message, details = undefined) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function hasExactKeys(value, keys) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every(key => keys.has(key))
  );
}

function normalizeRunScope(runScope, {
  chatId = undefined,
  runId = undefined,
} = {}) {
  if (
    !hasExactKeys(runScope, RUN_SCOPE_KEYS)
    || typeof runScope.chat_id !== 'string'
    || !runScope.chat_id
    || typeof runScope.run_id !== 'string'
    || !runScope.run_id
    || typeof runScope.branch_id !== 'string'
    || !runScope.branch_id
    || !Number.isInteger(runScope.branch_epoch)
    || runScope.branch_epoch < 0
    || !Number.isInteger(runScope.turn_index)
    || runScope.turn_index < 0
    || (chatId !== undefined && runScope.chat_id !== chatId)
    || (runId !== undefined && runScope.run_id !== runId)
  ) {
    fail(
      'source_removal_run_scope_invalid',
      'Source removal requires one exact chat, run, branch, epoch, and turn scope.',
    );
  }
  return structuredClone(runScope);
}

function readScopeFor(runScope) {
  return {
    branch_id: runScope.branch_id,
    branch_epoch: runScope.branch_epoch,
    turn_index: runScope.turn_index,
  };
}

function currentSourceHash(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    fail(
      'static_lore_sources_missing',
      'Current author sources are required before source removal can be authorized.',
    );
  }
  return staticLoreSnapshotHash(sources);
}

function validatePromptFingerprints(promptFingerprints) {
  if (!Array.isArray(promptFingerprints)) {
    fail(
      'source_prompt_fingerprints_invalid',
      'Prompt fingerprints must be an array.',
    );
  }
  for (const fingerprint of promptFingerprints) {
    const expectedLabel = sourceLabelForPromptIdentifier(
      fingerprint?.identifier,
    );
    if (
      !expectedLabel
      || fingerprint.source_label !== expectedLabel
    ) {
      fail(
        'source_prompt_fingerprint_unsupported',
        'A prompt fingerprint does not map to an author source route.',
        { identifier: fingerprint?.identifier ?? null },
      );
    }
    if (!fingerprint.component_provenance) {
      fail(
        'source_prompt_provenance_missing',
        'Prompt fingerprints require sealed host component provenance.',
        { identifier: fingerprint.identifier },
      );
    }
  }
}

async function activeSnapshot(store, chatId) {
  const active = await store.getActiveStaticLoreSnapshotForAdmin({
    chatId,
  });
  if (!active) {
    fail(
      'static_lore_intake_required',
      'Static Lore Intake must complete before author sources can be removed.',
    );
  }
  const snapshot = await store.readStaticLoreSnapshotForAdmin({
    chatId,
    snapshotId: active.snapshot_id,
  });
  if (
    snapshot?.chat_id !== chatId
    || snapshot.snapshot_id !== active.snapshot_id
    || snapshot.snapshot_hash !== active.snapshot_hash
    || staticLoreSnapshotHash(snapshot.sources) !== active.snapshot_hash
  ) {
    fail(
      'static_lore_snapshot_invalid',
      'The active Static Lore Snapshot cannot be verified.',
    );
  }
  return {
    snapshot,
    snapshotId: active.snapshot_id,
    sourceSnapshotHash: active.snapshot_hash,
    absorbedKinds: new Set(
      snapshot.sources
        .map(source => LABEL_BY_SOURCE_KIND.get(source.source_kind))
        .filter(Boolean),
    ),
  };
}

function sortedUniqueStrings(value, pattern = null) {
  if (
    !Array.isArray(value)
    || value.some(item => (
      typeof item !== 'string'
      || !item
      || (pattern && !pattern.test(item))
    ))
    || new Set(value).size !== value.length
    || canonicalJson(value) !== canonicalJson([...value].sort())
  ) {
    return null;
  }
  return structuredClone(value);
}

function uniqueStrings(value, pattern = null) {
  if (
    !Array.isArray(value)
    || value.some(item => (
      typeof item !== 'string'
      || !item
      || (pattern && !pattern.test(item))
    ))
    || new Set(value).size !== value.length
  ) {
    return null;
  }
  return structuredClone(value);
}

function validFingerprintUnits(value, expected) {
  return (
    Array.isArray(value)
    && value.every(item => (
      hasExactKeys(item, FINGERPRINT_UNIT_KEYS)
      && typeof item.identifier === 'string'
      && HASH_PATTERN.test(item.component_hash ?? '')
      && sortedUniqueStrings(item.source_unit_refs)
    ))
    && canonicalJson(value) === canonicalJson(expected)
  );
}

function validOkfVersions(value) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some(item => (
      !hasExactKeys(item, OKF_VERSION_KEYS)
      || typeof item.entity_ref !== 'string'
      || !item.entity_ref.startsWith('okf://entity/')
      || !HASH_PATTERN.test(item.version_hash ?? '')
    ))
  ) {
    return false;
  }
  const identities = value.map(item => canonicalJson(item));
  const entityRefs = value.map(item => item.entity_ref);
  return (
    new Set(identities).size === identities.length
    && new Set(entityRefs).size === entityRefs.length
    && canonicalJson(value) === canonicalJson(
      [...value].sort((left, right) => (
        canonicalJson(left).localeCompare(canonicalJson(right))
      )),
    )
  );
}

function validSourceUnitEvidence(
  value,
  sourceUnitRefs,
  certificateIds,
) {
  if (
    !Array.isArray(value)
    || value.length !== sourceUnitRefs.length
  ) {
    return false;
  }
  return value.every((item, index) => (
    hasExactKeys(item, SOURCE_UNIT_EVIDENCE_KEYS)
    && item.source_unit_ref === sourceUnitRefs[index]
    && item.certificate_id === certificateIds[index]
    && HASH_PATTERN.test(item.manifest_hash ?? '')
  ));
}

function normalizeStrictCoverageDecision({
  decision,
  request,
  resolved,
}) {
  const sourceUnitRefs = sortedUniqueStrings(
    decision?.source_unit_refs,
  );
  const certificateIds = uniqueStrings(
    decision?.certificate_ids,
    CERTIFICATE_ID_PATTERN,
  );
  const binding = decision?.coverage_binding;
  if (
    !hasExactKeys(decision, DECISION_KEYS)
    || decision.schema !== COVERAGE_DECISION_SCHEMA
    || decision.status !== 'approved'
    || decision.coverage_ready !== true
    || canonicalJson(decision.run_scope)
      !== canonicalJson(request.run_scope)
    || decision.snapshot_id !== request.snapshot_id
    || decision.source_snapshot_hash !== request.source_snapshot_hash
    || decision.source_set_hash !== request.source_set_hash
    || decision.prompt_fingerprints_hash
      !== request.prompt_fingerprints_hash
    || !sourceUnitRefs
    || canonicalJson(sourceUnitRefs)
      !== canonicalJson(resolved.source_unit_refs)
    || decision.source_unit_refs_hash
      !== sha256(canonicalJson(sourceUnitRefs))
    || !certificateIds
    || certificateIds.length !== sourceUnitRefs.length
    || decision.certificate_ids_hash
      !== sha256(canonicalJson(certificateIds))
    || !HASH_PATTERN.test(decision.accepted_targets_hash ?? '')
    || !validOkfVersions(decision.okf_versions)
    || typeof decision.projection_id !== 'string'
    || !decision.projection_id
    || !HASH_PATTERN.test(decision.projection_hash ?? '')
    || !HASH_PATTERN.test(decision.runtime_view_hash ?? '')
    || decision.reader_capability_version
      !== READER_CAPABILITY_VERSION
    || decision.reason_code !== null
    || !hasExactKeys(binding, BINDING_KEYS)
    || binding.schema !== COVERAGE_BINDING_SCHEMA
    || binding.coverage_policy !== 'strict'
    || canonicalJson(binding.run_scope)
      !== canonicalJson(request.run_scope)
    || canonicalJson(binding.read_scope)
      !== canonicalJson(readScopeFor(request.run_scope))
    || binding.snapshot_id !== request.snapshot_id
    || binding.source_snapshot_hash !== request.source_snapshot_hash
    || binding.source_set_hash !== request.source_set_hash
    || binding.prompt_fingerprints_hash
      !== request.prompt_fingerprints_hash
    || !validFingerprintUnits(
      binding.fingerprint_units,
      resolved.fingerprint_units,
    )
    || canonicalJson(binding.source_unit_refs)
      !== canonicalJson(sourceUnitRefs)
    || canonicalJson(binding.certificate_ids)
      !== canonicalJson(certificateIds)
    || binding.accepted_targets_hash
      !== decision.accepted_targets_hash
    || canonicalJson(binding.okf_versions)
      !== canonicalJson(decision.okf_versions)
    || binding.projection_id !== decision.projection_id
    || binding.projection_hash !== decision.projection_hash
    || binding.runtime_view_hash !== decision.runtime_view_hash
    || !validSourceUnitEvidence(
      binding.source_unit_evidence,
      sourceUnitRefs,
      certificateIds,
    )
    || binding.reader_capability_version
      !== READER_CAPABILITY_VERSION
    || decision.coverage_binding_hash
      !== sha256(canonicalJson(binding))
  ) {
    fail(
      'source_removal_coverage_required',
      'Trusted source coverage did not approve this exact removal request.',
      { coverage_reason_code: decision?.reason_code ?? null },
    );
  }
  return structuredClone(binding);
}

function legacyCoverageBinding({
  runScope,
  status,
  sourceHash,
  promptFingerprintsHash,
  resolved,
}) {
  return {
    schema: COVERAGE_BINDING_SCHEMA,
    coverage_policy: 'legacy',
    run_scope: structuredClone(runScope),
    read_scope: readScopeFor(runScope),
    snapshot_id: status.snapshotId,
    source_snapshot_hash: status.sourceSnapshotHash,
    source_set_hash: sourceHash,
    prompt_fingerprints_hash: promptFingerprintsHash,
    fingerprint_units: structuredClone(resolved.fingerprint_units),
    source_unit_refs: structuredClone(resolved.source_unit_refs),
    certificate_ids: [],
    accepted_targets_hash: null,
    okf_versions: [],
    projection_id: null,
    projection_hash: null,
    runtime_view_hash: null,
    source_unit_evidence: [],
    reader_capability_version: null,
  };
}

async function requireTrustedCoverage({
  coveragePolicy,
  trustedCoverageVerifier,
  runScope,
  status,
  sources,
  sourceHash,
  resolved,
}) {
  const promptFingerprintsHash = sha256(canonicalJson(
    resolved.fingerprints,
  ));
  if (coveragePolicy !== 'strict') {
    return legacyCoverageBinding({
      runScope,
      status,
      sourceHash,
      promptFingerprintsHash,
      resolved,
    });
  }
  if (typeof trustedCoverageVerifier !== 'function') {
    fail(
      'source_removal_coverage_required',
      'Trusted source coverage is required before author sources can be removed.',
    );
  }
  const request = Object.freeze({
    schema: COVERAGE_REQUEST_SCHEMA,
    run_scope: structuredClone(runScope),
    snapshot_id: status.snapshotId,
    source_snapshot_hash: status.sourceSnapshotHash,
    source_set_hash: sourceHash,
    sources: structuredClone(sources),
    prompt_fingerprints: structuredClone(resolved.fingerprints),
    prompt_fingerprints_hash: promptFingerprintsHash,
    source_unit_refs: structuredClone(resolved.source_unit_refs),
    source_unit_refs_hash: sha256(canonicalJson(
      resolved.source_unit_refs,
    )),
  });
  let decision;
  try {
    decision = await trustedCoverageVerifier(request);
  } catch (error) {
    fail(
      'source_removal_coverage_required',
      'Trusted source coverage could not be verified.',
      {
        cause:
          error?.reasonCode
          ?? error?.message
          ?? 'coverage_verifier_failed',
      },
    );
  }
  return normalizeStrictCoverageDecision({
    decision,
    request,
    resolved,
  });
}

function grantIdentityPayload(grant) {
  return {
    schema: GRANT_SCHEMA,
    run_scope: grant.run_scope,
    snapshot_id: grant.snapshot_id,
    source_snapshot_hash: grant.source_snapshot_hash,
    identifier: grant.identifier,
    source_label: grant.source_label,
    prompt_message_hash: grant.prompt_message_hash,
    component_hash: grant.component_hash,
    source_unit_refs: grant.source_unit_refs,
    certificate_ids: grant.certificate_ids,
    coverage_policy: grant.coverage_policy,
    reader_capability_version: grant.reader_capability_version,
    coverage_binding_hash: grant.coverage_binding_hash,
  };
}

function grantId(grant) {
  return `grant_${sha256(canonicalJson(
    grantIdentityPayload(grant),
  )).slice(0, 24)}`;
}

function certificatesForRefs(
  refs,
  allRefs,
  allCertificateIds,
) {
  return refs.map(ref => {
    const index = allRefs.indexOf(ref);
    return index === -1 ? null : allCertificateIds[index];
  }).filter(Boolean);
}

function validGrant(grant, actualRunScope, providerHash) {
  if (
    !hasExactKeys(grant, GRANT_KEYS)
    || grant.schema !== GRANT_SCHEMA
    || canonicalJson(grant.run_scope)
      !== canonicalJson(actualRunScope)
    || !HASH_PATTERN.test(grant.source_snapshot_hash ?? '')
    || !HASH_PATTERN.test(grant.prompt_message_hash ?? '')
    || !HASH_PATTERN.test(grant.component_hash ?? '')
    || !sortedUniqueStrings(grant.source_unit_refs)
    || !Array.isArray(grant.certificate_ids)
    || grant.certificate_ids.some(id => (
      !CERTIFICATE_ID_PATTERN.test(id)
    ))
    || new Set(grant.certificate_ids).size
      !== grant.certificate_ids.length
    || (
      grant.coverage_policy === 'strict'
      ? (
        grant.reader_capability_version
          !== READER_CAPABILITY_VERSION
        || grant.certificate_ids.length
          !== grant.source_unit_refs.length
      )
      : (
        grant.coverage_policy !== 'legacy'
        || grant.reader_capability_version !== null
        || grant.certificate_ids.length !== 0
      )
    )
    || !HASH_PATTERN.test(grant.coverage_binding_hash ?? '')
    || grant.grant_id !== grantId(grant)
    || !HASH_PATTERN.test(providerHash ?? '')
    || providerHash !== grant.prompt_message_hash
    || typeof grant.issued_at !== 'string'
    || !grant.issued_at
  ) {
    return false;
  }
  return true;
}

function validProviderFingerprints(value, grants) {
  if (
    !Array.isArray(value)
    || value.length !== grants.length
    || value.some(item => (
      !hasExactKeys(item, PROVIDER_FINGERPRINT_KEYS)
      || typeof item.identifier !== 'string'
      || !HASH_PATTERN.test(item.prompt_message_hash ?? '')
      || !HASH_PATTERN.test(item.component_hash ?? '')
    ))
  ) {
    return false;
  }
  const normalized = [...value].sort((left, right) => (
    left.identifier.localeCompare(right.identifier)
  ));
  if (
    new Set(normalized.map(item => item.identifier)).size
      !== normalized.length
  ) {
    return false;
  }
  return normalized.every((item, index) => (
    item.identifier === grants[index].identifier
    && item.prompt_message_hash
      === grants[index].prompt_message_hash
    && item.component_hash === grants[index].component_hash
  ));
}

function validStrictBindingForGrants(
  binding,
  bindingHash,
  runScope,
  grants,
) {
  const sourceUnitRefs = sortedUniqueStrings(
    binding?.source_unit_refs,
  );
  const certificateIds = uniqueStrings(
    binding?.certificate_ids,
    CERTIFICATE_ID_PATTERN,
  );
  if (
    !hasExactKeys(binding, BINDING_KEYS)
    || binding.schema !== COVERAGE_BINDING_SCHEMA
    || binding.coverage_policy !== 'strict'
    || canonicalJson(binding.run_scope)
      !== canonicalJson(runScope)
    || canonicalJson(binding.read_scope)
      !== canonicalJson(readScopeFor(runScope))
    || typeof binding.snapshot_id !== 'string'
    || !binding.snapshot_id
    || !HASH_PATTERN.test(binding.source_snapshot_hash ?? '')
    || !HASH_PATTERN.test(binding.source_set_hash ?? '')
    || !HASH_PATTERN.test(binding.prompt_fingerprints_hash ?? '')
    || !sourceUnitRefs
    || !certificateIds
    || certificateIds.length !== sourceUnitRefs.length
    || !HASH_PATTERN.test(binding.accepted_targets_hash ?? '')
    || !validOkfVersions(binding.okf_versions)
    || typeof binding.projection_id !== 'string'
    || !binding.projection_id
    || !HASH_PATTERN.test(binding.projection_hash ?? '')
    || !HASH_PATTERN.test(binding.runtime_view_hash ?? '')
    || !validSourceUnitEvidence(
      binding.source_unit_evidence,
      sourceUnitRefs,
      certificateIds,
    )
    || binding.reader_capability_version
      !== READER_CAPABILITY_VERSION
    || !HASH_PATTERN.test(bindingHash ?? '')
    || bindingHash !== sha256(canonicalJson(binding))
    || grants.length === 0
    || grants.some(grant => (
      grant.coverage_policy !== 'strict'
      || grant.coverage_binding_hash !== bindingHash
      || canonicalJson(grant.run_scope)
        !== canonicalJson(runScope)
      || grant.snapshot_id !== binding.snapshot_id
      || grant.source_snapshot_hash
        !== binding.source_snapshot_hash
    ))
  ) {
    return false;
  }
  const sortedGrants = [...grants].sort((left, right) => (
    left.identifier.localeCompare(right.identifier)
  ));
  const fingerprintIdentifiers = binding.fingerprint_units?.map(
    item => item?.identifier,
  ) ?? [];
  if (
    !validFingerprintUnits(
      binding.fingerprint_units,
      binding.fingerprint_units,
    )
    || binding.fingerprint_units.length !== sortedGrants.length
    || new Set(fingerprintIdentifiers).size
      !== fingerprintIdentifiers.length
    || canonicalJson(binding.fingerprint_units)
      !== canonicalJson(
        [...binding.fingerprint_units].sort((left, right) => (
          left.identifier.localeCompare(right.identifier)
        )),
      )
  ) {
    return false;
  }
  const union = new Set();
  for (let index = 0; index < sortedGrants.length; index += 1) {
    const grant = sortedGrants[index];
    const fingerprintUnit = binding.fingerprint_units[index];
    if (
      fingerprintUnit.identifier !== grant.identifier
      || fingerprintUnit.component_hash !== grant.component_hash
      || canonicalJson(fingerprintUnit.source_unit_refs)
        !== canonicalJson(grant.source_unit_refs)
      || canonicalJson(grant.certificate_ids)
        !== canonicalJson(certificatesForRefs(
          grant.source_unit_refs,
          sourceUnitRefs,
          certificateIds,
        ))
    ) {
      return false;
    }
    for (const ref of grant.source_unit_refs) union.add(ref);
  }
  return canonicalJson([...union].sort())
    === canonicalJson(sourceUnitRefs);
}

export function createSourceRemovalGrantService({
  store,
  now = () => new Date(),
  coveragePolicy = 'legacy',
  trustedCoverageVerifier = null,
} = {}) {
  if (
    !store?.openChatForAdmin
    || !store?.getActiveStaticLoreSnapshotForAdmin
    || !store?.readStaticLoreSnapshotForAdmin
  ) {
    throw new Error(
      'Source-removal grants require a trusted chat-save store.',
    );
  }
  if (!['legacy', 'strict'].includes(coveragePolicy)) {
    throw new Error(
      `Unsupported source-removal coverage policy: ${coveragePolicy}`,
    );
  }

  async function verifyGrantAgainstLedger(
    grant,
    actualRunScope,
    providerHash,
  ) {
    if (!validGrant(grant, actualRunScope, providerHash)) {
      return false;
    }
    let opened;
    try {
      opened = await store.openChatForAdmin({
        chatId: grant.run_scope.chat_id,
      });
    } catch {
      return false;
    }
    const database = new DatabaseSync(opened.ledger_path);
    try {
      const row = database.prepare(`
        SELECT
          grants.grant_id,
          grants.run_id,
          grants.snapshot_id,
          grants.identifier,
          grants.source_label,
          grants.prompt_message_hash,
          snapshots.aggregate_hash,
          snapshots.status AS snapshot_status
        FROM source_removal_grants AS grants
        JOIN static_lore_snapshots AS snapshots
          ON snapshots.snapshot_id = grants.snapshot_id
        WHERE grants.grant_id = ?
      `).get(grant.grant_id);
      if (
        !row
        || row.run_id !== grant.run_scope.run_id
        || row.snapshot_id !== grant.snapshot_id
        || row.identifier !== grant.identifier
        || row.source_label !== grant.source_label
        || row.prompt_message_hash !== grant.prompt_message_hash
        || row.aggregate_hash !== grant.source_snapshot_hash
        || row.snapshot_status !== 'active'
      ) {
        return false;
      }
      database.prepare(`
        UPDATE source_removal_grants
        SET verified_at = COALESCE(verified_at, ?)
        WHERE grant_id = ?
      `).run(now().toISOString(), grant.grant_id);
      return true;
    } finally {
      database.close();
    }
  }

  return Object.freeze({
    async getAbsorptionStatus({ chatId }) {
      const status = await activeSnapshot(store, chatId);
      return {
        snapshot_id: status.snapshotId,
        source_snapshot_hash: status.sourceSnapshotHash,
        absorbed_source_kinds: [...status.absorbedKinds].sort(),
      };
    },

    async issue({
      chatId,
      runId,
      runScope,
      sources,
      promptFingerprints,
    }) {
      const normalizedRunScope = normalizeRunScope(runScope, {
        chatId,
        runId,
      });
      const status = await activeSnapshot(store, chatId);
      const sourceHash = currentSourceHash(sources);
      if (sourceHash !== status.sourceSnapshotHash) {
        fail(
          'static_lore_source_drift',
          'Author sources changed after Static Lore Intake.',
          {
            captured_snapshot_hash: status.sourceSnapshotHash,
            current_snapshot_hash: sourceHash,
          },
        );
      }
      validatePromptFingerprints(promptFingerprints);
      const resolved = promptFingerprints.length === 0
        ? {
          fingerprints: [],
          fingerprint_units: [],
          source_unit_refs: [],
        }
        : resolvePromptFingerprintSourceUnits({
          promptFingerprints,
          snapshot: status.snapshot,
        });
      const coverageBinding = await requireTrustedCoverage({
        coveragePolicy,
        trustedCoverageVerifier,
        runScope: normalizedRunScope,
        status,
        sources,
        sourceHash,
        resolved,
      });
      const coverageBindingHash = sha256(canonicalJson(
        coverageBinding,
      ));
      const issuedAt = now().toISOString();
      const grants = resolved.fingerprints.map(fingerprint => {
        const fingerprintUnit = resolved.fingerprint_units.find(
          item => item.identifier === fingerprint.identifier,
        );
        const payload = {
          schema: GRANT_SCHEMA,
          run_scope: structuredClone(normalizedRunScope),
          snapshot_id: status.snapshotId,
          source_snapshot_hash: status.sourceSnapshotHash,
          identifier: fingerprint.identifier,
          source_label: fingerprint.source_label,
          prompt_message_hash: fingerprint.prompt_message_hash,
          component_hash:
            fingerprint.component_provenance.component_hash,
          source_unit_refs: structuredClone(
            fingerprintUnit.source_unit_refs,
          ),
          certificate_ids: certificatesForRefs(
            fingerprintUnit.source_unit_refs,
            coverageBinding.source_unit_refs,
            coverageBinding.certificate_ids,
          ),
          coverage_policy: coverageBinding.coverage_policy,
          reader_capability_version:
            coverageBinding.reader_capability_version,
          coverage_binding_hash: coverageBindingHash,
          issued_at: issuedAt,
        };
        return {
          ...payload,
          grant_id: grantId(payload),
        };
      }).sort((left, right) => (
        left.identifier.localeCompare(right.identifier)
      ));

      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path);
      try {
        database.exec('BEGIN IMMEDIATE');
        const findExisting = database.prepare(`
          SELECT
            grant_id,
            snapshot_id,
            source_label,
            prompt_message_hash
          FROM source_removal_grants
          WHERE run_id = ? AND identifier = ?
        `);
        const insert = database.prepare(`
          INSERT INTO source_removal_grants (
            grant_id,
            run_id,
            snapshot_id,
            identifier,
            source_label,
            prompt_message_hash,
            issued_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const grant of grants) {
          const existing = findExisting.get(
            grant.run_scope.run_id,
            grant.identifier,
          );
          if (existing) {
            if (
              existing.grant_id !== grant.grant_id
              || existing.snapshot_id !== grant.snapshot_id
              || existing.source_label !== grant.source_label
              || existing.prompt_message_hash
                !== grant.prompt_message_hash
            ) {
              fail(
                'source_removal_run_reused',
                'A run id cannot be reused with a different removal scope.',
                {
                  run_id: grant.run_scope.run_id,
                  identifier: grant.identifier,
                },
              );
            }
            continue;
          }
          insert.run(
            grant.grant_id,
            grant.run_scope.run_id,
            grant.snapshot_id,
            grant.identifier,
            grant.source_label,
            grant.prompt_message_hash,
            grant.issued_at,
          );
        }
        database.exec('COMMIT');
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // The transaction may have failed before BEGIN completed.
        }
        throw error;
      } finally {
        database.close();
      }

      return {
        schema: GRANT_RESULT_SCHEMA,
        status: 'issued',
        run_scope: normalizedRunScope,
        snapshot_id: status.snapshotId,
        source_snapshot_hash: status.sourceSnapshotHash,
        absorbed_source_kinds: [...status.absorbedKinds].sort(),
        source_unit_refs: structuredClone(
          coverageBinding.source_unit_refs,
        ),
        certificate_ids: structuredClone(
          coverageBinding.certificate_ids,
        ),
        accepted_targets_hash:
          coverageBinding.accepted_targets_hash,
        okf_versions: structuredClone(
          coverageBinding.okf_versions,
        ),
        projection_id: coverageBinding.projection_id,
        projection_hash: coverageBinding.projection_hash,
        runtime_view_hash: coverageBinding.runtime_view_hash,
        coverage_policy: coverageBinding.coverage_policy,
        reader_capability_version:
          coverageBinding.reader_capability_version,
        coverage_binding: structuredClone(coverageBinding),
        coverage_binding_hash: coverageBindingHash,
        grants,
      };
    },

    async verify(grant, {
      provider_prompt_message_hash: providerHash,
      run_scope: actualRunScope,
    } = {}) {
      let normalizedActualRunScope;
      try {
        normalizedActualRunScope = normalizeRunScope(
          actualRunScope,
        );
      } catch {
        return false;
      }
      return verifyGrantAgainstLedger(
        grant,
        normalizedActualRunScope,
        providerHash,
      );
    },

    async verifyCoverageBinding({
      coverageBinding,
      coverageBindingHash,
      grants,
      runScope,
      providerFingerprints,
    } = {}) {
      let normalizedRunScope;
      try {
        normalizedRunScope = normalizeRunScope(runScope);
      } catch {
        return null;
      }
      if (!Array.isArray(grants)) return null;
      const sortedGrants = structuredClone(grants).sort(
        (left, right) => (
          String(left?.identifier ?? '').localeCompare(
            String(right?.identifier ?? ''),
          )
        ),
      );
      if (
        !validProviderFingerprints(
          providerFingerprints,
          sortedGrants,
        )
        || !validStrictBindingForGrants(
          coverageBinding,
          coverageBindingHash,
          normalizedRunScope,
          sortedGrants,
        )
      ) {
        return null;
      }
      const providerByIdentifier = new Map(
        providerFingerprints.map(item => [
          item.identifier,
          item,
        ]),
      );
      for (const grant of sortedGrants) {
        const provider = providerByIdentifier.get(
          grant.identifier,
        );
        if (!await verifyGrantAgainstLedger(
          grant,
          normalizedRunScope,
          provider.prompt_message_hash,
        )) {
          return null;
        }
      }
      return Object.freeze({
        schema: ADMISSION_EVIDENCE_SCHEMA,
        status: 'verified',
        run_scope: structuredClone(normalizedRunScope),
        snapshot: {
          snapshot_id: coverageBinding.snapshot_id,
          snapshot_hash:
            coverageBinding.source_snapshot_hash,
        },
        source_unit_refs: structuredClone(
          coverageBinding.source_unit_refs,
        ),
        certificate_ids: structuredClone(
          coverageBinding.certificate_ids,
        ),
        accepted_targets_hash:
          coverageBinding.accepted_targets_hash,
        okf_versions: structuredClone(
          coverageBinding.okf_versions,
        ),
        projection_id: coverageBinding.projection_id,
        projection_hash: coverageBinding.projection_hash,
        runtime_view_hash:
          coverageBinding.runtime_view_hash,
        coverage_binding_hash: coverageBindingHash,
      });
    },
  });
}
