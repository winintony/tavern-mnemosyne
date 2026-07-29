import {
  canonicalJson,
  hashMessage,
  hashNormalizedMessage,
  hashPromptSpine,
  sha256,
} from '../contracts/hash.js';
import {
  validateContinuityPayload,
} from '../contracts/continuity-payload.js';
import { MnemosyneRequestError } from '../contracts/errors.js';
import { censusMark } from '../inspection/gate-census.js';
import {
  buildRuntimeContract,
  RUNTIME_CONTRACT_SCHEMA,
} from '../contracts/runtime-contract.js';
import {
  sourceLabelForPromptIdentifier,
} from '../contracts/author-source-route.js';
import {
  normalizeProviderBudgetBinding,
} from '../proxy/provider-step-budget.js';
import {
  createRecentContinuityStripWitness,
} from './recent-continuity-strip.js';

const TRACE_KEY = 'mnemosyne_prompt_trace';
const TRACE_SCHEMA = 'mnemosyne.prompt-trace.v1';
const BLOCKED_TRACE_SCHEMA = 'mnemosyne.blocked.v1';
const SAFE_HOST_BLOCK_REASON = /^[a-z][a-z0-9_]{2,95}$/;
const RUNTIME_ID = 'tavern_mnemosyne_runtime_contract';
const PAYLOAD_ID = 'tavern_mnemosyne_continuity_payload';
const MAIN_ID = 'main';
const PROMPT_EXCLUSION_WITNESS_SCHEMA =
  'mnemosyne.prompt-exclusion-witness.v1';
const HOST_HISTORY_BINDING_SCHEMA =
  'mnemosyne.host-history-binding.v1';
