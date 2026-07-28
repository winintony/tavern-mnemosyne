import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { canonicalJson, sha256 } from '../contracts/hash.js';
import { MnemosyneRequestError } from '../contracts/errors.js';
import {
  sourceLabelForPromptIdentifier,
} from '../contracts/author-source-route.js';
import {
  buildStaticLoreSourceUnits,
} from '../intake/static-lore-source-units.js';
import {
  staticLoreSnapshotHash,
} from '../intake/static-lore-source-identity.js';
import {
  STATIC_LORE_CONTROL_DISPOSITION,
  STATIC_LORE_CONTROL_RECORD_KIND,
  staticLoreControlTarget,
} from '../intake/static-lore-control-units.js';

const ENTRY_SCHEMA = 'mnemosyne.source-coverage-registry-entry.v3';
const REGISTRATION_SCHEMA =
  'mnemosyne.source-coverage-registration-result.v3';
const LOOKUP_SCHEMA = 'mnemosyne.source-coverage-registry-lookup.v3';
const SNAPSHOT_REGISTRATION_SCHEMA =
  'mnemosyne.source-coverage-snapshot-registration.v3';
const REQUEST_SCHEMA = 'mnemosyne.source-removal-coverage-request.v3';
const DECISION_SCHEMA = 'mnemosyne.source-removal-coverage-decision.v3';
const BINDING_SCHEMA = 'mnemosyne.source-removal-coverage-binding.v3';
const ADMISSION_EVIDENCE_SCHEMA =
  'mnemosyne.source-coverage-admission-evidence.v1';
const COMPONENT_SCHEMA = 'mnemosyne.host-component-provenance.v1';
const READER_CAPABILITY_VERSION = 'mnemosyne.memory-reader.v2';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const WORLD_INFO_DEPTH_IDENTIFIER = /^customDepthWI_(\d+)_([012])$/;
const RUN_SCOPE_KEYS = new Set([
  'branch_epoch',
  'branch_id',
  'chat_id',
  'run_id',
  'turn_index',
]);
const READ_SCOPE_KEYS = new Set([
  'branch_epoch',
  'branch_id',
  'turn_index',
]);
const REQUEST_KEYS = new Set([
  'prompt_fingerprints',
  'prompt_fingerprints_hash',
  'run_scope',
  'schema',
  'snapshot_id',
  'source_set_hash',
  'source_snapshot_hash',
  'source_unit_refs',
  'source_unit_refs_hash',
  'sources',
]);
const FINGERPRINT_KEYS = new Set([
  'component_provenance',
  'identifier',
  'prompt_message_hash',
  'source_label',
]);
const COMPONENT_KEYS = new Set([
  'component_hash',
  'identifier',
  'provenance_kind',
  'schema',
  'source_selectors',
]);
const STATIC_SELECTOR_KEYS = new Set([
  'include_parts',
  'source_id',
  'source_kind',
  'unit_id',
]);
const WORLD_INFO_SELECTOR_KEYS = new Set([
  'assembly_index',
  'depth',
  'include_parts',
  'position',
  'prepared_content_hash',
  'raw_content_hash',
  'role',
  'route_identifier',
  'source_id',
  'source_kind',
  'uid',
  'unit_id',
  'world',
]);
const FIXED_COMPONENT_SELECTORS = Object.freeze({
  charDescription: Object.freeze({
    source_id: 'character-card:active',
    source_kind: 'character_card',
    unit_id: 'description',
    include_parts: true,
  }),
  charPersonality: Object.freeze({
    source_id: 'character-card:active',
    source_kind: 'character_card',
    unit_id: 'personality',
    include_parts: true,
  }),
  scenario: Object.freeze({
    source_id: 'scenario:active',
    source_kind: 'scenario',
    unit_id: 'content',
    include_parts: true,
  }),
  personaDescription: Object.freeze({
    source_id: 'persona:active',
    source_kind: 'persona',
    unit_id: 'description',
    include_parts: true,
  }),
});

function notReady(schema, reasonCode, details = undefined) {
  return {
    schema,
    status: 'not_ready',
    coverage_ready: false,
    reason_code: reasonCode,
    ...(details === undefined ? {} : { details }),
  };
}

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

function componentPayload(component) {
  return {
    schema: component.schema,
    identifier: component.identifier,
    provenance_kind: component.provenance_kind,
    source_selectors: component.source_selectors,
  };
}

function normalizedWorldInfoRoute(value) {
  const position = Number(value?.position);
  if (position === 0) {
    return {
      identifier: 'worldInfoBefore',
      position,
      depth: null,
      role: null,
    };
  }
  if (position === 1) {
    return {
      identifier: 'worldInfoAfter',
      position,
      depth: null,
      role: null,
    };
  }
  if (position !== 4) return null;
  const rawDepth = Number(value?.depth);
  const depth = Number.isSafeInteger(rawDepth) && rawDepth >= 0
    ? rawDepth
    : 4;
  const rawRole = Number(value?.role);
  const role = [0, 1, 2].includes(rawRole) ? rawRole : 0;
  return {
    identifier: `customDepthWI_${depth}_${role}`,
    position,
    depth,
    role,
  };
}

