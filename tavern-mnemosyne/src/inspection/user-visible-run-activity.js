import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { OKF_TYPE_DIRECTORIES } from '../okf/schema.js';
import {
  verifyQualityMetricsEvent,
} from '../craft/quality-telemetry-pass.js';
import {
  verifyContinuityRulesEvent,
} from '../craft/continuity-rule-auditor.js';

const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RUN_STATES = new Set([
  'running',
  'body_committed',
  'applying_writeback',
  'partial_success',
  'completed',
  'failed',
]);
const TOOL_NAMES = new Set([
  'memory_search',
  'memory_read',
  'story_commit',
  'memory_write_turn_delta',
]);
const RETRIEVAL_REJECTION_REASON_CODES = new Set([
  'memory_query_invalid',
  'memory_search_limit_invalid',
  'memory_search_intent_invalid',
  'memory_coverage_facets_invalid',
  'memory_ref_invalid',
  'memory_read_budget_invalid',
  'memory_read_budget_too_small',
  'memory_read_cursor_invalid',
  'memory_read_cursor_stale',
  'memory_read_continuation_required',
  'memory_read_intent_invalid',
]);
const WRITEBACK_REJECTION_REASON_CODES = new Set([
  'source_quote_ambiguous',
  'source_span_mismatch',
  'turn_delta_invalid',
  'turn_delta_record_invalid',
  'turn_delta_records_invalid',
  'turn_delta_event_invalid',
  'turn_delta_reason_invalid',
  'turn_delta_state_invalid',
  'unsupported_claim',
]);
const REJECTION_REASON_CODES_BY_TOOL = new Map([
  ['memory_search', RETRIEVAL_REJECTION_REASON_CODES],
  ['memory_read', RETRIEVAL_REJECTION_REASON_CODES],
  ['memory_write_turn_delta', WRITEBACK_REJECTION_REASON_CODES],
]);
const EVENT_TYPES = new Set([
  'tool_completed',
  'tool_rejected',
  'tool_started',
  'writeback_recovered',
  'model_step_rejected',
  'quality_metrics.v1',
  'quality_metrics_pass_failed',
  'continuity_rules.v1',
  'continuity_rules_pass_failed',
]);
const CONTINUITY_RULE_IDS = new Set([
  'terminal_character_in_active_scene',
  'same_turn_knowledge_boundary_collision',
]);
const QUALITY_METRIC_IDS = new Set([
  'mattr',
  'mtld',
  'sentence_start_echo_rate',
  'paragraph_structure_repetition',
  'four_gram_echo_rate',
  'substantive_change_count',
  'no_change_turn',
  'positive_ending',
  'slop_hit_count',
  'slop_high_severity_hit_count',
  'echo_rate',
]);
const SAFE_REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_VERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LAYER_LABELS = Object.freeze({
  current_state: '当前状态',
  attribute_value: '属性值',
  character: '人物状态',
  character_cognition: '人物认知',
  relationship: '人物关系',
  scene_event: '场景事件',
  world_lore: '世界规则与背景',
  plot_thread: '未结剧情线',
  scene_state: '场景、位置与物品',
  source_note: '来源说明',
});
const WRITEBACK_LAYER_IDS = new Set([
  'current_state',
  'attribute_value',
  'character',
  'character_cognition',
  'relationship',
  'scene_event',
  'world_lore',
  'plot_thread',
  'scene_state',
]);
const OKF_TYPE_TO_USER_LAYER = Object.freeze({
  character: 'character',
  character_cognition: 'character_cognition',
  relationship: 'relationship',
  scene_event: 'scene_event',
  continuity_state: 'current_state',
  world_lore: 'world_lore',
  plot_thread: 'plot_thread',
  scene_state: 'scene_state',
  source_note: 'source_note',
});
const TURN_RECORD_TYPE_TO_USER_LAYER = Object.freeze({
  current_state: 'current_state',
  attribute_value: 'attribute_value',
  character: 'character',
  character_cognition: 'character_cognition',
  relationship: 'relationship',
  scene_event: 'scene_event',
  continuity_state: 'current_state',
  world_lore: 'world_lore',
  plot_thread: 'plot_thread',
  scene_state: 'scene_state',
});
const SEARCH_STATE_LAYER_IDS = new Set([
  'current_state',
  'attribute_value',
]);

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    isPlainObject(value)
    && Object.values(value).every(isJsonValue)
  );
}