const HOST_HISTORY_BINDING_KEYS = new Set([
  'schema',
  'chat_id_hash',
  'branch_id',
  'branch_epoch',
  'visible_turn_index',
  'parent_turn_index',
  'target_turn_index',
  'message_count',
  'messages_hash',
  'last_message_index',
  'last_message_role',
  'last_message_body_hash',
  'binding_hash',
]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CERTIFICATE_ID_PATTERN = /^coverage_[a-f0-9]{24}$/;
const SOURCE_REMOVAL_GRANT_SCHEMA =
  'mnemosyne.source-removal-grant.v3';
const SOURCE_REMOVAL_GRANT_KEYS = new Set([
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
const SOURCE_REMOVAL_RUN_SCOPE_KEYS = new Set([
  'branch_epoch',
  'branch_id',
  'chat_id',
  'run_id',
  'turn_index',
]);
const EMPTY_SYSTEM_PROMPT_HASH = hashNormalizedMessage({
  role: 'system',
  name: null,
  content: '',
});

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function normalizeAuditExcludedPhrases(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.length > 16
    || value.some(phrase => (
      typeof phrase !== 'string'
      || phrase !== phrase.trim()
      || phrase.length === 0
      || phrase.length > 256
      || /[\r\n]/.test(phrase)
    ))
    || new Set(value).size !== value.length
  ) {
    fail(
      'prompt_exclusion_phrases_invalid',
      'Audit exclusion phrases must be unique compact strings.',
    );
  }
  return value;
}

function normalizeHostHistoryBinding(value) {
  if (value === undefined || value === null) return null;
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== HOST_HISTORY_BINDING_KEYS.size
    || Object.keys(value).some(key => !HOST_HISTORY_BINDING_KEYS.has(key))
  ) {
    fail(
      'host_history_binding_invalid',
      'Host history binding must have the exact v1 shape.',
    );
  }
  const {
    binding_hash: bindingHash,
    ...payload
  } = value;
  const indices = [
    value.branch_epoch,
    value.visible_turn_index,
    value.parent_turn_index,
    value.target_turn_index,
    value.last_message_index,
  ];
  if (
    value.schema !== HOST_HISTORY_BINDING_SCHEMA
    || !HASH_PATTERN.test(value.chat_id_hash ?? '')
    || typeof value.branch_id !== 'string'
    || value.branch_id.length === 0
    || indices.some(index => !Number.isInteger(index) || index < 0)
    || value.parent_turn_index > value.visible_turn_index
    || value.target_turn_index < value.visible_turn_index
    || !Number.isInteger(value.message_count)
    || value.message_count <= 0
    || value.last_message_index !== value.message_count - 1
    || !HASH_PATTERN.test(value.messages_hash ?? '')
    || !['user', 'assistant', 'system'].includes(value.last_message_role)
    || !HASH_PATTERN.test(value.last_message_body_hash ?? '')
    || !HASH_PATTERN.test(bindingHash ?? '')
    || bindingHash !== sha256(canonicalJson(payload))
  ) {
    fail(
      'host_history_binding_invalid',
      'Host history binding fields or self-hash are invalid.',
    );
  }
  return structuredClone(value);
}

function assertHostHistoryBindingScope(binding, runScope) {
  if (!binding) return;
  const expected = {
    chat_id_hash: sha256(runScope.chat_id),
    branch_id: 'main',
    branch_epoch: runScope.branch_epoch,
    visible_turn_index: runScope.visible_turn_index,
    parent_turn_index: runScope.parent_turn_index,
    target_turn_index: runScope.target_turn_index,
  };
  const fields = Object.entries(expected)
    .filter(([field, value]) => binding[field] !== value)
    .map(([field]) => field)
    .sort();
  if (fields.length > 0) {
    fail(
      'host_history_binding_scope_mismatch',
      'Host history binding does not match the validated continuity scope.',
      { fields },
    );
  }
}

function inspectRecentContinuityStripAvailability({
  promptManagerEntries,
  retainedProviderIndices,
}) {
  const historyEntries = promptManagerEntries.filter(entry => (
      entry?.source_label === 'host_recent_chat'
    || /^chatHistory-\d+$/.test(String(entry?.identifier ?? ''))
  ));
  const orderedHistoryEntries = historyEntries.map(entry => ({
    entry,
    identifier: Number(
      String(entry?.identifier ?? '')
        .match(/^chatHistory-([1-9]\d*)$/)?.[1],
    ),
    mapped: Number.isInteger(entry?.provider_index),
  })).sort((left, right) => (
    left.identifier - right.identifier
  ));
  const firstMappedOffset = orderedHistoryEntries.findIndex(
    item => item.mapped,
  );
  const omittedPrefixEntries = firstMappedOffset > 0
    ? orderedHistoryEntries.slice(0, firstMappedOffset)
    : [];
  const missingProviderEntries = firstMappedOffset === -1
    ? orderedHistoryEntries.filter(item => !item.mapped)
    : orderedHistoryEntries
      .slice(firstMappedOffset)
      .filter(item => !item.mapped);
  const retained = new Set(retainedProviderIndices);
  const diagnostic = {
    schema:
      'mnemosyne.recent-continuity-strip-availability.v2',
    history_entry_count: historyEntries.length,
    mapped_history_entry_count:
      orderedHistoryEntries.filter(item => item.mapped).length,
    omitted_prefix_provider_mapping_count:
      omittedPrefixEntries.filter(item => !item.mapped).length,
    omitted_prefix_identifiers:
      omittedPrefixEntries.map(item => item.entry.identifier),
    invalid_identifier_count: historyEntries.filter(entry => (
      !/^chatHistory-[1-9]\d*$/.test(
        String(entry?.identifier ?? ''),
      )
    )).length,
    invalid_source_label_count: historyEntries.filter(entry => (
      entry.source_label !== 'host_recent_chat'
    )).length,
    invalid_retention_count: historyEntries.filter(entry => (
      entry.retention_policy !== 'retain'
    )).length,
    invalid_sequence_count:
      orderedHistoryEntries.filter((item, index) => (
        index > 0
        && item.identifier
          !== orderedHistoryEntries[index - 1].identifier + 1
      )).length,
    missing_provider_mapping_count:
      missingProviderEntries.length,
    missing_provider_mappings:
      missingProviderEntries.map(item => ({
        identifier: item.entry.identifier,
        role: item.entry.role ?? null,
        mapping_issue:
          item.entry.mapping_issue ?? null,
      })),
    removed_provider_mapping_count:
      historyEntries.filter(entry => (
        Number.isInteger(entry.provider_index)
        && !retained.has(entry.provider_index)
      )).length,
  };
  return Object.freeze({
    ...diagnostic,
    status: (
      diagnostic.history_entry_count > 0
      && diagnostic.mapped_history_entry_count > 0
      && Object.entries(diagnostic).every(([key, value]) => (
        !key.endsWith('_count')
        || [
          'history_entry_count',
          'mapped_history_entry_count',
          'omitted_prefix_provider_mapping_count',
        ].includes(key)
        || value === 0
      ))
    )
      ? 'available'
      : 'unavailable',
  });
}

function recentContinuityStripMappingDiagnostics(
  trace,
  availability,
) {
  if (availability.status !== 'unavailable') return null;
  return {
    schema:
      'mnemosyne.recent-continuity-strip-mapping-diagnostics.v1',
    history_entries: trace.prompt_manager.entries
      .filter(entry => (
        /^chatHistory-[1-9]\d*$/.test(
          String(entry?.identifier ?? ''),
        )
      ))
      .map(entry => ({
        identifier: entry.identifier,
        role: entry.role ?? null,
        provider_index: entry.provider_index ?? null,
        mapping_kind: entry.mapping_kind ?? null,
        mapping_issue: entry.mapping_issue ?? null,
      })),
    provider_entries: trace.provider_messages.map(entry => ({
      index: entry.index,
      role: entry.role ?? null,
      identifier: entry.identifier ?? null,
      source_label: entry.source_label ?? null,
      segment_count: Array.isArray(entry.segments)
        ? entry.segments.length
        : 0,
    })),
  };
}

function promptMessageContent(message) {
  return typeof message?.content === 'string'
    ? message.content
    : canonicalJson(message?.content ?? null);
}

function hasExactKeys(value, expectedKeys) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === expectedKeys.size
    && Object.keys(value).every(key => expectedKeys.has(key))
  );
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