function normalizeRunScope(runScope) {
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
  ) {
    fail(
      'source_coverage_run_scope_invalid',
      'Source coverage requires one exact chat, run, branch, epoch, and turn scope.',
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

function normalizeReadScope(readScope) {
  if (
    !hasExactKeys(readScope, READ_SCOPE_KEYS)
    || typeof readScope.branch_id !== 'string'
    || !readScope.branch_id
    || !Number.isInteger(readScope.branch_epoch)
    || readScope.branch_epoch < 0
    || !Number.isInteger(readScope.turn_index)
    || readScope.turn_index < 0
  ) {
    fail(
      'source_coverage_read_scope_invalid',
      'Source coverage requires one exact branch, epoch, and turn read scope.',
    );
  }
  return structuredClone(readScope);
}

function validateStaticComponent(component) {
  const selector = FIXED_COMPONENT_SELECTORS[component.identifier];
  const expectedPayload = selector ? {
    schema: COMPONENT_SCHEMA,
    identifier: component.identifier,
    provenance_kind: 'static_field',
    source_selectors: [structuredClone(selector)],
  } : null;
  if (
    !expectedPayload
    || component.provenance_kind !== 'static_field'
    || component.source_selectors.length !== 1
    || !hasExactKeys(
      component.source_selectors[0],
      STATIC_SELECTOR_KEYS,
    )
    || canonicalJson(componentPayload(component))
      !== canonicalJson(expectedPayload)
  ) {
    fail(
      'source_coverage_selector_drift',
      'Static host provenance no longer matches its exact source selector.',
      { identifier: component.identifier },
    );
  }
}

function validateWorldInfoComponent(component) {
  if (
    component.provenance_kind !== 'world_info_entries'
    || !(
      component.identifier === 'worldInfoBefore'
      || component.identifier === 'worldInfoAfter'
      || WORLD_INFO_DEPTH_IDENTIFIER.test(component.identifier)
    )
    || component.source_selectors.length === 0
  ) {
    fail(
      'source_coverage_selector_invalid',
      'World Info host provenance has an invalid route or empty selector set.',
      { identifier: component.identifier },
    );
  }
  const identities = new Set();
  for (
    let index = 0;
    index < component.source_selectors.length;
    index += 1
  ) {
    const selector = component.source_selectors[index];
    if (!hasExactKeys(selector, WORLD_INFO_SELECTOR_KEYS)) {
      fail(
        'source_coverage_selector_invalid',
        'World Info provenance contains unsupported selector fields.',
        { identifier: component.identifier },
      );
    }
    const route = normalizedWorldInfoRoute(selector);
    const world = typeof selector.world === 'string'
      ? selector.world
      : '';
    const uid = String(selector.uid ?? '');
    if (
      !world.trim()
      || !uid
      || !route
      || component.identifier !== route.identifier
      || selector.route_identifier !== route.identifier
      || selector.position !== route.position
      || selector.depth !== route.depth
      || selector.role !== route.role
      || selector.source_id !== `worldbook:${world}`
      || selector.source_kind !== 'worldbook'
      || String(selector.unit_id) !== uid
      || selector.include_parts !== true
      || selector.assembly_index !== index
      || !HASH_PATTERN.test(selector.raw_content_hash ?? '')
      || !HASH_PATTERN.test(selector.prepared_content_hash ?? '')
    ) {
      fail(
        'source_coverage_selector_drift',
        'World Info selector no longer matches its exact host route identity.',
        { identifier: component.identifier, assembly_index: index },
      );
    }
    const identity = `${world}\u0000${uid}`;
    if (identities.has(identity)) {
      fail(
        'source_coverage_selector_duplicate',
        'World Info provenance selects the same entry more than once.',
        { identifier: component.identifier, world, uid },
      );
    }
    identities.add(identity);
  }
}

function validateComponentProvenance(component, identifier) {
  if (!component) {
    fail(
      'source_prompt_provenance_missing',
      'Prompt fingerprints require sealed host component provenance.',
      { identifier },
    );
  }
  if (
    !hasExactKeys(component, COMPONENT_KEYS)
    || component.schema !== COMPONENT_SCHEMA
    || component.identifier !== identifier
    || !Array.isArray(component.source_selectors)
    || !HASH_PATTERN.test(component.component_hash ?? '')
  ) {
    fail(
      'source_prompt_provenance_invalid',
      'Prompt fingerprint host provenance has an invalid shape.',
      { identifier },
    );
  }
  if (
    sha256(canonicalJson(componentPayload(component)))
      !== component.component_hash
  ) {
    fail(
      'source_prompt_provenance_drift',
      'Prompt fingerprint host provenance seal no longer matches.',
      { identifier },
    );
  }
  if (component.provenance_kind === 'static_field') {
    validateStaticComponent(component);
  } else {
    validateWorldInfoComponent(component);
  }
  return structuredClone(component);
}

function sourceEntryByUid(entries, uid) {
  const matches = Object.entries(entries ?? {}).filter(
    ([key, entry]) => String(entry?.uid ?? key) === String(uid),
  );
  if (matches.length !== 1) return null;
  return matches[0][1];
}

function verifyWorldInfoSelectorAgainstSnapshot(selector, source) {
  const semanticEntry = sourceEntryByUid(
    source.data?.entries,
    selector.uid,
  );
  const rawEntries = source.raw_data?.entries;
  const rawEntry = rawEntries === undefined
    ? semanticEntry
    : sourceEntryByUid(rawEntries, selector.uid);
  const route = normalizedWorldInfoRoute(rawEntry);
  const semanticRoute = normalizedWorldInfoRoute(semanticEntry);
  if (
    !semanticEntry
    || !rawEntry
    || source.source_id !== `worldbook:${selector.world}`
    || String(semanticEntry.uid ?? selector.uid) !== String(selector.uid)
    || !route
    || !semanticRoute
    || canonicalJson(route) !== canonicalJson(semanticRoute)
    || route.identifier !== selector.route_identifier
    || route.position !== selector.position
    || route.depth !== selector.depth
    || route.role !== selector.role
    || String(rawEntry.content ?? '')
      !== String(semanticEntry.content ?? '')
    || sha256(String(rawEntry.content ?? ''))
      !== selector.raw_content_hash
  ) {
    fail(
      'source_coverage_worldbook_selector_drift',
      'World Info provenance cannot be mechanically reproduced from the active snapshot.',
      {
        source_id: selector.source_id,
        world: selector.world,
        uid: String(selector.uid),
      },
    );
  }
  // prepared_content_hash intentionally remains a host-rendering binding.
  // Regex/macro preparation is not reproducible from the Static Lore Snapshot.
}

function unitsForSelector(selector, snapshot, units) {
  if (
    typeof selector.source_id !== 'string'
    || !selector.source_id
    || typeof selector.source_kind !== 'string'
    || !selector.source_kind
    || typeof selector.unit_id !== 'string'
    || !selector.unit_id
    || selector.unit_id.includes(':part:')
    || typeof selector.include_parts !== 'boolean'
  ) {
    fail(
      'source_coverage_selector_invalid',
      'Host provenance contains an invalid source-unit selector.',
    );
  }
  const matchingSources = snapshot.sources.filter(source => (
    source.source_id === selector.source_id
    && source.source_kind === selector.source_kind
  ));
  if (matchingSources.length !== 1) {
    fail(
      matchingSources.length === 0
        ? 'source_coverage_selector_missing'
        : 'source_coverage_selector_conflict',
      'Host provenance does not select exactly one active snapshot source.',
      {
        source_id: selector.source_id,
        source_kind: selector.source_kind,
      },
    );
  }
  const [source] = matchingSources;
  if (selector.source_kind === 'worldbook') {
    verifyWorldInfoSelectorAgainstSnapshot(selector, source);
  }
  const sourceUnits = units.filter(unit => (
    unit.source_id === selector.source_id
    && unit.source_kind === selector.source_kind
  ));
  const base = sourceUnits.filter(
    unit => unit.unit_id === selector.unit_id,
  );
  const partPrefix = `${selector.unit_id}:part:`;
  const parts = sourceUnits
    .filter(unit => unit.unit_id.startsWith(partPrefix))
    .sort((left, right) => {
      const leftIndex = Number(left.unit_id.slice(partPrefix.length));
      const rightIndex = Number(right.unit_id.slice(partPrefix.length));
      return leftIndex - rightIndex;
    });
  if (!selector.include_parts) {
    if (base.length !== 1) {
      fail(
        'source_coverage_selector_missing',
        'Exact source selector has no active base unit.',
        { source_id: selector.source_id, unit_id: selector.unit_id },
      );
    }
    return base;
  }
  if (base.length === 1 && parts.length === 0) return base;
  if (base.length === 0 && parts.length > 0) {
    const contiguous = parts.every((unit, index) => (
      unit.unit_id === `${partPrefix}${index + 1}`
    ));
    if (!contiguous) {
      fail(
        'source_coverage_selector_conflict',
        'Split source units are incomplete or out of sequence.',
        { source_id: selector.source_id, unit_id: selector.unit_id },
      );
    }
    return parts;
  }
  fail(
    base.length === 0
      ? 'source_coverage_selector_missing'
      : 'source_coverage_selector_conflict',
    'Source selector cannot choose one unambiguous base or split unit set.',
    { source_id: selector.source_id, unit_id: selector.unit_id },
  );
}

export function resolvePromptFingerprintSourceUnits({
  promptFingerprints,
  snapshot,
  units = null,
} = {}) {
  if (
    !Array.isArray(promptFingerprints)
    || promptFingerprints.length === 0
    || !snapshot
    || !Array.isArray(snapshot.sources)
  ) {
    fail(
      'source_coverage_prompt_manifest_missing',
      'Coverage requires prompt fingerprints and an active Static Lore Snapshot.',
    );
  }
  const activeUnits = units ?? buildStaticLoreSourceUnits({
    snapshotId: snapshot.snapshot_id,
    sources: snapshot.sources,
  });
  const identifiers = new Set();
  const selectedRefs = new Map();
  const fingerprints = [];
  const fingerprintUnits = [];
  for (
    const fingerprint of structuredClone(promptFingerprints)
      .sort((left, right) => (
        String(left?.identifier ?? '')
          .localeCompare(String(right?.identifier ?? ''))
      ))
  ) {
    const expectedLabel = sourceLabelForPromptIdentifier(
      fingerprint?.identifier,
    );
    if (
      !hasExactKeys(fingerprint, FINGERPRINT_KEYS)
      || !expectedLabel
      || fingerprint.source_label !== expectedLabel
      || identifiers.has(fingerprint.identifier)
      || !HASH_PATTERN.test(fingerprint.prompt_message_hash ?? '')
    ) {
      fail(
        identifiers.has(fingerprint?.identifier)
          ? 'source_prompt_fingerprint_duplicate'
          : 'source_prompt_fingerprint_unsupported',
        'Prompt fingerprint identity is invalid or ambiguous.',
        { identifier: fingerprint?.identifier ?? null },
      );
    }
    identifiers.add(fingerprint.identifier);
    const component = validateComponentProvenance(
      fingerprint.component_provenance,
      fingerprint.identifier,
    );
    const componentRefs = [];
    for (const selector of component.source_selectors) {
      for (const unit of unitsForSelector(
        selector,
        snapshot,
        activeUnits,
      )) {
        const owner = selectedRefs.get(unit.ref);
        if (owner) {
          fail(
            'source_coverage_selector_conflict',
            'More than one prompt route selects the same source unit.',
            {
              source_unit_ref: unit.ref,
              identifiers: [owner, fingerprint.identifier].sort(),
            },
          );
        }
        selectedRefs.set(unit.ref, fingerprint.identifier);
        componentRefs.push(unit.ref);
      }
    }
    if (componentRefs.length === 0) {
      fail(
        'source_coverage_selector_missing',
        'Prompt provenance does not select an active source unit.',
        { identifier: fingerprint.identifier },
      );
    }
    fingerprints.push({
      ...fingerprint,
      component_provenance: component,
    });
    fingerprintUnits.push({
      identifier: fingerprint.identifier,
      component_hash: component.component_hash,
      source_unit_refs: [...componentRefs].sort(),
    });
  }
  return {
    fingerprints,
    fingerprint_units: fingerprintUnits,
    source_unit_refs: [...selectedRefs.keys()].sort(),
  };
}

function coverageDecision(request, {
  approved,
  reasonCode = null,
  sourceUnitRefs = request?.source_unit_refs ?? [],
  certificateIds = [],
  coverageBinding = null,
}) {
  const normalizedSourceUnitRefs = Array.isArray(sourceUnitRefs)
    ? structuredClone(sourceUnitRefs)
    : [];
  const normalizedCertificateIds = Array.isArray(certificateIds)
    ? structuredClone(certificateIds)
    : [];
  return {
    schema: DECISION_SCHEMA,
    status: approved ? 'approved' : 'not_ready',
    coverage_ready: approved,
    run_scope: request?.run_scope
      ? structuredClone(request.run_scope)
      : null,
    snapshot_id: request?.snapshot_id ?? null,
    source_snapshot_hash: request?.source_snapshot_hash ?? null,
    source_set_hash: request?.source_set_hash ?? null,
    prompt_fingerprints_hash: request?.prompt_fingerprints_hash ?? null,
    source_unit_refs: normalizedSourceUnitRefs,
    source_unit_refs_hash: sha256(canonicalJson(
      normalizedSourceUnitRefs,
    )),
    certificate_ids: normalizedCertificateIds,
    certificate_ids_hash: sha256(canonicalJson(
      normalizedCertificateIds,
    )),
    accepted_targets_hash: approved
      ? coverageBinding.accepted_targets_hash
      : null,
    okf_versions: approved
      ? structuredClone(coverageBinding.okf_versions)
      : [],
    projection_id: approved
      ? coverageBinding.projection_id
      : null,
    projection_hash: approved
      ? coverageBinding.projection_hash
      : null,
    runtime_view_hash: approved
      ? coverageBinding.runtime_view_hash
      : null,
    reader_capability_version: approved
      ? READER_CAPABILITY_VERSION
      : null,
    coverage_binding: approved
      ? structuredClone(coverageBinding)
      : null,
    coverage_binding_hash: approved
      ? sha256(canonicalJson(coverageBinding))
      : null,
    reason_code: approved ? null : reasonCode,
  };
}

function admissionEvidenceForLookups(unitLookups) {
  const sorted = [...unitLookups].sort((left, right) => (
    left.source_unit_ref.localeCompare(right.source_unit_ref)
  ));
  if (sorted.length === 0) {
    fail(
      'source_coverage_admission_evidence_missing',
      'Approved coverage requires at least one exact source-unit certificate.',
    );
  }
  const projection = {
    projection_id: sorted[0].lookup.certificate?.projection_id,
    projection_hash: sorted[0].lookup.certificate?.projection_hash,
    runtime_view_hash: sorted[0].lookup.certificate?.runtime_view_hash,
  };
  if (
    typeof projection.projection_id !== 'string'
    || !projection.projection_id
    || !HASH_PATTERN.test(projection.projection_hash ?? '')
    || !HASH_PATTERN.test(projection.runtime_view_hash ?? '')
  ) {
    fail(
      'source_coverage_projection_binding_invalid',
      'Coverage certificates do not expose one valid runtime projection.',
    );
  }

  const sourceUnitEvidence = [];
  const targetsByIdentity = new Map();
  const localClassificationsByIdentity = new Map();
  const versionsByIdentity = new Map();
  const versionByEntity = new Map();
  const certificateIds = new Set();
  for (const { source_unit_ref: sourceUnitRef, lookup } of sorted) {
    const certificate = lookup.certificate;
    if (
      certificate?.projection_id !== projection.projection_id
      || certificate.projection_hash !== projection.projection_hash
      || certificate.runtime_view_hash !== projection.runtime_view_hash
    ) {
      fail(
        'source_coverage_projection_binding_conflict',
        'Exact source-unit certificates do not share one runtime projection.',
        { source_unit_ref: sourceUnitRef },
      );
    }
    if (
      !certificate
      || !HASH_PATTERN.test(lookup.manifest_hash ?? '')
      || !/^coverage_[a-f0-9]{24}$/.test(
        lookup.certificate_id ?? '',
      )
      || !Array.isArray(certificate.coverage)
      || certificate.coverage.length === 0
      || certificate.structural_coverage?.status !== 'passed'
      || certificate.structural_coverage.required_span_count
        !== certificate.coverage.length
      || (
        certificate.structural_coverage.covered_span_count
        + (
          certificate.structural_coverage
            .classified_non_story_span_count
          ?? 0
        )
      ) !== certificate.coverage.length
      || certificate.structural_coverage
        .retained_non_runtime_span_count !== 0
    ) {
      fail(
        'source_coverage_admission_evidence_invalid',
        'Coverage certificates cannot be aggregated into exact admission evidence.',
        { source_unit_ref: sourceUnitRef },
      );
    }
    sourceUnitEvidence.push({
      source_unit_ref: sourceUnitRef,
      manifest_hash: lookup.manifest_hash,
      certificate_id: lookup.certificate_id,
    });
    if (certificateIds.has(lookup.certificate_id)) {
      fail(
        'source_coverage_certificate_binding_conflict',
        'One coverage certificate cannot authorize multiple source units.',
        { certificate_id: lookup.certificate_id },
      );
    }
    certificateIds.add(lookup.certificate_id);
    for (const item of certificate.coverage) {
      if (item?.disposition === STATIC_LORE_CONTROL_DISPOSITION) {
        const target = item.local_control_target;
        let verifiedTarget = null;
        try {
          verifiedTarget = staticLoreControlTarget({
            schema: 'mnemosyne.static-lore-control-classification.v1',
            control_kind: target?.control_kind,
            source_kind: target?.source_kind,
            unit_id: target?.unit_id,
            marker_hash: target?.marker_hash,
            classification_hash: target?.classification_hash,
          });
        } catch {
          verifiedTarget = null;
        }
        if (
          item.record_kind !== STATIC_LORE_CONTROL_RECORD_KIND
          || typeof item.evidence_id !== 'string'
          || !item.evidence_id
          || !verifiedTarget
          || !HASH_PATTERN.test(target.marker_hash ?? '')
          || !HASH_PATTERN.test(target.classification_hash ?? '')
          || !HASH_PATTERN.test(target.local_acceptance_hash ?? '')
          || target.local_acceptance_hash !== item.evidence_hash
        ) {
          fail(
            'source_coverage_local_control_invalid',
            'A verified certificate lacks a valid local control binding.',
            {
              source_unit_ref: sourceUnitRef,
              evidence_id: item?.evidence_id ?? null,
            },
          );
        }
        const localClassification = {
          source_unit_ref: sourceUnitRef,
          control_kind: target.control_kind,
          marker_hash: target.marker_hash,
          classification_hash: target.classification_hash,
          local_acceptance_hash: target.local_acceptance_hash,
        };
        localClassificationsByIdentity.set(
          canonicalJson(localClassification),
          localClassification,
        );
        continue;
      }
      const target = item?.accepted_target;
      if (
        item?.disposition !== 'covered'
        || typeof item.evidence_id !== 'string'
        || !item.evidence_id
        || typeof target?.entity_ref !== 'string'
        || !target.entity_ref.startsWith('okf://entity/')
        || typeof target.field_path !== 'string'
        || !target.field_path
        || typeof target.claim_kind !== 'string'
        || !target.claim_kind
        || !HASH_PATTERN.test(target.claim_hash ?? '')
        || !HASH_PATTERN.test(target.okf_version_hash ?? '')
        || !HASH_PATTERN.test(target.semantic_acceptance_hash ?? '')
      ) {
        fail(
          'source_coverage_accepted_target_invalid',
          'A verified certificate lacks a hash-only accepted target binding.',
          {
            source_unit_ref: sourceUnitRef,
            evidence_id: item?.evidence_id ?? null,
          },
        );
      }
      const acceptedTarget = {
        entity_ref: target.entity_ref,
        field_path: target.field_path,
        claim_hash: target.claim_hash,
        okf_version_hash: target.okf_version_hash,
        semantic_acceptance_hash: target.semantic_acceptance_hash,
      };
      targetsByIdentity.set(
        canonicalJson(acceptedTarget),
        acceptedTarget,
      );
      const version = {
        entity_ref: target.entity_ref,
        version_hash: target.okf_version_hash,
      };
      const priorVersion = versionByEntity.get(target.entity_ref);
      if (
        priorVersion
        && priorVersion !== target.okf_version_hash
      ) {
        fail(
          'source_coverage_okf_version_conflict',
          'Accepted targets disagree on one OKF entity version.',
          { entity_ref: target.entity_ref },
        );
      }
      versionByEntity.set(
        target.entity_ref,
        target.okf_version_hash,
      );
      versionsByIdentity.set(canonicalJson(version), version);
    }
  }
  const acceptedTargets = [...targetsByIdentity.values()].sort(
    (left, right) => canonicalJson(left).localeCompare(
      canonicalJson(right),
    ),
  );
  const okfVersions = [...versionsByIdentity.values()].sort(
    (left, right) => canonicalJson(left).localeCompare(
      canonicalJson(right),
    ),
  );
  const localClassifications = [
    ...localClassificationsByIdentity.values(),
  ].sort(
    (left, right) => canonicalJson(left).localeCompare(
      canonicalJson(right),
    ),
  );
  const evidencePayload = {
    schema: ADMISSION_EVIDENCE_SCHEMA,
    source_units: sourceUnitEvidence,
    accepted_targets: acceptedTargets,
    local_classifications: localClassifications,
  };
  return {
    accepted_targets_hash: sha256(canonicalJson(evidencePayload)),
    okf_versions: okfVersions,
    projection_id: projection.projection_id,
    projection_hash: projection.projection_hash,
    runtime_view_hash: projection.runtime_view_hash,
    source_unit_evidence: sourceUnitEvidence,
  };
}

function sourceUnitKey(snapshotId, sourceUnitRef, readScope) {
  return sha256(canonicalJson({
    snapshot_id: snapshotId,
    source_unit_ref: sourceUnitRef,
    read_scope: readScope,
  }));
}

function registryEntryPath(
  chatSavePath,
  snapshotId,
  sourceUnitRef,
  readScope,
) {
  return path.join(
    chatSavePath,
    'derived',
    'source-coverage-registry',
    'v3',
    'units',
    `${sourceUnitKey(snapshotId, sourceUnitRef, readScope)}.json`,
  );
}

async function writeJsonAtomic(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      'utf8',
    );
    await rename(temporaryPath, targetPath);
  } finally {
    await unlink(temporaryPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function entryWithHash(payload) {
  return {
    ...payload,
    entry_hash: sha256(canonicalJson(payload)),
  };
}

function hasValidEntryHash(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const { entry_hash: entryHash, ...payload } = entry;
  return HASH_PATTERN.test(entryHash ?? '')
    && sha256(canonicalJson(payload)) === entryHash;
}

async function activeContext(store, chatId) {
  const active = await store.getActiveStaticLoreSnapshotForAdmin({ chatId });
  if (!active) {
    return notReady(
      LOOKUP_SCHEMA,
      'source_coverage_active_snapshot_missing',
    );
  }
  const snapshot = await store.readStaticLoreSnapshotForAdmin({
    chatId,
    snapshotId: active.snapshot_id,
  });
  if (
    snapshot?.snapshot_id !== active.snapshot_id
    || snapshot.snapshot_hash !== active.snapshot_hash
    || snapshot.chat_id !== chatId
  ) {
    return notReady(
      LOOKUP_SCHEMA,
      'source_coverage_active_snapshot_stale',
    );
  }
  const opened = await store.openChatForAdmin({ chatId });
  return {
    status: 'ready',
    active,
    snapshot,
    opened,
    units: buildStaticLoreSourceUnits({
      snapshotId: snapshot.snapshot_id,
      sources: snapshot.sources,
    }),
  };
}

function normalizeTrustedManifest(manifest, {
  chatId,
  context,
  unit,
}) {
  if (
    manifest?.schema !== 'mnemosyne.source-unit-coverage-manifest.v1'
    || manifest.status !== 'complete'
    || manifest.snapshot_id !== context.active.snapshot_id
    || manifest.snapshot_hash !== context.active.snapshot_hash
    || manifest.source_id !== unit.source_id
    || manifest.source_kind !== unit.source_kind
    || manifest.source_unit_ref !== unit.ref
    || !Array.isArray(manifest.required_evidence_spans)
    || manifest.required_evidence_spans.length === 0
  ) {
    return null;
  }
  const payload = {
    schema: manifest.schema,
    status: 'complete',
    chat_id: chatId,
    snapshot_id: manifest.snapshot_id,
    snapshot_hash: manifest.snapshot_hash,
    source_id: manifest.source_id,
    source_kind: manifest.source_kind,
    source_unit_ref: manifest.source_unit_ref,
    required_evidence_spans: structuredClone(
      manifest.required_evidence_spans,
    ),
  };
  return {
    ...payload,
    manifest_hash: sha256(canonicalJson(payload)),
  };
}

function certificateMatchesRegistration(certificate, {
  chatId,
  context,
  unit,
  readScope,
}) {
  const source = context.snapshot.sources.find(
    candidate => candidate.source_id === unit.source_id,
  );
  return (
    certificate?.schema === 'mnemosyne.source-coverage-certificate.v3'
    && certificate.status === 'ready'
    && certificate.chat_id === chatId
    && certificate.snapshot_id === context.active.snapshot_id
    && certificate.snapshot_hash === context.active.snapshot_hash
    && certificate.source_unit?.source_id === unit.source_id
    && certificate.source_unit?.source_kind === unit.source_kind
    && certificate.source_unit?.source_unit_ref === unit.ref
    && certificate.source_unit?.source_hash
      === sha256(canonicalJson(source?.data))
    && canonicalJson(certificate.read_scope) === canonicalJson(readScope)
    && certificate.reader_capability_version === READER_CAPABILITY_VERSION
    && HASH_PATTERN.test(certificate.projection_hash ?? '')
    && HASH_PATTERN.test(certificate.runtime_view_hash ?? '')
  );
}

function entryMatchesLookup(entry, {
  chatId,
  context,
  sourceUnitRef,
  readScope,
}) {
  const certificate = entry?.certificate;
  return (
    entry?.schema === ENTRY_SCHEMA
    && hasValidEntryHash(entry)
    && entry.chat_id === chatId
    && entry.snapshot_id === context.active.snapshot_id
    && entry.snapshot_hash === context.active.snapshot_hash
    && entry.source_unit_ref === sourceUnitRef
    && entry.certificate_id === certificate?.certificate_id
    && entry.reader_capability_version
      === certificate?.reader_capability_version
    && entry.projection_id === certificate?.projection_id
    && entry.projection_hash === certificate?.projection_hash
    && entry.runtime_view_hash === certificate?.runtime_view_hash
    && canonicalJson(entry.read_scope) === canonicalJson(readScope)
    && canonicalJson(certificate?.read_scope) === canonicalJson(readScope)
    && certificate?.source_unit?.source_unit_ref === sourceUnitRef
  );
}

export function createSourceCoverageRegistry({
  store,
  coverageGate,
  sourceUnitManifestProvider = null,
  now = () => new Date(),
} = {}) {
  if (
    !store?.openChatForAdmin
    || !store?.getActiveStaticLoreSnapshotForAdmin
    || !store?.readStaticLoreSnapshotForAdmin
  ) {
    throw new Error(
      'Source Coverage Registry requires a trusted chat-save store.',
    );
  }
  if (
    typeof coverageGate?.createCertificate !== 'function'
    || typeof coverageGate?.verifyCertificate !== 'function'
  ) {
    throw new Error('Source Coverage Registry requires a trusted Coverage Gate.');
  }

  async function loadTrustedManifest({
    chatId,
    context,
    unit,
    schema,
  }) {
    if (typeof sourceUnitManifestProvider !== 'function') {
      return notReady(
        schema,
        'source_coverage_manifest_provider_missing',
      );
    }
    let suppliedManifest;
    try {
      suppliedManifest = await sourceUnitManifestProvider(Object.freeze({
        schema: 'mnemosyne.source-unit-manifest-request.v1',
        chat_id: chatId,
        snapshot_id: context.active.snapshot_id,
        snapshot_hash: context.active.snapshot_hash,
        source_unit: structuredClone(unit),
      }));
    } catch (error) {
      return notReady(
        schema,
        'source_coverage_manifest_unavailable',
        { cause: error?.reasonCode ?? error?.message ?? 'manifest_failed' },
      );
    }
    const manifest = normalizeTrustedManifest(suppliedManifest, {
      chatId,
      context,
      unit,
    });
    if (!manifest) {
      return notReady(
        schema,
        'source_coverage_manifest_incomplete',
        {
          cause:
            suppliedManifest?.reason_code
            ?? 'manifest_incomplete',
        },
      );
    }
    return {
      status: 'ready',
      manifest,
    };
  }

  async function registerSourceUnit({
    chatId,
    sourceUnitRef,
    readScope,
  } = {}) {
    const context = await activeContext(store, chatId);
    if (context.status !== 'ready') {
      return {
        ...context,
        schema: REGISTRATION_SCHEMA,
      };
    }
    let normalizedReadScope;
    try {
      normalizedReadScope = normalizeReadScope(readScope);
    } catch (error) {
      return notReady(
        REGISTRATION_SCHEMA,
        error.reasonCode ?? 'source_coverage_read_scope_invalid',
      );
    }
    const unit = context.units.find(candidate => candidate.ref === sourceUnitRef);
    if (!unit) {
      return notReady(
        REGISTRATION_SCHEMA,
        'source_coverage_source_unit_missing',
      );
    }
    const loaded = await loadTrustedManifest({
      chatId,
      context,
      unit,
      schema: REGISTRATION_SCHEMA,
    });
    if (loaded.status !== 'ready') return loaded;
    const { manifest } = loaded;

    let certificate;
    try {
      certificate = await coverageGate.createCertificate({
        chatId,
        sourceUnit: {
          source_id: unit.source_id,
          source_unit_ref: unit.ref,
          required_evidence_spans: structuredClone(
            manifest.required_evidence_spans,
          ),
        },
        readScope: structuredClone(normalizedReadScope),
      });
    } catch (error) {
      return notReady(
        REGISTRATION_SCHEMA,
        error?.reasonCode ?? 'source_coverage_certificate_failed',
      );
    }
    if (!certificateMatchesRegistration(certificate, {
      chatId,
      context,
      unit,
      readScope: normalizedReadScope,
    })) {
      return notReady(
        REGISTRATION_SCHEMA,
        'source_coverage_certificate_binding_invalid',
      );
    }
    const verification = await coverageGate.verifyCertificate(certificate);
    if (
      verification?.status !== 'verified'
      || verification.certificate_id !== certificate.certificate_id
    ) {
      return notReady(
        REGISTRATION_SCHEMA,
        verification?.reason_code ?? 'source_coverage_certificate_unverified',
      );
    }

    const payload = {
      schema: ENTRY_SCHEMA,
      chat_id: chatId,
      snapshot_id: context.active.snapshot_id,
      snapshot_hash: context.active.snapshot_hash,
      source_id: unit.source_id,
      source_kind: unit.source_kind,
      source_unit_ref: unit.ref,
      manifest_hash: manifest.manifest_hash,
      read_scope: structuredClone(normalizedReadScope),
      reader_capability_version: certificate.reader_capability_version,
      projection_id: certificate.projection_id,
      projection_hash: certificate.projection_hash,
      runtime_view_hash: certificate.runtime_view_hash,
      certificate_id: certificate.certificate_id,
      coverage_ready: certificate.coverage_ready === true,
      certificate: structuredClone(certificate),
      registered_at: now().toISOString(),
    };
    const entry = entryWithHash(payload);
    await writeJsonAtomic(
      registryEntryPath(
        context.opened.chat_save_path,
        context.active.snapshot_id,
        unit.ref,
        normalizedReadScope,
      ),
      entry,
    );
    return {
      schema: REGISTRATION_SCHEMA,
      status: 'registered',
      coverage_ready: entry.coverage_ready,
      snapshot_id: entry.snapshot_id,
      source_unit_ref: entry.source_unit_ref,
      manifest_hash: entry.manifest_hash,
      certificate_id: entry.certificate_id,
    };
  }

  async function lookupSourceUnit({
    chatId,
    snapshotId,
    sourceUnitRef,
    readScope,
  } = {}) {
    const context = await activeContext(store, chatId);
    if (context.status !== 'ready') return context;
    let normalizedReadScope;
    try {
      normalizedReadScope = normalizeReadScope(readScope);
    } catch (error) {
      return notReady(
        LOOKUP_SCHEMA,
        error.reasonCode ?? 'source_coverage_read_scope_invalid',
      );
    }
    if (snapshotId !== context.active.snapshot_id) {
      return notReady(
        LOOKUP_SCHEMA,
        'source_coverage_snapshot_stale',
      );
    }
    let entry;
    try {
      entry = await readJsonIfPresent(registryEntryPath(
        context.opened.chat_save_path,
        snapshotId,
        sourceUnitRef,
        normalizedReadScope,
      ));
    } catch {
      return notReady(
        LOOKUP_SCHEMA,
        'source_coverage_registry_entry_invalid',
      );
    }
    if (!entry) {
      return notReady(
        LOOKUP_SCHEMA,
        'source_coverage_registry_entry_missing',
      );
    }
    if (!entryMatchesLookup(entry, {
      chatId,
      context,
      sourceUnitRef,
      readScope: normalizedReadScope,
    })) {
      return notReady(
        LOOKUP_SCHEMA,
        'source_coverage_registry_entry_invalid',
      );
    }
    const unit = context.units.find(
      candidate => candidate.ref === sourceUnitRef,
    );
    if (!unit) {
      return notReady(
        LOOKUP_SCHEMA,
        'source_coverage_source_unit_missing',
      );
    }
    const loaded = await loadTrustedManifest({
      chatId,
      context,
      unit,
      schema: LOOKUP_SCHEMA,
    });
    if (loaded.status !== 'ready') return loaded;
    if (loaded.manifest.manifest_hash !== entry.manifest_hash) {
      return notReady(
        LOOKUP_SCHEMA,
        'source_coverage_manifest_stale',
      );
    }
    const verification = await coverageGate.verifyCertificate(
      structuredClone(entry.certificate),
    );
    if (
      verification?.status !== 'verified'
      || verification.certificate_id !== entry.certificate_id
    ) {
      return notReady(
        LOOKUP_SCHEMA,
        verification?.reason_code ?? 'source_coverage_certificate_unverified',
      );
    }
    return {
      schema: LOOKUP_SCHEMA,
      status: 'ready',
      coverage_ready: entry.coverage_ready === true,
      reason_code: null,
      snapshot_id: entry.snapshot_id,
      source_unit_ref: entry.source_unit_ref,
      read_scope: structuredClone(entry.read_scope),
      manifest_hash: entry.manifest_hash,
      certificate_id: entry.certificate_id,
      certificate: structuredClone(entry.certificate),
    };
  }

  async function registerActiveSnapshot({
    chatId,
    readScope,
  } = {}) {
    const context = await activeContext(store, chatId);
    if (context.status !== 'ready') {
      return {
        ...context,
        schema: SNAPSHOT_REGISTRATION_SCHEMA,
      };
    }
    const results = [];
    for (const unit of context.units) {
      const existing = await lookupSourceUnit({
        chatId,
        snapshotId: context.active.snapshot_id,
        sourceUnitRef: unit.ref,
        readScope,
      });
      if (
        existing.status === 'ready'
        && existing.coverage_ready === true
      ) {
        results.push({
          source_unit_ref: unit.ref,
          status: 'ready',
          coverage_ready: true,
          reason_code: null,
        });
        continue;
      }
      const registered = await registerSourceUnit({
        chatId,
        sourceUnitRef: unit.ref,
        readScope,
      });
      results.push({
        source_unit_ref: unit.ref,
        status: registered.status,
        coverage_ready: registered.coverage_ready === true,
        reason_code: registered.reason_code ?? null,
        ...(registered.details === undefined
          ? {}
          : { details: structuredClone(registered.details) }),
      });
    }
    const readyCount = results.filter(
      result => result.coverage_ready,
    ).length;
    return {
      schema: SNAPSHOT_REGISTRATION_SCHEMA,
      status: readyCount === results.length ? 'ready' : 'not_ready',
      coverage_ready: readyCount === results.length,
      snapshot_id: context.active.snapshot_id,
      snapshot_hash: context.active.snapshot_hash,
      source_unit_count: results.length,
      ready_source_unit_count: readyCount,
      blocked_source_unit_count: results.length - readyCount,
      results,
    };
  }

  async function trustedCoverageVerifier(request) {
    try {
      if (
        !hasExactKeys(request, REQUEST_KEYS)
        || request.schema !== REQUEST_SCHEMA
        || !Array.isArray(request.sources)
      ) {
        return coverageDecision(request, {
          approved: false,
          reasonCode: 'source_coverage_request_invalid',
        });
      }
      const runScope = normalizeRunScope(request.run_scope);
      const readScope = readScopeFor(runScope);
      const context = await activeContext(store, runScope.chat_id);
      if (context.status !== 'ready') {
        return coverageDecision(request, {
          approved: false,
          reasonCode: context.reason_code,
        });
      }
      if (
        request.snapshot_id !== context.active.snapshot_id
        || request.source_snapshot_hash !== context.active.snapshot_hash
        || request.source_set_hash !== context.active.snapshot_hash
        || staticLoreSnapshotHash(request.sources)
          !== context.active.snapshot_hash
      ) {
        return coverageDecision(request, {
          approved: false,
          reasonCode: 'source_coverage_snapshot_stale',
        });
      }
      const resolved = resolvePromptFingerprintSourceUnits({
        promptFingerprints: request.prompt_fingerprints,
        snapshot: context.snapshot,
        units: context.units,
      });
      if (
        request.prompt_fingerprints_hash
          !== sha256(canonicalJson(resolved.fingerprints))
      ) {
        return coverageDecision(request, {
          approved: false,
          reasonCode: 'source_coverage_prompt_manifest_invalid',
        });
      }
      if (
        !Array.isArray(request.source_unit_refs)
        || request.source_unit_refs.some(ref => typeof ref !== 'string')
        || new Set(request.source_unit_refs).size
          !== request.source_unit_refs.length
        || canonicalJson(request.source_unit_refs)
          !== canonicalJson([...request.source_unit_refs].sort())
        || request.source_unit_refs_hash
          !== sha256(canonicalJson(request.source_unit_refs))
        || canonicalJson(request.source_unit_refs)
          !== canonicalJson(resolved.source_unit_refs)
      ) {
        return coverageDecision(request, {
          approved: false,
          reasonCode: 'source_coverage_source_units_mismatch',
          sourceUnitRefs: resolved.source_unit_refs,
        });
      }

      const certificateIds = [];
      const unitLookups = [];
      for (const sourceUnitRef of resolved.source_unit_refs) {
        let lookup = await lookupSourceUnit({
          chatId: runScope.chat_id,
          snapshotId: context.active.snapshot_id,
          sourceUnitRef,
          readScope,
        });
        if (lookup.status !== 'ready' || lookup.coverage_ready !== true) {
          const registration = await registerSourceUnit({
            chatId: runScope.chat_id,
            sourceUnitRef,
            readScope,
          });
          if (
            registration.status !== 'registered'
            || registration.coverage_ready !== true
          ) {
            return coverageDecision(request, {
              approved: false,
              reasonCode:
                registration.reason_code
                ?? lookup.reason_code
                ?? 'source_coverage_source_unit_manifest_partial',
              sourceUnitRefs: resolved.source_unit_refs,
            });
          }
          lookup = await lookupSourceUnit({
            chatId: runScope.chat_id,
            snapshotId: context.active.snapshot_id,
            sourceUnitRef,
            readScope,
          });
        }
        if (
          lookup.status !== 'ready'
          || lookup.coverage_ready !== true
          || !/^coverage_[a-f0-9]{24}$/.test(
            lookup.certificate_id ?? '',
          )
        ) {
          return coverageDecision(request, {
            approved: false,
            reasonCode:
              lookup.reason_code
              ?? 'source_coverage_certificate_binding_invalid',
            sourceUnitRefs: resolved.source_unit_refs,
          });
        }
        certificateIds.push(lookup.certificate_id);
        unitLookups.push({
          source_unit_ref: sourceUnitRef,
          lookup,
        });
      }
      const admissionEvidence = admissionEvidenceForLookups(
        unitLookups,
      );
      const bindingPayload = {
        schema: BINDING_SCHEMA,
        coverage_policy: 'strict',
        run_scope: runScope,
        read_scope: readScope,
        snapshot_id: context.active.snapshot_id,
        source_snapshot_hash: context.active.snapshot_hash,
        source_set_hash: request.source_set_hash,
        prompt_fingerprints_hash: request.prompt_fingerprints_hash,
        fingerprint_units: resolved.fingerprint_units,
        source_unit_refs: resolved.source_unit_refs,
        certificate_ids: certificateIds,
        accepted_targets_hash:
          admissionEvidence.accepted_targets_hash,
        okf_versions: admissionEvidence.okf_versions,
        projection_id: admissionEvidence.projection_id,
        projection_hash: admissionEvidence.projection_hash,
        runtime_view_hash: admissionEvidence.runtime_view_hash,
        source_unit_evidence:
          admissionEvidence.source_unit_evidence,
        reader_capability_version: READER_CAPABILITY_VERSION,
      };
      return coverageDecision(request, {
        approved: true,
        sourceUnitRefs: resolved.source_unit_refs,
        certificateIds,
        coverageBinding: bindingPayload,
      });
    } catch (error) {
      return coverageDecision(request, {
        approved: false,
        reasonCode:
          error instanceof MnemosyneRequestError
            ? error.reasonCode
            : 'source_coverage_registry_verification_failed',
      });
    }
  }

  return Object.freeze({
    registerSourceUnit,
    registerActiveSnapshot,
    lookupSourceUnit,
    trustedCoverageVerifier,
  });
}