function isCanonicalIsoTimestampOrNull(value) {
  if (value === null || value === undefined) return true;
  if (
    typeof value !== 'string'
    || !ISO_TIMESTAMP_PATTERN.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime())
    && parsed.toISOString() === value
  );
}

function assertOpaqueChatId(value) {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 2048
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(
      'run_activity_input_invalid',
      'chatId is invalid.',
      { field: 'chatId' },
    );
  }
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      'run_activity_extractor_unsupported',
      `Run activity ${field} is unsupported.`,
      { field },
    );
  }
}

function isOpaqueCallId(value) {
  return (
    typeof value === 'string'
    && value.length > 0
  );
}

function assertOrdinaryToolEventSeal(event) {
  if (
    !isOpaqueCallId(event.call_id)
    || (
      event.type === 'tool_completed'
        ? !isPlainObject(event.arguments)
        : !isJsonValue(event.arguments)
    )
    || event.arguments_hash
      !== sha256(canonicalJson(event.arguments))
  ) {
    fail(
      'run_activity_extractor_unsupported',
      'A tool event has an invalid call or argument seal.',
    );
  }
  if (event.type === 'tool_completed') {
    if (
      !isPlainObject(event.result)
      || event.result_hash
        !== sha256(canonicalJson(event.result))
      || event.error !== null
    ) {
      fail(
        'run_activity_extractor_unsupported',
        'A completed tool event has an invalid result seal.',
      );
    }
    return;
  }
  if (
    event.type !== 'tool_rejected'
    || event.result !== null
    || event.result_hash !== null
    || !isPlainObject(event.error)
  ) {
    fail(
      'run_activity_extractor_unsupported',
      'A rejected tool event has an invalid result/error seal.',
    );
  }
}

function okfLayerId(type) {
  if (
    typeof type === 'string'
    && Object.hasOwn(OKF_TYPE_DIRECTORIES, type)
    && Object.hasOwn(OKF_TYPE_TO_USER_LAYER, type)
  ) {
    return OKF_TYPE_TO_USER_LAYER[type];
  }
  fail(
    'run_activity_extractor_unsupported',
    'An OKF memory entry has an unsupported type.',
  );
}

function turnRecordLayerId(type, state = null) {
  if (
    typeof type !== 'string'
    || !Object.hasOwn(TURN_RECORD_TYPE_TO_USER_LAYER, type)
  ) {
    fail(
      'run_activity_extractor_unsupported',
      'A turn memory entry has an unsupported record type.',
    );
  }
  if (
    type === 'continuity_state'
    && state?.domain === 'attribute'
  ) {
    return 'attribute_value';
  }
  return TURN_RECORD_TYPE_TO_USER_LAYER[type];
}