function sourceRemovalRunScope(trace, runScope) {
  const expected = {
    chat_id: runScope?.chat_id,
    run_id: trace?.run_id,
    branch_id: 'main',
    branch_epoch: runScope?.branch_epoch,
    turn_index: runScope?.target_turn_index,
  };
  const traceRef = trace?.chat_ref;
  if (
    typeof expected.chat_id !== 'string'
    || !expected.chat_id
    || typeof expected.run_id !== 'string'
    || !expected.run_id
    || !Number.isInteger(expected.branch_epoch)
    || expected.branch_epoch < 0
    || !Number.isInteger(expected.turn_index)
    || expected.turn_index < 0
    || traceRef?.chat_id !== expected.chat_id
    || traceRef?.branch_epoch !== expected.branch_epoch
    || traceRef?.target_turn_index !== expected.turn_index
  ) {
    fail(
      'source_removal_run_scope_invalid',
      'Source removal requires one exact chat, run, branch, epoch, and target turn.',
    );
  }
  return expected;
}

function validSourceRemovalGrant(grant, {
  entry,
  expectedRunScope,
}) {
  return (
    hasExactKeys(grant, SOURCE_REMOVAL_GRANT_KEYS)
    && grant.schema === SOURCE_REMOVAL_GRANT_SCHEMA
    && hasExactKeys(
      grant.run_scope,
      SOURCE_REMOVAL_RUN_SCOPE_KEYS,
    )
    && canonicalJson(grant.run_scope)
      === canonicalJson(expectedRunScope)
    && typeof grant.snapshot_id === 'string'
    && grant.snapshot_id.length > 0
    && HASH_PATTERN.test(grant.source_snapshot_hash ?? '')
    && grant.identifier === entry.identifier
    && grant.source_label === entry.source_label
    && grant.prompt_message_hash === entry.prompt_message_hash
    && HASH_PATTERN.test(grant.prompt_message_hash ?? '')
    && HASH_PATTERN.test(grant.component_hash ?? '')
    && grant.component_hash
      === entry.component_provenance?.component_hash
    && sortedUniqueStrings(grant.source_unit_refs)
    && Array.isArray(grant.certificate_ids)
    && grant.certificate_ids.length
      === grant.source_unit_refs.length
    && grant.certificate_ids.every(id => (
      CERTIFICATE_ID_PATTERN.test(id)
    ))
    && new Set(grant.certificate_ids).size
      === grant.certificate_ids.length
    && grant.coverage_policy === 'strict'
    && grant.reader_capability_version
      === 'mnemosyne.memory-reader.v2'
    && HASH_PATTERN.test(grant.coverage_binding_hash ?? '')
    && typeof grant.issued_at === 'string'
    && grant.issued_at.length > 0
    && grant.grant_id
      === `grant_${sha256(canonicalJson(
        sourceRemovalGrantIdentity(grant),
      )).slice(0, 24)}`
  );
}

export function createPromptExclusionWitnesses({
  messages,
  providerMessageFingerprints,
  phrases,
}) {
  const normalizedPhrases = normalizeAuditExcludedPhrases(phrases);
  if (
    !Array.isArray(messages)
    || !Array.isArray(providerMessageFingerprints)
    || messages.length !== providerMessageFingerprints.length
  ) {
    fail(
      'prompt_exclusion_evidence_invalid',
      'Prompt exclusion evidence must bind the exact provider message set.',
    );
  }
  const providerMessageSetHash = sha256(
    canonicalJson(providerMessageFingerprints),
  );
  return normalizedPhrases.map(phrase => {
    const presentProviderIndices = messages
      .map((message, index) => (
        promptMessageContent(message).includes(phrase) ? index : null
      ))
      .filter(index => index !== null);
    const payload = {
      schema: PROMPT_EXCLUSION_WITNESS_SCHEMA,
      phrase_hash: sha256(phrase),
      phrase_codepoint_length: Array.from(phrase).length,
      provider_message_set_hash: providerMessageSetHash,
      status: presentProviderIndices.length === 0 ? 'absent' : 'present',
      present_provider_indices: presentProviderIndices,
    };
    return {
      ...payload,
      witness_hash: sha256(canonicalJson(payload)),
    };
  });
}

