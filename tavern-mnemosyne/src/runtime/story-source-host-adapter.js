import {
  canonicalJson,
  hashMessage,
  hashNormalizedMessage,
  hashPromptSpine,
  sha256,
} from '../contracts/hash.js';
import {
  sourceLabelForPromptIdentifier,
} from '../contracts/author-source-route.js';
import { MnemosyneRequestError } from '../contracts/errors.js';
import { censusMark } from '../inspection/gate-census.js';

const INPUT_SCHEMA =
  'mnemosyne.story-source-admission-input.v1';
const INPUT_SEAL = Symbol(
  'mnemosyne.story-source-host-adapter.input',
);
const sealedInputs = new WeakSet();
const COMPONENT_SCHEMA =
  'mnemosyne.host-component-provenance.v1';
const SOURCE_REMOVAL_GRANT_SCHEMA =
  'mnemosyne.source-removal-grant.v3';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CERTIFICATE_ID_PATTERN = /^coverage_[a-f0-9]{24}$/;
const WORLD_INFO_DEPTH_IDENTIFIER = /^customDepthWI_(\d+)_([012])$/;
const COMPONENT_KEYS = Object.freeze([
  'component_hash',
  'identifier',
  'provenance_kind',
  'schema',
  'source_selectors',
]);
const STATIC_SELECTOR_KEYS = Object.freeze([
  'include_parts',
  'source_id',
  'source_kind',
  'unit_id',
]);
const WORLD_INFO_SELECTOR_KEYS = Object.freeze([
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
const PROMPT_SPINE_KEYS = Object.freeze([
  'hash',
  'message_count',
  'run_id',
  'schema',
]);
const PROMPT_FIDELITY_REPORT_KEYS = Object.freeze([
  'prompt_exclusion_witnesses',
  'provider_message_fingerprints',
  'recent_continuity_strip',
  'removed',
  'retained_message_count',
  'run_id',
  'schema',
  'source_decisions',
  'source_removal_grants',
  'verified_message_count',
]);
const PROVIDER_MESSAGE_FINGERPRINT_KEYS = Object.freeze([
  'content_hash',
  'message_hash',
  'name',
  'provider_index',
  'role',
]);
const SOURCE_REMOVAL_GRANT_KEYS = Object.freeze([
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
const SOURCE_REMOVAL_RUN_SCOPE_KEYS = Object.freeze([
  'branch_epoch',
  'branch_id',
  'chat_id',
  'run_id',
  'turn_index',
]);
const SOURCE_COVERAGE_WRAPPER_KEYS = Object.freeze([
  'binding',
  'binding_hash',
]);
const SOURCE_COVERAGE_BINDING_KEYS = Object.freeze([
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
const SOURCE_COVERAGE_FINGERPRINT_UNIT_KEYS = Object.freeze([
  'component_hash',
  'identifier',
  'source_unit_refs',
]);
const SOURCE_COVERAGE_OKF_VERSION_KEYS = Object.freeze([
  'entity_ref',
  'version_hash',
]);
const SOURCE_COVERAGE_UNIT_EVIDENCE_KEYS = Object.freeze([
  'certificate_id',
  'manifest_hash',
  'source_unit_ref',
]);
const SOURCE_COVERAGE_READ_SCOPE_KEYS = Object.freeze([
  'branch_epoch',
  'branch_id',
  'turn_index',
]);
const FIXED_SELECTORS = Object.freeze({
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

function fail(reasonCode, message, details = undefined) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function hasExactKeys(value, keys) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\u0000')
      === [...keys].sort().join('\u0000')
  );
}

function deepFreeze(value, seen = new WeakSet()) {
  if (
    !value
    || typeof value !== 'object'
    || seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function componentPayload(component) {
  return {
    schema: component.schema,
    identifier: component.identifier,
    provenance_kind: component.provenance_kind,
    source_selectors: component.source_selectors,
  };
}

function sortedUniqueStrings(value) {
  return (
    Array.isArray(value)
    && value.length > 0
    && value.every(item => typeof item === 'string' && item)
    && new Set(value).size === value.length
    && canonicalJson(value) === canonicalJson([...value].sort())
  );
}

function sourceRemovalGrantIdentity(grant) {
  return {
    schema: SOURCE_REMOVAL_GRANT_SCHEMA,
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

function validateSourceRemovalGrant(
  grant,
  {
    entry,
    component,
    runScope,
  },
) {
  const expectedRunScope = {
    chat_id: runScope.chat_id,
    run_id: runScope.run_id,
    branch_id: runScope.branch_id,
    branch_epoch: runScope.branch_epoch,
    turn_index: runScope.turn_index,
  };
  if (
    !hasExactKeys(grant, SOURCE_REMOVAL_GRANT_KEYS)
    || grant.schema !== SOURCE_REMOVAL_GRANT_SCHEMA
    || !hasExactKeys(
      grant.run_scope,
      SOURCE_REMOVAL_RUN_SCOPE_KEYS,
    )
    || canonicalJson(grant.run_scope)
      !== canonicalJson(expectedRunScope)
    || typeof grant.snapshot_id !== 'string'
    || grant.snapshot_id.length === 0
    || !HASH_PATTERN.test(grant.source_snapshot_hash ?? '')
    || grant.identifier !== entry.identifier
    || grant.source_label !== entry.source_label
    || grant.prompt_message_hash !== entry.prompt_message_hash
    || !HASH_PATTERN.test(grant.prompt_message_hash ?? '')
    || grant.component_hash !== component.component_hash
    || !HASH_PATTERN.test(grant.component_hash ?? '')
    || !sortedUniqueStrings(grant.source_unit_refs)
    || !Array.isArray(grant.certificate_ids)
    || grant.certificate_ids.length
      !== grant.source_unit_refs.length
    || grant.certificate_ids.some(id => (
      !CERTIFICATE_ID_PATTERN.test(id)
    ))
    || new Set(grant.certificate_ids).size
      !== grant.certificate_ids.length
    || grant.coverage_policy !== 'strict'
    || grant.reader_capability_version
      !== 'mnemosyne.memory-reader.v2'
    || !HASH_PATTERN.test(grant.coverage_binding_hash ?? '')
    || typeof grant.issued_at !== 'string'
    || grant.issued_at.length === 0
    || grant.grant_id
      !== `grant_${sha256(canonicalJson(
        sourceRemovalGrantIdentity(grant),
      )).slice(0, 24)}`
  ) {
    fail(
      'story_source_removal_grant_invalid',
      'Host source removal is not bound to one exact v3 grant.',
      { identifier: entry.identifier ?? null },
    );
  }
  return grant.grant_id;
}

function validCoverageOkfVersions(value) {
  return (
    Array.isArray(value)
    && value.length > 0
    && value.every(item => (
      hasExactKeys(item, SOURCE_COVERAGE_OKF_VERSION_KEYS)
      && typeof item.entity_ref === 'string'
      && item.entity_ref.startsWith('okf://entity/')
      && HASH_PATTERN.test(item.version_hash ?? '')
    ))
    && new Set(value.map(canonicalJson)).size === value.length
    && canonicalJson(value) === canonicalJson(
      [...value].sort((left, right) => (
        canonicalJson(left).localeCompare(canonicalJson(right))
      )),
    )
  );
}

function validateSourceCoverage(trace, rawEntries, runScope) {
  const sourceCoverage = trace.source_coverage;
  const binding = sourceCoverage?.binding;
  const bindingHash = sourceCoverage?.binding_hash;
  const grants = rawEntries
    .map(entry => entry.removal_authorization)
    .sort((left, right) => (
      left.identifier.localeCompare(right.identifier)
    ));
  const providerFingerprints = rawEntries.map(entry => ({
    identifier: entry.identifier,
    prompt_message_hash: entry.prompt_message_hash,
    component_hash:
      entry.component_provenance.component_hash,
  })).sort((left, right) => (
    left.identifier.localeCompare(right.identifier)
  ));
  const expectedRunScope = {
    chat_id: runScope.chat_id,
    run_id: runScope.run_id,
    branch_id: runScope.branch_id,
    branch_epoch: runScope.branch_epoch,
    turn_index: runScope.turn_index,
  };
  const expectedReadScope = {
    branch_id: runScope.branch_id,
    branch_epoch: runScope.branch_epoch,
    turn_index: runScope.turn_index,
  };
  const sourceUnitRefs = binding?.source_unit_refs;
  const certificateIds = binding?.certificate_ids;
  if (grants.length === 0) {
    if (sourceCoverage !== null) {
      fail(
        'story_source_coverage_invalid',
        'Host source coverage cannot exist without raw source grants.',
      );
    }
    return null;
  }
  if (
    !hasExactKeys(
      sourceCoverage,
      SOURCE_COVERAGE_WRAPPER_KEYS,
    )
    || !hasExactKeys(
      binding,
      SOURCE_COVERAGE_BINDING_KEYS,
    )
    || binding.schema
      !== 'mnemosyne.source-removal-coverage-binding.v3'
    || binding.coverage_policy !== 'strict'
    || canonicalJson(binding.run_scope)
      !== canonicalJson(expectedRunScope)
    || !hasExactKeys(
      binding.read_scope,
      SOURCE_COVERAGE_READ_SCOPE_KEYS,
    )
    || canonicalJson(binding.read_scope)
      !== canonicalJson(expectedReadScope)
    || typeof binding.snapshot_id !== 'string'
    || !binding.snapshot_id
    || !HASH_PATTERN.test(binding.source_snapshot_hash ?? '')
    || !HASH_PATTERN.test(binding.source_set_hash ?? '')
    || !HASH_PATTERN.test(binding.prompt_fingerprints_hash ?? '')
    || !sortedUniqueStrings(sourceUnitRefs)
    || !Array.isArray(certificateIds)
    || certificateIds.length !== sourceUnitRefs.length
    || certificateIds.some(id => (
      !CERTIFICATE_ID_PATTERN.test(id)
    ))
    || new Set(certificateIds).size !== certificateIds.length
    || !HASH_PATTERN.test(binding.accepted_targets_hash ?? '')
    || !validCoverageOkfVersions(binding.okf_versions)
    || typeof binding.projection_id !== 'string'
    || !binding.projection_id
    || !HASH_PATTERN.test(binding.projection_hash ?? '')
    || !HASH_PATTERN.test(binding.runtime_view_hash ?? '')
    || binding.reader_capability_version
      !== 'mnemosyne.memory-reader.v2'
    || !HASH_PATTERN.test(bindingHash ?? '')
    || bindingHash !== sha256(canonicalJson(binding))
    || !Array.isArray(binding.fingerprint_units)
    || binding.fingerprint_units.length !== grants.length
    || !Array.isArray(binding.source_unit_evidence)
    || binding.source_unit_evidence.length !== sourceUnitRefs.length
  ) {
    fail(
      'story_source_coverage_invalid',
      'Host source coverage is not exact strict v3 evidence.',
    );
  }
  for (let index = 0; index < sourceUnitRefs.length; index += 1) {
    const evidence = binding.source_unit_evidence[index];
    if (
      !hasExactKeys(
        evidence,
        SOURCE_COVERAGE_UNIT_EVIDENCE_KEYS,
      )
      || evidence.source_unit_ref !== sourceUnitRefs[index]
      || evidence.certificate_id !== certificateIds[index]
      || !HASH_PATTERN.test(evidence.manifest_hash ?? '')
    ) {
      fail(
        'story_source_coverage_invalid',
        'Host source coverage units are not one-to-one.',
      );
    }
  }
  const coveredRefs = new Set();
  for (let index = 0; index < grants.length; index += 1) {
    const grant = grants[index];
    const fingerprint = binding.fingerprint_units[index];
    const expectedCertificates = grant.source_unit_refs.map(ref => (
      certificateIds[sourceUnitRefs.indexOf(ref)]
    ));
    if (
      !hasExactKeys(
        fingerprint,
        SOURCE_COVERAGE_FINGERPRINT_UNIT_KEYS,
      )
      || fingerprint.identifier !== grant.identifier
      || fingerprint.component_hash !== grant.component_hash
      || !sortedUniqueStrings(fingerprint.source_unit_refs)
      || canonicalJson(fingerprint.source_unit_refs)
        !== canonicalJson(grant.source_unit_refs)
      || canonicalJson(grant.certificate_ids)
        !== canonicalJson(expectedCertificates)
      || grant.coverage_binding_hash !== bindingHash
      || grant.snapshot_id !== binding.snapshot_id
      || grant.source_snapshot_hash
        !== binding.source_snapshot_hash
    ) {
      fail(
        'story_source_coverage_invalid',
        'Host source coverage does not bind every grant.',
      );
    }
    for (const ref of grant.source_unit_refs) {
      coveredRefs.add(ref);
    }
  }
  if (
    canonicalJson(binding.fingerprint_units)
      !== canonicalJson(
        [...binding.fingerprint_units].sort((left, right) => (
          left.identifier.localeCompare(right.identifier)
        )),
      )
    || canonicalJson([...coveredRefs].sort())
      !== canonicalJson(sourceUnitRefs)
  ) {
    fail(
      'story_source_coverage_invalid',
      'Host source coverage contains an incomplete grant union.',
    );
  }
  return {
    binding: structuredClone(binding),
    binding_hash: bindingHash,
    grants: structuredClone(grants),
    provider_fingerprints: providerFingerprints,
  };
}

function validateFixedComponent(component, identifier) {
  const expectedSelector = FIXED_SELECTORS[identifier];
  if (
    !expectedSelector
    || component.provenance_kind !== 'static_field'
    || component.source_selectors.length !== 1
    || !hasExactKeys(
      component.source_selectors[0],
      STATIC_SELECTOR_KEYS,
    )
    || canonicalJson(component.source_selectors[0])
      !== canonicalJson(expectedSelector)
  ) {
    fail(
      'story_source_host_component_invalid',
      'Fixed host component provenance does not match its source field.',
      { identifier },
    );
  }
}

function expectedWorldInfoRoute(selector) {
  if (selector?.position === 0) {
    return {
      identifier: 'worldInfoBefore',
      depth: null,
      role: null,
    };
  }
  if (selector?.position === 1) {
    return {
      identifier: 'worldInfoAfter',
      depth: null,
      role: null,
    };
  }
  if (
    selector?.position === 4
    && Number.isSafeInteger(selector.depth)
    && selector.depth >= 0
    && [0, 1, 2].includes(selector.role)
  ) {
    return {
      identifier:
        `customDepthWI_${selector.depth}_${selector.role}`,
      depth: selector.depth,
      role: selector.role,
    };
  }
  return null;
}

function validateWorldInfoComponent(component, identifier) {
  if (
    component.provenance_kind !== 'world_info_entries'
    || !(
      identifier === 'worldInfoBefore'
      || identifier === 'worldInfoAfter'
      || WORLD_INFO_DEPTH_IDENTIFIER.test(identifier)
    )
    || component.source_selectors.length === 0
  ) {
    fail(
      'story_source_host_component_invalid',
      'World Info component provenance has an invalid route.',
      { identifier },
    );
  }
  const identities = new Set();
  for (
    let index = 0;
    index < component.source_selectors.length;
    index += 1
  ) {
    const selector = component.source_selectors[index];
    const expectedRoute = expectedWorldInfoRoute(selector);
    const identity = canonicalJson([
      selector?.world,
      selector?.uid,
    ]);
    if (
      !hasExactKeys(selector, WORLD_INFO_SELECTOR_KEYS)
      || typeof selector.world !== 'string'
      || !selector.world.trim()
      || typeof selector.uid !== 'string'
      || !selector.uid
      || selector.source_id !== `worldbook:${selector.world}`
      || selector.source_kind !== 'worldbook'
      || selector.unit_id !== selector.uid
      || selector.include_parts !== true
      || selector.assembly_index !== index
      || !HASH_PATTERN.test(selector.raw_content_hash ?? '')
      || !HASH_PATTERN.test(selector.prepared_content_hash ?? '')
      || !expectedRoute
      || expectedRoute.identifier !== identifier
      || selector.route_identifier !== expectedRoute.identifier
      || selector.depth !== expectedRoute.depth
      || selector.role !== expectedRoute.role
    ) {
      fail(
        'story_source_host_component_invalid',
        'World Info selector does not match its exact host route.',
        { identifier, assembly_index: index },
      );
    }
    if (identities.has(identity)) {
      fail(
        'story_source_host_component_duplicate',
        'World Info component repeats a source selector.',
        { identifier },
      );
    }
    identities.add(identity);
  }
}

function validateComponentProvenance(component, identifier) {
  if (
    !hasExactKeys(component, COMPONENT_KEYS)
    || component.schema !== COMPONENT_SCHEMA
    || component.identifier !== identifier
    || !Array.isArray(component.source_selectors)
    || !HASH_PATTERN.test(component.component_hash ?? '')
  ) {
    fail(
      'story_source_host_component_invalid',
      'Host component provenance has an invalid shape.',
      { identifier },
    );
  }
  if (component.provenance_kind === 'static_field') {
    validateFixedComponent(component, identifier);
  } else {
    validateWorldInfoComponent(component, identifier);
  }
  if (
    sha256(canonicalJson(componentPayload(component)))
      !== component.component_hash
  ) {
    fail(
      'story_source_host_component_drift',
      'Host component provenance no longer matches its seal.',
      { identifier },
    );
  }
  return structuredClone(component);
}

function deriveRunScope(prepared, trace) {
  const scope = prepared.runScope;
  const targetTurnIndex = Number.isInteger(scope?.target_turn_index)
    ? scope.target_turn_index
    : scope?.visible_turn_index;
  if (
    typeof scope?.chat_id !== 'string'
    || !scope.chat_id
    || typeof trace?.run_id !== 'string'
    || !trace.run_id
    || !Number.isInteger(scope.branch_epoch)
    || scope.branch_epoch < 0
    || !Number.isInteger(targetTurnIndex)
    || targetTurnIndex < 0
  ) {
    fail(
      'story_source_host_adapter_input_invalid',
      'Prepared host scope cannot identify one story run.',
    );
  }
  const driftedFields = Object.entries(trace.chat_ref ?? {})
    .filter(([field, value]) => (
      value !== undefined
      && scope[field] !== value
    ))
    .map(([field]) => field);
  if (driftedFields.length > 0) {
    fail(
      'story_source_host_scope_drift',
      'Prepared run scope no longer matches the original host trace.',
      { fields: driftedFields },
    );
  }
  const turnIdentityHash = sha256(canonicalJson({
    chat_id: scope.chat_id,
    branch_id: 'main',
    branch_epoch: scope.branch_epoch,
    target_turn_index: targetTurnIndex,
  })).slice(0, 24);
  const candidateIdentityHash = sha256(canonicalJson({
    turn_identity_hash: turnIdentityHash,
    run_id: trace.run_id,
    active_candidate_id: scope.active_candidate_id ?? null,
  })).slice(0, 24);
  return {
    chat_id: scope.chat_id,
    run_id: trace.run_id,
    turn_id: `turn_${turnIdentityHash}`,
    candidate_id: `candidate_${candidateIdentityHash}`,
    turn_index: targetTurnIndex,
    memory_turn_index: Number.isInteger(scope.parent_turn_index)
      ? scope.parent_turn_index
      : Math.max(0, targetTurnIndex - 1),
    branch_id: 'main',
    branch_epoch: scope.branch_epoch,
    swipe_id: Number.isInteger(scope.active_swipe_id)
      ? scope.active_swipe_id
      : 0,
  };
}

function assertPreparedShape(requestBody, prepared, trace) {
  if (
    !requestBody
    || typeof requestBody !== 'object'
    || Array.isArray(requestBody)
    || !prepared
    || typeof prepared !== 'object'
    || Array.isArray(prepared)
    || !prepared.body
    || typeof prepared.body !== 'object'
    || Array.isArray(prepared.body)
    || !Array.isArray(prepared.body.messages)
    || !hasExactKeys(prepared.promptSpine, PROMPT_SPINE_KEYS)
    || prepared.promptSpine.schema !== 'mnemosyne.prompt-spine.v1'
    || prepared.promptSpine.run_id !== trace?.run_id
    || prepared.promptSpine.message_count
      !== prepared.body.messages.length
    || prepared.promptSpine.hash
      !== hashPromptSpine(prepared.body.messages)
    || !hasExactKeys(
      prepared.report,
      PROMPT_FIDELITY_REPORT_KEYS,
    )
    || prepared.report.schema
      !== 'mnemosyne.prompt-fidelity-report.v2'
    || prepared.report.run_id !== trace.run_id
    || prepared.report.verified_message_count
      !== requestBody.messages?.length
    || prepared.report.retained_message_count
      !== prepared.body.messages.length
    || !Array.isArray(prepared.report.source_decisions)
    || !Array.isArray(prepared.report.source_removal_grants)
    || !Array.isArray(prepared.report.removed)
    || !Array.isArray(
      prepared.report.provider_message_fingerprints,
    )
    || !Array.isArray(
      prepared.report.prompt_exclusion_witnesses,
    )
  ) {
    fail(
      'story_source_host_adapter_input_invalid',
      'Host adapter requires the exact verified prepare result.',
    );
  }
}

function traceRawEntries(trace) {
  if (!Array.isArray(trace?.prompt_manager?.entries)) {
    fail(
      'story_source_host_adapter_input_invalid',
      'Original prompt trace entries are unavailable.',
    );
  }
  return trace.prompt_manager.entries.filter(entry => (
    sourceLabelForPromptIdentifier(entry?.identifier) !== null
    && entry?.component_provenance !== null
    && entry?.component_provenance !== undefined
  ));
}

function rawIdentity(entry) {
  return canonicalJson({
    order: entry?.order,
    identifier: entry?.identifier,
    source_label: entry?.source_label,
    prompt_message_hash: entry?.prompt_message_hash,
  });
}

function matchRemovedEntry(entry, removedEntries) {
  return removedEntries.filter(removed => (
    removed?.identifier === entry.identifier
    && removed?.source_label === entry.source_label
    && removed?.content_hash === entry.prompt_message_hash
  ));
}

function assertTraceComponentMapping(entry, trace, component) {
  const providerEntry = trace.provider_messages?.[
    entry.provider_index
  ];
  const matchingSegments = (providerEntry?.segments ?? [])
    .filter(segment => (
      segment?.internal_order === entry.order
      && segment.identifier === entry.identifier
      && segment.source_label === entry.source_label
      && segment.prompt_message_hash
        === entry.prompt_message_hash
      && segment.start === entry.provider_content_start
      && segment.end === entry.provider_content_end
    ));
  if (
    matchingSegments.length !== 1
    || canonicalJson(
      matchingSegments[0].component_provenance,
    ) !== canonicalJson(component)
    || (
      providerEntry.identifier === entry.identifier
      && canonicalJson(providerEntry.component_provenance)
        !== canonicalJson(component)
    )
  ) {
    fail(
      'story_source_host_mapping_drift',
      'Provider trace no longer carries the exact host provenance.',
      {
        stage: 'trace_component_mapping',
        identifier: entry.identifier,
        provider_index: entry.provider_index,
      },
    );
  }
}

function assertMappedEntryContent(entry, requestBody) {
  const message = requestBody.messages?.[entry.provider_index];
  const content = message?.content;
  const start = entry.provider_content_start;
  const end = entry.provider_content_end;
  if (
    !Number.isInteger(entry.provider_index)
    || typeof content !== 'string'
    || !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || end <= start
    || end > content.length
    || hashNormalizedMessage({
      role: entry.role,
      name: entry.name ?? null,
      content: content.slice(start, end),
    }) !== entry.prompt_message_hash
  ) {
    fail(
      'story_source_host_mapping_drift',
      'Raw host source content no longer matches its exact provider coordinate.',
      {
        stage: 'mapped_source_content',
        identifier: entry.identifier,
        provider_index: entry.provider_index,
      },
    );
  }
}

function assertPreparedProviderMessages({
  requestBody,
  prepared,
  removedEntries,
}) {
  const removalsByProvider = new Map();
  for (const removed of removedEntries) {
    const spans = removalsByProvider.get(removed.index) ?? [];
    spans.push(removed);
    removalsByProvider.set(removed.index, spans);
  }
  const expectedMessages = [];
  for (
    let index = 0;
    index < requestBody.messages.length;
    index += 1
  ) {
    const message = structuredClone(requestBody.messages[index]);
    const spans = (removalsByProvider.get(index) ?? [])
      .sort((left, right) => right.start - left.start);
    let previousStart = Number.POSITIVE_INFINITY;
    for (const span of spans) {
      if (
        typeof message.content !== 'string'
        || span.end > previousStart
        || span.start < 0
        || span.end <= span.start
        || span.end > message.content.length
      ) {
        fail(
          'story_source_host_mapping_drift',
          'Prompt fidelity removal coordinates cannot reconstruct the prepared request.',
          {
            stage: 'removal_coordinates',
            provider_index: index,
          },
        );
      }
      previousStart = span.start;
      message.content = (
        message.content.slice(0, span.start)
        + message.content.slice(span.end)
      );
    }
    if (spans.length > 0 && String(message.content).trim() === '') {
      continue;
    }
    expectedMessages.push(message);
  }
  if (
    canonicalJson(expectedMessages)
      !== canonicalJson(prepared.body.messages)
  ) {
    fail(
      'story_source_host_mapping_drift',
      'Prepared provider messages do not preserve the exact retained source coordinates.',
      { stage: 'prepared_provider_messages' },
    );
  }
  const expectedFingerprints = expectedMessages.map(
    (message, providerIndex) => ({
      provider_index: providerIndex,
      role: message?.role ?? null,
      name: message?.name ?? null,
      content_hash: sha256(
        typeof message?.content === 'string'
          ? message.content
          : canonicalJson(message?.content ?? null),
      ),
      message_hash: hashMessage(message),
    }),
  );
  if (
    prepared.report.provider_message_fingerprints.some(
      fingerprint => !hasExactKeys(
        fingerprint,
        PROVIDER_MESSAGE_FINGERPRINT_KEYS,
      ),
    )
    || canonicalJson(prepared.report.provider_message_fingerprints)
      !== canonicalJson(expectedFingerprints)
  ) {
    fail(
      'story_source_host_mapping_drift',
      'Prompt fidelity provider fingerprints do not match the retained request.',
      { stage: 'provider_fingerprints' },
    );
  }
}

function sourceBindings({
  requestBody,
  trace,
  prepared,
  runScope,
}) {
  const rawEntries = traceRawEntries(trace);
  const identifiers = new Set();
  const identities = new Set();
  const decisions = prepared.report.source_decisions;
  const removedEntries = prepared.report.removed;
  const reportedGrants = prepared.report.source_removal_grants;
  const matchedDecisions = new Set();
  const matchedRemoved = new Set();
  const matchedReportedGrants = new Set();
  const worldInfoSelectors = new Set();
  const bindings = [];
  const removedRawEntries = [];

  for (const entry of rawEntries) {
    const expectedLabel = sourceLabelForPromptIdentifier(
      entry.identifier,
    );
    const identity = rawIdentity(entry);
    if (
      identifiers.has(entry.identifier)
      || identities.has(identity)
    ) {
      fail(
        'story_source_host_mapping_duplicate',
        'Raw host source trace entries must be unique.',
        { identifier: entry.identifier ?? null },
      );
    }
    identifiers.add(entry.identifier);
    identities.add(identity);
    if (
      entry.source_label !== expectedLabel
      || !HASH_PATTERN.test(entry.prompt_message_hash ?? '')
    ) {
      fail(
        'story_source_host_mapping_drift',
        'Raw host source trace identity changed after preparation.',
        {
          stage: 'raw_source_identity',
          identifier: entry.identifier ?? null,
          provider_index: entry.provider_index,
        },
      );
    }
    const component = validateComponentProvenance(
      entry.component_provenance,
      entry.identifier,
    );
    assertTraceComponentMapping(entry, trace, component);
    assertMappedEntryContent(entry, requestBody);

    const matchingDecisions = decisions
      .map((decision, index) => ({ decision, index }))
      .filter(({ decision }) => (
        rawIdentity(decision) === identity
      ));
    if (matchingDecisions.length !== 1) {
      fail(
        matchingDecisions.length > 1
          ? 'story_source_host_mapping_duplicate'
          : 'story_source_host_mapping_unmapped',
        'Prompt fidelity did not map one exact raw host source decision.',
        { identifier: entry.identifier },
      );
    }
    const { decision, index: decisionIndex } =
      matchingDecisions[0];
    if (matchedDecisions.has(decisionIndex)) {
      fail(
        'story_source_host_mapping_duplicate',
        'One prompt fidelity decision cannot cover two host sources.',
        { identifier: entry.identifier },
      );
    }
    matchedDecisions.add(decisionIndex);

    const removedMatches = matchRemovedEntry(
      entry,
      removedEntries,
    ).map(removed => ({
      removed,
      index: removedEntries.indexOf(removed),
    }));
    const grantId =
      entry.removal_authorization?.grant_id ?? null;
    if (decision.decision === 'retained') {
      if (
        entry.retention_policy !== 'retain'
        || entry.removal_authorization !== null
        || entry.removal_authorization_issue !== null
        || decision.requested_policy !== 'retain'
        || decision.grant_id !== null
        || decision.reason_code !== 'host_source_retained'
        || removedMatches.length !== 0
      ) {
        fail(
          'story_source_host_mapping_drift',
          'Retained host source evidence no longer matches its in-place policy.',
          {
            stage: 'retained_source_policy',
            identifier: entry.identifier,
            provider_index: entry.provider_index,
          },
        );
      }
    } else if (
      decision.decision !== 'removed'
      || decision.requested_policy
        !== 'remove_absorbed_author_source'
      || decision.grant_id !== grantId
      || typeof grantId !== 'string'
      || !grantId
      || decision.reason_code
        !== 'trusted_removal_grant_verified'
      || removedMatches.length !== 1
    ) {
      fail(
        'story_source_host_mapping_drift',
        'Removed host source evidence no longer matches its grant.',
        {
          stage: 'removed_source_grant',
          identifier: entry.identifier,
          provider_index: entry.provider_index,
        },
      );
    } else {
      validateSourceRemovalGrant(
        entry.removal_authorization,
        {
          entry,
          component,
          runScope,
        },
      );
      const matchingReportedGrants = reportedGrants
        .map((grant, index) => ({ grant, index }))
        .filter(({ grant }) => (
          grant?.grant_id === grantId
          && canonicalJson(grant)
            === canonicalJson(entry.removal_authorization)
        ));
      if (
        matchingReportedGrants.length !== 1
        || matchedReportedGrants.has(
          matchingReportedGrants[0]?.index,
        )
      ) {
        fail(
          'story_source_host_mapping_drift',
          'Prompt fidelity did not preserve one exact source removal grant.',
          {
            stage: 'reported_removal_grant',
            identifier: entry.identifier,
            provider_index: entry.provider_index,
          },
        );
      }
      matchedReportedGrants.add(
        matchingReportedGrants[0].index,
      );
      const { removed, index: removedIndex } = removedMatches[0];
      const providerEntry = trace.provider_messages?.[
        entry.provider_index
      ];
      const providerContent =
        requestBody.messages?.[entry.provider_index]?.content;
      const expectedScope = (
        entry.provider_content_start === 0
        && entry.provider_content_end
          === (
            typeof providerContent === 'string'
              ? providerContent.length
              : -1
          )
      )
        ? 'whole_message'
        : 'content_span';
      if (
        matchedRemoved.has(removedIndex)
        || removed.index !== entry.provider_index
        || removed.provider_content_hash
          !== providerEntry?.content_hash
        || removed.provider_content_utf16_length
          !== (
            typeof providerContent === 'string'
              ? providerContent.length
              : -1
          )
        || removed.start !== entry.provider_content_start
        || removed.end !== entry.provider_content_end
        || removed.scope !== expectedScope
      ) {
        fail(
          'story_source_host_mapping_drift',
          'Removed host source span no longer matches its trace.',
          {
            stage: 'removed_source_span',
            identifier: entry.identifier,
            provider_index: entry.provider_index,
          },
        );
      }
      matchedRemoved.add(removedIndex);
      removedRawEntries.push(entry);
      bindings.push({
        identifier: entry.identifier,
        source_label: entry.source_label,
        prompt_message_hash: entry.prompt_message_hash,
        grant_id: grantId,
        component_provenance: component,
      });
    }

    for (const selector of component.source_selectors) {
      if (component.provenance_kind !== 'world_info_entries') {
        continue;
      }
      const selectorIdentity = canonicalJson([
        selector.world,
        selector.uid,
      ]);
      if (worldInfoSelectors.has(selectorIdentity)) {
        fail(
          'story_source_host_component_duplicate',
          'Host provenance selects one World Info unit twice.',
          { identifier: entry.identifier },
        );
      }
      worldInfoSelectors.add(selectorIdentity);
    }
  }

  if (
    matchedDecisions.size !== decisions.length
    || matchedRemoved.size !== removedEntries.length
    || matchedReportedGrants.size !== reportedGrants.length
  ) {
    fail(
      'story_source_host_mapping_drift',
      'Prompt fidelity contains an extra raw source decision or removal.',
      { stage: 'source_decision_cardinality' },
    );
  }
  assertPreparedProviderMessages({
    requestBody,
    prepared,
    removedEntries,
  });
  const sourceCoverage = validateSourceCoverage(
    trace,
    removedRawEntries,
    runScope,
  );
  return {
    bindings,
    survivors: [],
    sourceCoverage,
  };
}

export function createStorySourceAdmissionInput({
  requestBody,
  prepared,
} = {}) {
  censusMark('STORY_SOURCE_HOST_ADAPTER', 'enter', {
    runId: requestBody?.mnemosyne_prompt_trace?.run_id ?? null,
  });
  const trace = requestBody?.mnemosyne_prompt_trace;
  assertPreparedShape(requestBody, prepared, trace);
  const runScope = deriveRunScope(prepared, trace);
  const {
    bindings,
    survivors,
    sourceCoverage,
  } = sourceBindings({
    requestBody,
    trace,
    prepared,
    runScope,
  });
  const preparedPrompt = {
    schema: 'mnemosyne.verified-prepared-prompt.v1',
    body: structuredClone(prepared.body),
    promptSpine: structuredClone(prepared.promptSpine),
    prompt_fidelity_report_hash:
      sha256(canonicalJson(prepared.report)),
  };
  const hostProvenance = {
    schema: 'mnemosyne.host-source-provenance.v1',
    source_bindings: bindings,
    source_coverage: sourceCoverage,
  };
  const payload = {
    schema: INPUT_SCHEMA,
    runScope,
    preparedPrompt,
    hostProvenance,
    rawSurvivors: survivors,
  };
  const input = {
    ...payload,
    input_hash: sha256(canonicalJson(payload)),
  };
  Object.defineProperty(input, INPUT_SEAL, {
    value: INPUT_SEAL,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  sealedInputs.add(input);
  censusMark('STORY_SOURCE_HOST_ADAPTER', 'passed', { runId: trace?.run_id ?? null });
  return deepFreeze(input);
}

export function assertStorySourceAdmissionInput(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value[INPUT_SEAL] !== INPUT_SEAL
    || !sealedInputs.has(value)
  ) {
    fail(
      'story_source_host_adapter_seal_invalid',
      'Story admission requires the original host adapter result from this process.',
    );
  }
  return value;
}