function layerIdFromSearchResult(result) {
  if (!isPlainObject(result)) {
    fail(
      'run_activity_extractor_unsupported',
      'A memory search result entry is unsupported.',
    );
  }
  if (result.kind === 'okf_concept') {
    if (Object.hasOwn(result, 'state_layer')) {
      fail(
        'run_activity_extractor_unsupported',
        'An OKF search entry has an unexpected state layer.',
      );
    }
    return okfLayerId(result.type);
  }
  if (result.kind === 'turn_memory_record') {
    if (result.type === 'continuity_state') {
      if (!SEARCH_STATE_LAYER_IDS.has(result.state_layer)) {
        fail(
          'run_activity_extractor_unsupported',
          'A continuity-state search entry has no supported state layer.',
        );
      }
      return result.state_layer;
    }
    if (Object.hasOwn(result, 'state_layer')) {
      fail(
        'run_activity_extractor_unsupported',
        'A turn memory search entry has an unexpected state layer.',
      );
    }
    return turnRecordLayerId(result.type);
  }
  if (
    result.kind === 'current_state'
    && result.type === 'current_state'
  ) {
    if (!SEARCH_STATE_LAYER_IDS.has(result.state_layer)) {
      fail(
        'run_activity_extractor_unsupported',
        'A current-state search entry has no supported state layer.',
      );
    }
    return result.state_layer;
  }
  fail(
    'run_activity_extractor_unsupported',
    'A memory search result has an unsupported entry kind.',
  );
}

function layerIdFromReadEntry(entry) {
  if (!isPlainObject(entry)) {
    fail(
      'run_activity_extractor_unsupported',
      'A memory read entry is unsupported.',
    );
  }
  if (entry.kind === 'okf_concept') {
    return okfLayerId(entry.type);
  }
  if (entry.kind === 'turn_memory_record') {
    return turnRecordLayerId(entry.record_kind, entry.state);
  }
  if (
    entry.kind === 'current_state'
    && isPlainObject(entry.state)
    && typeof entry.state.domain === 'string'
    && entry.state.domain
  ) {
    return entry.state.domain === 'attribute'
      ? 'attribute_value'
      : 'current_state';
  }
  fail(
    'run_activity_extractor_unsupported',
    'A memory read result has an unsupported entry kind.',
  );
}

function addCount(target, value) {
  target[value] = (target[value] ?? 0) + 1;
}

function layerCounts(value) {
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, count]) => ({
      id,
      label: LAYER_LABELS[id],
      count,
    }));
}

function sortedCountObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (
      left.localeCompare(right)
    )),
  );
}

function assertJournalEnvelope(journal) {
  if (
    !isPlainObject(journal)
    || journal.schema !== 'mnemosyne.run-journal.v1'
    || typeof journal.chat_id !== 'string'
    || !SAFE_RUN_ID_PATTERN.test(journal.run_id ?? '')
    || !RUN_STATES.has(journal.state)
    || !isPlainObject(journal.run_scope)
    || journal.run_scope.chat_id !== journal.chat_id
    || journal.run_scope.run_id !== journal.run_id
    || journal.run_scope.branch_id !== 'main'
    || !isCanonicalIsoTimestampOrNull(journal.created_at)
    || !isCanonicalIsoTimestampOrNull(journal.updated_at)
    || !Array.isArray(journal.events)
  ) {
    fail(
      'run_activity_extractor_unsupported',
      'A Run Journal has an unsupported envelope.',
    );
  }
  for (const [field, value] of Object.entries({
    branch_epoch: journal.run_scope.branch_epoch,
    turn_index: journal.run_scope.turn_index,
    swipe_id: journal.run_scope.swipe_id ?? 0,
  })) {
    assertNonNegativeInteger(value, field);
  }
}