function assertTraceShape(trace) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    fail('prompt_trace_missing', 'Mnemosyne prompt trace is required.');
  }

  if (trace.schema === BLOCKED_TRACE_SCHEMA) {
    const hostReasonCode = trace.reason_code;
    fail(
      'prompt_trace_host_blocked',
      'The SillyTavern integration blocked prompt preparation before forwarding.',
      {
        host_reason_code:
          typeof hostReasonCode === 'string'
          && SAFE_HOST_BLOCK_REASON.test(hostReasonCode)
            ? hostReasonCode
            : 'host_block_reason_invalid',
      },
    );
  }

  if (trace.schema !== TRACE_SCHEMA) {
    fail('prompt_trace_schema_unsupported', `Expected ${TRACE_SCHEMA}.`, {
      received: trace.schema ?? null,
    });
  }

  if (!trace.run_id || typeof trace.run_id !== 'string') {
    fail('prompt_trace_run_id_missing', 'Prompt trace run_id is required.');
  }

  if (!Array.isArray(trace.provider_messages)) {
    fail('provider_trace_missing', 'Prompt trace provider_messages must be an array.');
  }

  if (!Array.isArray(trace.prompt_manager?.entries)) {
    fail('prompt_manager_trace_missing', 'Prompt trace prompt_manager.entries must be an array.');
  }

  if (!Array.isArray(trace.prompt_manager?.preset_identifiers)) {
    fail(
      'preset_identifier_trace_missing',
      'Prompt trace prompt_manager.preset_identifiers must be an array.',
    );
  }

  if (
    trace.unresolved_absorbed_sources !== undefined
    && !Array.isArray(trace.unresolved_absorbed_sources)
  ) {
    fail('prompt_trace_invalid', 'unresolved_absorbed_sources must be an array.');
  }
}

function expectedPromptSourceLabel(identifier, presetIdentifiers) {
  if (identifier === RUNTIME_ID) return 'mnemosyne_runtime_contract';
  if (identifier === PAYLOAD_ID) return 'mnemosyne_continuity_payload';
  const authorSource = sourceLabelForPromptIdentifier(identifier);
  if (authorSource) return authorSource;
  if (
    identifier === null
    || identifier === undefined
    || /^chatHistory-\d+$/.test(String(identifier))
  ) {
    return 'host_recent_chat';
  }
  return presetIdentifiers.has(identifier)
    ? 'host_preset'
    : 'host_prompt_unknown';
}

function assertPromptSourceLabels(promptManager) {
  const identifiers = promptManager.preset_identifiers;
  if (
    identifiers.some(identifier => (
      typeof identifier !== 'string'
      || identifier.length === 0
    ))
    || new Set(identifiers).size !== identifiers.length
  ) {
    fail(
      'preset_identifier_trace_invalid',
      'Preset prompt identifiers must be unique non-empty strings.',
    );
  }

  const presetIdentifiers = new Set(identifiers);
  for (const entry of promptManager.entries) {
    const expected = expectedPromptSourceLabel(
      entry?.identifier,
      presetIdentifiers,
    );
    if (entry?.source_label !== expected) {
      fail(
        'prompt_source_label_invalid',
        'Prompt source label does not match the active preset definition or reserved host route.',
        {
          identifier: entry?.identifier ?? null,
          expected_source_label: expected,
          received_source_label: entry?.source_label ?? null,
        },
      );
    }
  }
  return presetIdentifiers;
}

function assertPromptManagerNamedOrder(entries) {
  const identifiers = entries.map(entry => entry.identifier);
  const namedCounts = new Map(
    [RUNTIME_ID, MAIN_ID, PAYLOAD_ID].map(identifier => [
      identifier,
      identifiers.filter(value => value === identifier).length,
    ]),
  );
  if ([...namedCounts.values()].some(count => count !== 1)) {
    fail('named_prompt_block_count_invalid', 'Each named prompt block must occur exactly once.', {
      runtime_count: namedCounts.get(RUNTIME_ID),
      main_count: namedCounts.get(MAIN_ID),
      payload_count: namedCounts.get(PAYLOAD_ID),
    });
  }

  const runtimeIndex = identifiers.indexOf(RUNTIME_ID);
  const mainIndex = identifiers.indexOf(MAIN_ID);
  const payloadIndex = identifiers.indexOf(PAYLOAD_ID);

  if (runtimeIndex < 0 || mainIndex < 0 || payloadIndex < 0) {
    fail('named_prompt_block_missing', 'Runtime Contract, main, and Continuity Payload are required.', {
      runtime_present: runtimeIndex >= 0,
      main_present: mainIndex >= 0,
      payload_present: payloadIndex >= 0,
    });
  }

  if (!(runtimeIndex < mainIndex && mainIndex < payloadIndex)) {
    fail('named_prompt_order_invalid', 'Expected Runtime Contract before main and Continuity Payload after main.');
  }
}

function mappedCoordinate(entry) {
  if (!Number.isInteger(entry?.provider_index)) return null;
  return [
    entry.provider_index,
    Number.isInteger(entry.provider_content_start)
      ? entry.provider_content_start
      : 0,
  ];
}

function compareCoordinates(left, right) {
  if (!left || !right) return null;
  if (left[0] !== right[0]) return left[0] - right[0];
  return left[1] - right[1];
}

function assertProviderNamedOrder(entries, promptManagerEntries) {
  const internalRuntime = promptManagerEntries.find(
    entry => entry.identifier === RUNTIME_ID,
  );
  const internalMain = promptManagerEntries.find(
    entry => entry.identifier === MAIN_ID,
  );
  const internalPayload = promptManagerEntries.find(
    entry => entry.identifier === PAYLOAD_ID,
  );
  const runtimeCoordinate = mappedCoordinate(internalRuntime);
  const mainCoordinate = mappedCoordinate(internalMain);
  const payloadCoordinate = mappedCoordinate(internalPayload);

  if (
    !runtimeCoordinate
    || !payloadCoordinate
    || compareCoordinates(runtimeCoordinate, payloadCoordinate) >= 0
    || !entries[internalRuntime.provider_index]
    || !entries[internalPayload.provider_index]
  ) {
    fail(
      'provider_named_prompt_order_invalid',
      'Provider Runtime Contract and Continuity Payload do not match the PromptManager order.',
    );
  }

  if (mainCoordinate) {
    if (
      compareCoordinates(runtimeCoordinate, mainCoordinate) >= 0
      || compareCoordinates(mainCoordinate, payloadCoordinate) >= 0
      || !entries[internalMain.provider_index]
    ) {
      fail(
        'provider_named_prompt_order_invalid',
        'Provider main block is not between Runtime Contract and Continuity Payload.',
      );
    }
    return;
  }

  if (
    internalMain?.role !== 'system'
    || (internalMain?.name ?? null) !== null
    || internalMain?.content_hash !== EMPTY_SYSTEM_PROMPT_HASH
    || internalMain?.provider_index !== null
  ) {
    fail(
      'provider_main_omission_invalid',
      'Provider messages may omit main only when PromptManager proves it is an empty system anchor.',
    );
  }
}

async function assertProviderPresetEnvelope(
  messages,
  promptManagerEntries,
  presetIdentifiers,
) {
  const candidates = promptManagerEntries.filter(entry => (
    presetIdentifiers.has(entry?.identifier)
    && entry?.source_label === 'host_preset'
    && entry?.retention_policy === 'retain'
    && Number.isInteger(entry?.provider_index)
    && messages[entry.provider_index]
  ));
  if (candidates.length === 0) {
    fail(
      'preset_envelope_missing',
      'At least one retained host-preset segment must reach the provider request.',
    );
  }

  for (const entry of candidates) {
    const message = messages[entry.provider_index];
    const content = message?.content;
    if (typeof content !== 'string') continue;
    const hasStart = Number.isInteger(entry.provider_content_start);
    const hasEnd = Number.isInteger(entry.provider_content_end);
    if (hasStart !== hasEnd) continue;
    const start = hasStart ? entry.provider_content_start : 0;
    const end = hasEnd ? entry.provider_content_end : content.length;
    if (start < 0 || end < start || end > content.length) continue;
    const mappedHash = await hashNormalizedMessage({
      role: entry.role,
      name: entry.name ?? null,
      content: content.slice(start, end),
    });
    if (mappedHash === entry.prompt_message_hash) return;
  }

  fail(
    'preset_envelope_hash_mismatch',
    'No retained active-preset segment matches its mapped provider content.',
  );
}

function parseNamedBlock(message, {
  tag,
  expectedSchema,
  runId,
  reasonPrefix,
}) {
  if (typeof message?.content !== 'string') {
    fail(`${reasonPrefix}_invalid`, `${tag} must be one mapped text segment.`);
  }

  const pattern = new RegExp(
    `^<${tag} data-run-id="([^"]+)" schema="([^"]+)">\\n([\\s\\S]*)\\n<\\/${tag}>$`,
  );
  const match = message.content.match(pattern);
  if (!match) {
    fail(`${reasonPrefix}_invalid`, `${tag} wrapper is invalid.`);
  }
  if (match[1] !== runId || match[2] !== expectedSchema) {
    fail(`${reasonPrefix}_identity_mismatch`, `${tag} identity does not match the run.`, {
      expected_run_id: runId,
      received_run_id: match[1],
      expected_schema: expectedSchema,
      received_schema: match[2],
    });
  }

  return match[3];
}

function mappedEntryMessage(messages, entry, reasonPrefix) {
  if (!Number.isInteger(entry?.provider_index)) {
    fail(
      `${reasonPrefix}_mapping_missing`,
      'A named Mnemosyne block is not mapped onto the provider request.',
    );
  }
  const message = messages[entry.provider_index];
  const start = Number.isInteger(entry.provider_content_start)
    ? entry.provider_content_start
    : 0;
  const end = Number.isInteger(entry.provider_content_end)
    ? entry.provider_content_end
    : message?.content?.length;
  if (
    typeof message?.content !== 'string'
    || !Number.isInteger(end)
    || start < 0
    || end < start
    || end > message.content.length
  ) {
    fail(
      `${reasonPrefix}_mapping_invalid`,
      'A named Mnemosyne block has an invalid provider content span.',
    );
  }
  return {
    role: message.role,
    content: message.content.slice(
      start,
      end,
    ),
  };
}