// Positive allowlist extraction for quality telemetry: sealed hash must
// verify, coordinates must bind to the run scope, metric ids must be known,
// and only finite numbers/booleans survive into the visible entry.
function extractQualityMetrics(event, journal) {
  let verification;
  try {
    verification = verifyQualityMetricsEvent(event);
  } catch {
    fail(
      'run_activity_extractor_unsupported',
      'A quality metrics event failed its seal verification.',
    );
  }
  const coordinate = event.coordinate;
  if (
    !isPlainObject(coordinate)
    || coordinate.chat_id !== journal.chat_id
    || coordinate.branch_id !== journal.run_scope.branch_id
    || coordinate.branch_epoch !== journal.run_scope.branch_epoch
    || coordinate.turn_index !== journal.run_scope.turn_index
    || !SAFE_VERSION_ID_PATTERN.test(event.engine_version ?? '')
    || !isPlainObject(event.metrics)
    || !isPlainObject(event.degradation)
    || !isPlainObject(event.degradation.flags)
  ) {
    fail(
      'run_activity_extractor_unsupported',
      'A quality metrics event does not bind to this run.',
    );
  }
  const metrics = {};
  for (const [id, entry] of Object.entries(event.metrics)) {
    if (
      !QUALITY_METRIC_IDS.has(id)
      || !isPlainObject(entry)
      || typeof entry.value !== 'number'
      || !Number.isFinite(entry.value)
      || typeof entry.experimental !== 'boolean'
    ) {
      fail(
        'run_activity_extractor_unsupported',
        'A quality metric entry is unsupported.',
      );
    }
    metrics[id] = {
      value: entry.value,
      experimental: entry.experimental,
    };
  }
  const flags = {};
  for (const [id, value] of Object.entries(event.degradation.flags)) {
    if (
      !/^[a-z][a-z0-9_]{0,63}$/.test(id)
      || typeof value !== 'boolean'
    ) {
      fail(
        'run_activity_extractor_unsupported',
        'A degradation flag is unsupported.',
      );
    }
    flags[id] = value;
  }
  const slopSeverityCounts = {};
  if (event.slop_detail !== null && event.slop_detail !== undefined) {
    if (
      !isPlainObject(event.slop_detail)
      || !Array.isArray(event.slop_detail.hits)
    ) {
      fail(
        'run_activity_extractor_unsupported',
        'A slop detail block is unsupported.',
      );
    }
    for (const hit of event.slop_detail.hits) {
      if (
        !isPlainObject(hit)
        || typeof hit.phrase !== 'string'
        || hit.phrase.length === 0
        || hit.phrase.length > 64
        || !['low', 'medium', 'high'].includes(hit.severity)
        || !Number.isInteger(hit.start)
        || !Number.isInteger(hit.end)
        || hit.start < 0
        || hit.end <= hit.start
      ) {
        fail(
          'run_activity_extractor_unsupported',
          'A slop hit entry is unsupported.',
        );
      }
      addCount(slopSeverityCounts, hit.severity);
    }
  }
  return {
    status: 'recorded',
    engine_version: event.engine_version,
    engine_version_drift: verification.engine_version_drift,
    metrics: sortedCountObject(metrics),
    degradation_flags: sortedCountObject(flags),
    slop_severity_counts: sortedCountObject(slopSeverityCounts),
  };
}

function extractContinuityRules(event, journal) {
  try {
    verifyContinuityRulesEvent(event);
  } catch {
    fail(
      'run_activity_extractor_unsupported',
      'A continuity-rules event failed its seal verification.',
    );
  }
  const coordinate = event.coordinate;
  if (
    !isPlainObject(coordinate)
    || coordinate.chat_id !== journal.chat_id
    || coordinate.branch_id !== journal.run_scope.branch_id
    || coordinate.branch_epoch !== journal.run_scope.branch_epoch
    || coordinate.turn_index !== journal.run_scope.turn_index
    || coordinate.candidate_id !== journal.run_scope.candidate_id
    || !SAFE_VERSION_ID_PATTERN.test(event.engine_version ?? '')
    || event.consumers !== 'none'
    || !Array.isArray(event.findings)
    || !isPlainObject(event.summary)
    || !isPlainObject(event.summary.rule_counts)
  ) {
    fail(
      'run_activity_extractor_unsupported',
      'A continuity-rules event does not bind to this run.',
    );
  }
  const counts = {};
  for (const finding of event.findings) {
    if (
      !isPlainObject(finding)
      || !CONTINUITY_RULE_IDS.has(finding.rule_id)
      || finding.severity !== 'hard'
      || !Number.isSafeInteger(finding.turn_index)
      || finding.turn_index < 0
      || !/^[a-f0-9]{64}$/.test(finding.candidate_id_hash ?? '')
      || !/^[a-f0-9]{64}$/.test(finding.entity_ref_hash ?? '')
    ) {
      fail(
        'run_activity_extractor_unsupported',
        'A continuity-rules finding is unsupported.',
      );
    }
    addCount(counts, finding.rule_id);
  }
  if (
    event.summary.hard_count !== event.findings.length
    || canonicalJson(sortedCountObject(counts))
      !== canonicalJson(event.summary.rule_counts)
  ) {
    fail(
      'run_activity_extractor_unsupported',
      'A continuity-rules summary does not match its findings.',
    );
  }
  return {
    status: 'recorded',
    engine_version: event.engine_version,
    hard_count: event.summary.hard_count,
    rule_counts: sortedCountObject(counts),
  };
}