function assertMnemosyneBlocks(
  messages,
  trace,
  measureContinuityPayloadTokens,
) {
  const internalEntries = trace.prompt_manager.entries;
  const runtimeEntry = internalEntries.find(
    entry => entry.identifier === RUNTIME_ID,
  );
  const payloadEntry = internalEntries.find(
    entry => entry.identifier === PAYLOAD_ID,
  );
  if (runtimeEntry?.role !== 'system' || payloadEntry?.role !== 'system') {
    fail(
      'mnemosyne_named_block_role_invalid',
      'Mnemosyne named blocks must originate as system prompts.',
    );
  }
  const runtimeContent = parseNamedBlock(mappedEntryMessage(
    messages,
    runtimeEntry,
    'runtime_contract',
  ), {
    tag: 'mnemosyne-runtime-contract',
    expectedSchema: RUNTIME_CONTRACT_SCHEMA,
    runId: trace.run_id,
    reasonPrefix: 'runtime_contract',
  });
  if (runtimeContent !== buildRuntimeContract()) {
    fail(
      'runtime_contract_content_invalid',
      'Runtime Contract contains content outside the versioned mechanical protocol.',
    );
  }

  const payloadJson = parseNamedBlock(mappedEntryMessage(
    messages,
    payloadEntry,
    'continuity_payload',
  ), {
    tag: 'mnemosyne-continuity-payload',
    expectedSchema: 'mnemosyne.continuity-payload.v1',
    runId: trace.run_id,
    reasonPrefix: 'continuity_payload',
  });
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (error) {
    fail('continuity_payload_json_invalid', 'Continuity Payload must contain valid JSON.', {
      cause: error.message,
    });
  }
  const validated = validateContinuityPayload(payload, {
    measureTokens: measureContinuityPayloadTokens,
  });
  if (trace.chat_ref && typeof trace.chat_ref === 'object') {
    const mismatchedFields = Object.entries(trace.chat_ref)
      .filter(([field, value]) => (
        !Object.hasOwn(validated.run_scope, field)
        || validated.run_scope[field] !== value
      ))
      .map(([field]) => field)
      .sort();
    if (mismatchedFields.length > 0) {
      fail(
        'continuity_payload_scope_mismatch',
        'Continuity Payload run scope does not match the frozen sidecar scope.',
        { fields: mismatchedFields },
      );
    }
  }
  return structuredClone(validated.run_scope);
}

async function assertProviderTrace(messages, providerTrace) {
  if (messages.length !== providerTrace.length) {
    fail('provider_trace_length_mismatch', 'Provider message count does not match the sidecar.', {
      messages: messages.length,
      trace: providerTrace.length,
    });
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const entry = providerTrace[index];
    const actualHash = await hashMessage(message);
    const actualPromptMessageHash = await hashNormalizedMessage(message);
    const actualName = message?.name ?? null;

    if (
      entry?.index !== index
      || entry?.role !== message?.role
      || (entry?.name ?? null) !== actualName
      || entry?.content_hash !== actualHash
      || entry?.prompt_message_hash !== actualPromptMessageHash
    ) {
      fail('provider_trace_hash_mismatch', 'Provider message does not match the sidecar.', {
        index,
        expected_identifier: entry?.identifier ?? null,
        expected_source_label: entry?.source_label ?? null,
        expected_role: entry?.role ?? null,
        actual_role: message?.role ?? null,
        expected_name: entry?.name ?? null,
        actual_name: actualName,
        expected_hash: entry?.content_hash ?? null,
        actual_hash: actualHash,
        expected_prompt_message_hash: entry?.prompt_message_hash ?? null,
        actual_prompt_message_hash: actualPromptMessageHash,
      });
    }
  }
}

async function canRemove(
  entry,
  providerEntry,
  trace,
  runScope,
  verifyRemovalAuthorization,
) {
  if (entry.retention_policy !== 'remove_absorbed_author_source') {
    return false;
  }

  const expectedSource = sourceLabelForPromptIdentifier(entry.identifier);
  if (!expectedSource || entry.source_label !== expectedSource) {
    fail('source_retention_not_authorized', 'Sidecar attempted to remove an unrecognized source.', {
      identifier: entry.identifier ?? null,
      source_label: entry.source_label ?? null,
    });
  }

  const grant = entry.removal_authorization;
  const expectedRunScope = sourceRemovalRunScope(
    trace,
    runScope,
  );
  if (!validSourceRemovalGrant(grant, {
    entry,
    expectedRunScope,
  })) {
    fail('source_removal_grant_invalid', 'Absorbed source removal grant is invalid.', {
      identifier: entry.identifier ?? null,
      source_label: entry.source_label ?? null,
    });
  }

  if (typeof verifyRemovalAuthorization !== 'function') {
    fail(
      'source_removal_authorizer_unavailable',
      'A trusted source-removal authorizer is required.',
    );
  }

  const verified = await verifyRemovalAuthorization(structuredClone(grant), {
    provider_content_hash: providerEntry?.content_hash ?? null,
    provider_prompt_message_hash: entry.prompt_message_hash,
    run_scope: structuredClone(expectedRunScope),
  });
  if (verified !== true) {
    fail('source_removal_grant_rejected', 'Source removal grant was rejected.', {
      grant_id: grant.grant_id,
    });
  }

  return true;
}

export async function prepareUpstreamRequest(
  requestBody,
  {
    verifyRemovalAuthorization,
    auditExcludedPhrases,
    measureContinuityPayloadTokens,
  } = {},
) {
  censusMark('UPSTREAM_PROMPT_FIDELITY', 'enter', {
    runId: requestBody?.[TRACE_KEY]?.run_id ?? null,
  });
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
    fail('request_body_invalid', 'Chat completion request body must be an object.');
  }

  if (!Array.isArray(requestBody.messages)) {
    fail('request_messages_missing', 'Chat completion messages must be an array.');
  }

  const trace = requestBody[TRACE_KEY];
  assertTraceShape(trace);
  const providerBudget = normalizeProviderBudgetBinding(
    trace.provider_budget,
    { runId: trace.run_id },
  );
  const hostHistoryBinding = normalizeHostHistoryBinding(
    trace.host_history_binding,
  );
  const hostHistoryCoordinateBasis =
    trace.host_history_coordinate_basis ?? null;
  if ((trace.unresolved_absorbed_sources ?? []).length > 0) {
    fail(
      'absorbed_source_unresolved',
      'An absorbed author source could not be mapped exactly onto the provider request.',
      { sources: trace.unresolved_absorbed_sources },
    );
  }
  assertPromptManagerNamedOrder(trace.prompt_manager.entries);
  const presetIdentifiers = assertPromptSourceLabels(trace.prompt_manager);
  await assertProviderTrace(requestBody.messages, trace.provider_messages);
  assertProviderNamedOrder(
    trace.provider_messages,
    trace.prompt_manager.entries,
  );
  await assertProviderPresetEnvelope(
    requestBody.messages,
    trace.prompt_manager.entries,
    presetIdentifiers,
  );
  const runScope = assertMnemosyneBlocks(
    requestBody.messages,
    trace,
    measureContinuityPayloadTokens,
  );
  assertHostHistoryBindingScope(hostHistoryBinding, runScope);

  const removed = [];
  const removalsByProvider = new Map();
  for (const entry of trace.prompt_manager.entries) {
    const providerEntry = Number.isInteger(entry?.provider_index)
      ? trace.provider_messages[entry.provider_index]
      : null;
    if (
      !await canRemove(
        entry,
        providerEntry,
        trace,
        runScope,
        verifyRemovalAuthorization,
      )
    ) {
      continue;
    }

    const message = requestBody.messages[entry.provider_index];
    if (typeof message?.content !== 'string') {
      fail(
        'source_removal_span_invalid',
        'Absorbed source removal requires a mapped text span.',
        { identifier: entry.identifier ?? null },
      );
    }
    let start = entry.provider_content_start;
    let end = entry.provider_content_end;
    if (
      !Number.isInteger(start)
      || !Number.isInteger(end)
    ) {
      const legacyWholeMessage = (
        providerEntry?.identifier === entry.identifier
        && providerEntry?.prompt_message_hash === entry.prompt_message_hash
      );
      if (!legacyWholeMessage) {
        fail(
          'source_removal_span_invalid',
          'Absorbed source removal requires an exact provider content span.',
          { identifier: entry.identifier ?? null },
        );
      }
      start = 0;
      end = message.content.length;
    }
    if (start < 0 || end <= start || end > message.content.length) {
      fail(
        'source_removal_span_invalid',
        'Absorbed source removal span is outside provider message content.',
        { identifier: entry.identifier ?? null },
      );
    }
    const mappedContent = message.content.slice(start, end);
    const mappedHash = await hashNormalizedMessage({
      role: entry.role,
      name: entry.name ?? null,
      content: mappedContent,
    });
    if (mappedHash !== entry.prompt_message_hash) {
      fail(
        'source_removal_span_hash_mismatch',
        'Absorbed source content no longer matches its trusted fingerprint.',
        { identifier: entry.identifier ?? null },
      );
    }
    const spans = removalsByProvider.get(entry.provider_index) ?? [];
    spans.push({
      start,
      end,
      entry,
      providerEntry,
    });
    removalsByProvider.set(entry.provider_index, spans);
  }

  const retainedMessages = [];
  const retainedProviderIndices = [];

  for (let index = 0; index < requestBody.messages.length; index += 1) {
    const message = structuredClone(requestBody.messages[index]);
    const spans = (removalsByProvider.get(index) ?? [])
      .sort((left, right) => right.start - left.start);
    let previousStart = Number.POSITIVE_INFINITY;
    for (const span of spans) {
      if (span.end > previousStart) {
        fail(
          'source_removal_span_overlap',
          'Absorbed source removal spans overlap.',
          { provider_index: index },
        );
      }
      previousStart = span.start;
      message.content = (
        message.content.slice(0, span.start)
        + message.content.slice(span.end)
      );
      removed.push({
        index,
        identifier: span.entry.identifier,
        source_label: span.entry.source_label,
        content_hash: span.entry.prompt_message_hash,
        provider_content_hash: span.providerEntry.content_hash,
        provider_content_utf16_length:
          requestBody.messages[index].content.length,
        start: span.start,
        end: span.end,
        scope:
          span.start === 0
          && span.end === requestBody.messages[index].content.length
            ? 'whole_message'
            : 'content_span',
      });
    }

    if (spans.length > 0 && String(message.content).trim() === '') continue;
    retainedProviderIndices.push(index);
    retainedMessages.push(message);
  }

  const { [TRACE_KEY]: _sidecar, ...rest } = requestBody;
  const body = {
    ...rest,
    messages: retainedMessages,
  };
  const removedIdentities = new Set(removed.map(entry => JSON.stringify([
    entry.identifier,
    entry.content_hash,
  ])));
  const sourceDecisions = trace.prompt_manager.entries
    .filter(entry => (
      sourceLabelForPromptIdentifier(entry.identifier)
      && entry.component_provenance !== null
      && entry.component_provenance !== undefined
    ))
    .map(entry => {
      const removedFromRequest = removedIdentities.has(JSON.stringify([
        entry.identifier,
        entry.prompt_message_hash,
      ]));
      return {
        order: entry.order,
        identifier: entry.identifier,
        source_label: entry.source_label,
        prompt_message_hash: entry.prompt_message_hash,
        requested_policy: entry.retention_policy,
        decision: removedFromRequest ? 'removed' : 'retained',
        grant_id: removedFromRequest
          ? entry.removal_authorization?.grant_id ?? null
          : null,
        reason_code: removedFromRequest
          ? 'trusted_removal_grant_verified'
          : entry.retention_policy === 'retain'
            ? 'host_source_retained'
            : 'source_removal_not_applied',
        };
      });
  const sourceRemovalGrants = sourceDecisions
    .filter(decision => decision.decision === 'removed')
    .map(decision => {
      const entry = trace.prompt_manager.entries.find(candidate => (
        candidate?.order === decision.order
        && candidate.identifier === decision.identifier
        && candidate.prompt_message_hash
          === decision.prompt_message_hash
      ));
      return structuredClone(entry.removal_authorization);
    });
  const providerMessageFingerprints = retainedMessages.map(
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
  const promptExclusionWitnesses = createPromptExclusionWitnesses({
    messages: retainedMessages,
    providerMessageFingerprints,
    phrases: auditExcludedPhrases,
  });
  const recentContinuityStripAvailability =
    inspectRecentContinuityStripAvailability({
      promptManagerEntries: trace.prompt_manager.entries,
      retainedProviderIndices,
    });
  const recentContinuityStripDiagnostics =
    recentContinuityStripMappingDiagnostics(
      trace,
      recentContinuityStripAvailability,
    );
  const recentContinuityStrip = (
    hostHistoryBinding
    && hostHistoryCoordinateBasis
    && recentContinuityStripAvailability.status === 'available'
  )
    ? createRecentContinuityStripWitness({
        promptManagerEntries: trace.prompt_manager.entries,
        hostHistoryBinding,
        hostHistoryCoordinateBasis,
        retainedProviderIndices,
        providerMessageFingerprints,
      })
    : null;

  censusMark('UPSTREAM_PROMPT_FIDELITY', 'passed', { runId: trace?.run_id ?? null });
  return {
    body,
    promptSpine: {
      schema: 'mnemosyne.prompt-spine.v1',
      run_id: trace.run_id,
      message_count: retainedMessages.length,
      hash: await hashPromptSpine(retainedMessages),
    },
    runScope,
    hostHistoryBinding,
    hostHistoryCoordinateBasis,
    providerBudget,
    recentContinuityStripAvailability,
    recentContinuityStripMappingDiagnostics:
      recentContinuityStripDiagnostics,
    report: {
      schema: 'mnemosyne.prompt-fidelity-report.v2',
      run_id: trace.run_id,
      verified_message_count: requestBody.messages.length,
      retained_message_count: retainedMessages.length,
      removed,
      source_decisions: sourceDecisions,
      source_removal_grants: sourceRemovalGrants,
      provider_message_fingerprints: providerMessageFingerprints,
      prompt_exclusion_witnesses: promptExclusionWitnesses,
      recent_continuity_strip: recentContinuityStrip,
    },
  };
}