function summarizeJournal(journal) {
  assertJournalEnvelope(journal);
  const searchedLayers = {};
  const readLayers = {};
  const updatedLayers = {};
  const reasonCodeCounts = {};
  let searchCalls = 0;
  let searchResultCount = 0;
  let readCalls = 0;
  let readEntryCount = 0;
  let continuationPagesIssued = 0;
  let rejectedStepCount = 0;
  let storyBodySealed = false;
  let writebackMode = null;
  let recordCount = 0;
  let quality = { status: 'absent' };
  let continuityRules = { status: 'absent' };
  const startedWritebacks = new Map();

  for (const event of journal.events) {
    if (
      !isPlainObject(event)
      || !EVENT_TYPES.has(event.type)
    ) {
      fail(
        'run_activity_extractor_unsupported',
        'A Run Journal event type is unsupported.',
      );
    }
    if (event.type === 'model_step_rejected') {
      if (
        event.tool !== 'main_ai_tool_protocol'
        || event.reason_code !== 'main_ai_tool_protocol_invalid'
      ) {
        fail(
          'run_activity_extractor_unsupported',
          'A model protocol rejection is unsupported.',
        );
      }
      rejectedStepCount += 1;
      addCount(reasonCodeCounts, event.reason_code);
      continue;
    }
    if (event.type === 'quality_metrics.v1') {
      quality = extractQualityMetrics(event, journal);
      continue;
    }
    if (event.type === 'quality_metrics_pass_failed') {
      if (!SAFE_REASON_CODE_PATTERN.test(event.reason_code ?? '')) {
        fail(
          'run_activity_extractor_unsupported',
          'A quality pass failure event is unsupported.',
        );
      }
      quality = {
        status: 'pass_failed',
        reason_code: event.reason_code,
      };
      continue;
    }
    if (event.type === 'continuity_rules.v1') {
      continuityRules = extractContinuityRules(event, journal);
      continue;
    }
    if (event.type === 'continuity_rules_pass_failed') {
      if (!SAFE_REASON_CODE_PATTERN.test(event.reason_code ?? '')) {
        fail(
          'run_activity_extractor_unsupported',
          'A continuity-rules pass failure event is unsupported.',
        );
      }
      continuityRules = {
        status: 'pass_failed',
        reason_code: event.reason_code,
      };
      continue;
    }
    if (event.type === 'writeback_recovered') {
      const started = startedWritebacks.get(event.call_id);
      if (
        event.tool !== 'memory_write_turn_delta'
        || !started
        || event?.result?.status !== 'applied'
        || event.result_hash
          !== sha256(canonicalJson(event.result))
      ) {
        fail(
          'run_activity_extractor_unsupported',
          'A recovered writeback event is unsupported.',
        );
      }
      for (const kind of started.recordKinds) {
        addCount(updatedLayers, kind);
      }
      recordCount = started.recordKinds.length;
      writebackMode = started.mode;
      startedWritebacks.delete(event.call_id);
      continue;
    }
    if (!TOOL_NAMES.has(event.tool)) {
      fail(
        'run_activity_extractor_unsupported',
        'A Run Journal tool is unsupported.',
      );
    }
    if (
      event.type === 'tool_completed'
      || event.type === 'tool_rejected'
    ) {
      assertOrdinaryToolEventSeal(event);
    }
    if (event.type === 'tool_rejected') {
      const reasonCode = event?.error?.reason_code;
      if (
        !REJECTION_REASON_CODES_BY_TOOL
          .get(event.tool)
          ?.has(reasonCode)
      ) {
        fail(
          'run_activity_extractor_unsupported',
          'A rejected tool reason code is unsupported.',
        );
      }
      rejectedStepCount += 1;
      addCount(reasonCodeCounts, reasonCode);
      if (
        event.tool === 'memory_write_turn_delta'
        && startedWritebacks.has(event.call_id)
      ) {
        startedWritebacks.delete(event.call_id);
      }
      continue;
    }
    if (event.type === 'tool_started') {
      if (
        event.tool !== 'memory_write_turn_delta'
        || !isOpaqueCallId(event.call_id)
        || !isPlainObject(event.arguments)
        || !Array.isArray(event.arguments.records)
        || !['changed', 'no_change'].includes(
          event.arguments.mode,
        )
        || event.arguments_hash
          !== sha256(canonicalJson(event.arguments))
        || event.result !== null
        || event.result_hash !== null
        || event.error !== null
        || startedWritebacks.has(event.call_id)
      ) {
        fail(
          'run_activity_extractor_unsupported',
          'A tool lifecycle event is unsupported.',
        );
      }
      const recordKinds = event.arguments.records.map(record => {
        if (!WRITEBACK_LAYER_IDS.has(record?.kind)) {
          fail(
            'run_activity_extractor_unsupported',
            'A writeback record has an unsupported state layer.',
          );
        }
        return record.kind;
      });
      startedWritebacks.set(event.call_id, {
        mode: event.arguments.mode,
        recordKinds,
        arguments: event.arguments,
      });
      continue;
    }

    if (event.tool === 'memory_search') {
      const results = event?.result?.results;
      if (
        event?.result?.schema
          !== 'mnemosyne.memory-search-result.v2'
        || event.result.status !== 'ready'
        || !Array.isArray(results)
      ) {
        fail(
          'run_activity_extractor_unsupported',
          'A memory search result is unsupported.',
        );
      }
      searchCalls += 1;
      searchResultCount += results.length;
      for (const result of results) {
        addCount(searchedLayers, layerIdFromSearchResult(result));
      }
      continue;
    }
    if (event.tool === 'memory_read') {
      const entries = event?.result?.entries;
      const cursors = event?.result?.continuation_cursors ?? [];
      if (
        event?.result?.schema
          !== 'mnemosyne.memory-context-pack.v2'
        || !Array.isArray(entries)
        || !Array.isArray(cursors)
      ) {
        fail(
          'run_activity_extractor_unsupported',
          'A memory read result is unsupported.',
        );
      }
      readCalls += 1;
      readEntryCount += entries.length;
      continuationPagesIssued += cursors.length;
      for (const entry of entries) {
        addCount(readLayers, layerIdFromReadEntry(entry));
      }
      continue;
    }
    if (event.tool === 'story_commit') {
      storyBodySealed = event?.result?.status === 'locked';
      continue;
    }
    if (event.tool === 'memory_write_turn_delta') {
      const records = event?.arguments?.records;
      const mode = event?.arguments?.mode;
      if (
        !Array.isArray(records)
        || !['changed', 'no_change'].includes(mode)
      ) {
        fail(
          'run_activity_extractor_unsupported',
          'A memory writeback result is unsupported.',
        );
      }
      const started = startedWritebacks.get(event.call_id);
      if (
        !started
        || canonicalJson(started.arguments)
          !== canonicalJson(event.arguments)
        || event.result.status !== 'applied'
      ) {
        fail(
          'run_activity_extractor_unsupported',
          'A completed writeback is not sealed to an applied start event.',
        );
      }
      startedWritebacks.delete(event.call_id);
      writebackMode = mode;
      recordCount = records.length;
      for (const record of records) {
        if (!WRITEBACK_LAYER_IDS.has(record?.kind)) {
          fail(
            'run_activity_extractor_unsupported',
            'A writeback record has an unsupported state layer.',
          );
        }
        addCount(updatedLayers, record.kind);
      }
    }
  }
  if (
    journal.state === 'completed'
    && startedWritebacks.size > 0
  ) {
    fail(
      'run_activity_extractor_unsupported',
      'A completed run has an unsettled writeback lifecycle.',
    );
  }

  writebackMode ??= journal?.result?.writeback?.mode ?? null;
  if (
    writebackMode !== null
    && !['changed', 'no_change'].includes(writebackMode)
  ) {
    fail(
      'run_activity_extractor_unsupported',
      'The final writeback mode is unsupported.',
    );
  }
  storyBodySealed ||= (
    journal.committed !== null
    && journal.committed !== undefined
  );
  const promptTokens = Number(
    journal?.aggregate_usage?.prompt_tokens ?? 0,
  );
  const completionTokens = Number(
    journal?.aggregate_usage?.completion_tokens ?? 0,
  );
  assertNonNegativeInteger(promptTokens, 'prompt_tokens');
  assertNonNegativeInteger(completionTokens, 'completion_tokens');

  return {
    schema: 'mnemosyne.user-visible-run-activity.v1',
    run_id: journal.run_id,
    status: journal.state,
    created_at: journal.created_at ?? null,
    updated_at: journal.updated_at ?? null,
    coordinate: {
      branch_id: journal.run_scope.branch_id,
      branch_epoch: journal.run_scope.branch_epoch,
      turn_index: journal.run_scope.turn_index,
      swipe_id: journal.run_scope.swipe_id ?? 0,
    },
    retrieval: {
      search_calls: searchCalls,
      search_result_count: searchResultCount,
      read_calls: readCalls,
      read_entry_count: readEntryCount,
      continuation_pages_issued: continuationPagesIssued,
      searched_layers: layerCounts(searchedLayers),
      read_layers: layerCounts(readLayers),
    },
    persistence: {
      story_body_sealed: storyBodySealed,
      writeback_mode: writebackMode,
      record_count: recordCount,
      updated_layers: layerCounts(updatedLayers),
    },
    safeguards: {
      rejected_step_count: rejectedStepCount,
      reason_code_counts: sortedCountObject(reasonCodeCounts),
    },
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    },
    quality,
    continuity_rules: continuityRules,
  };
}

export function createUserVisibleRunActivity({
  runJournal,
} = {}) {
  if (typeof runJournal?.list !== 'function') {
    throw new TypeError(
      'User-visible Run Activity requires a Run Journal list interface.',
    );
  }
  return Object.freeze({
    async inspect({ chatId, limit = 20 } = {}) {
      assertOpaqueChatId(chatId);
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > 50
      ) {
        fail(
          'run_activity_input_invalid',
          'limit must be between 1 and 50.',
          { field: 'limit' },
        );
      }
      const listed = await runJournal.list({ chatId, limit });
      if (
        listed?.schema !== 'mnemosyne.run-journal-list.v1'
        || listed.chat_id !== chatId
        || !Array.isArray(listed.journals)
      ) {
        fail(
          'run_activity_extractor_unsupported',
          'Run Journal list result is unsupported.',
        );
      }
      return {
        schema: 'mnemosyne.user-visible-run-activity-list.v1',
        chat_id: chatId,
        entries: listed.journals.map(summarizeJournal),
      };
    },
  });
}
