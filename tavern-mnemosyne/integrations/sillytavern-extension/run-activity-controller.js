const ACTIVITY_SCHEMA =
  'mnemosyne.user-visible-run-activity-list.v1';
const ACTIVITY_ROUTE = '/v1/mnemosyne/activity/inspect';
const DEFAULT_LIMIT = 20;
const MAXIMUM_LIMIT = 50;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENTRY_SCHEMA = 'mnemosyne.user-visible-run-activity.v1';
const STATUS_LABELS = Object.freeze({
  running: '运行中',
  body_committed: '回复已生成',
  applying_writeback: '正在写回',
  partial_success: '部分完成',
  completed: '已完成',
  failed: '未完成',
});

function activityError(reasonCode, message) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  return error;
}

function invalidActivity(message) {
  return activityError('run_activity_response_invalid', message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, field) {
  if (!isPlainObject(value)) {
    throw invalidActivity(`${field} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length
    || actual.some((key, index) => key !== required[index])
  ) {
    throw invalidActivity(`${field} has unsupported fields.`);
  }
}

function assertOpaqueString(
  value,
  field,
  maximumLength = 2048,
) {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalidActivity(`${field} is invalid.`);
  }
}

function assertSafeKey(value, field) {
  if (
    typeof value !== 'string'
    || value.length > 256
    || !SAFE_KEY_PATTERN.test(value)
  ) {
    throw invalidActivity(`${field} is invalid.`);
  }
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidActivity(`${field} is invalid.`);
  }
}

function assertNullableTimestamp(value, field) {
  if (
    value !== null
    && (
      typeof value !== 'string'
      || !Number.isFinite(Date.parse(value))
    )
  ) {
    throw invalidActivity(`${field} is invalid.`);
  }
}

function validateLayerCounts(value, field) {
  if (!Array.isArray(value)) {
    throw invalidActivity(`${field} must be an array.`);
  }
  const ids = [];
  for (const [index, item] of value.entries()) {
    const itemField = `${field}[${index}]`;
    assertExactKeys(item, ['id', 'label', 'count'], itemField);
    assertSafeKey(item.id, `${itemField}.id`);
    assertOpaqueString(item.label, `${itemField}.label`, 256);
    assertNonNegativeInteger(item.count, `${itemField}.count`);
    ids.push(item.id);
  }
  if (new Set(ids).size !== ids.length) {
    throw invalidActivity(`${field} contains duplicate layers.`);
  }
}

function validateReasonCodeCounts(value, field) {
  if (!isPlainObject(value)) {
    throw invalidActivity(`${field} must be an object.`);
  }
  for (const [reasonCode, count] of Object.entries(value)) {
    assertSafeKey(reasonCode, `${field} reason code`);
    assertNonNegativeInteger(count, `${field}.${reasonCode}`);
  }
}

function validateQualityMetrics(value, field) {
  if (!isPlainObject(value) || typeof value.status !== 'string') {
    throw invalidActivity(`${field} is invalid.`);
  }
  if (value.status === 'absent') {
    assertExactKeys(value, ['status'], field);
    return;
  }
  if (value.status === 'pass_failed') {
    assertExactKeys(value, ['status', 'reason_code'], field);
    assertSafeKey(value.reason_code, `${field}.reason_code`);
    return;
  }
  if (value.status !== 'recorded') {
    throw invalidActivity(`${field}.status is unsupported.`);
  }
  assertExactKeys(value, [
    'status',
    'engine_version',
    'engine_version_drift',
    'metrics',
    'degradation_flags',
    'slop_severity_counts',
  ], field);
  assertSafeKey(value.engine_version, `${field}.engine_version`);
  if (typeof value.engine_version_drift !== 'boolean') {
    throw invalidActivity(`${field}.engine_version_drift is invalid.`);
  }
  if (!isPlainObject(value.metrics)) {
    throw invalidActivity(`${field}.metrics must be an object.`);
  }
  for (const [metricId, metric] of Object.entries(value.metrics)) {
    assertSafeKey(metricId, `${field} metric id`);
    assertExactKeys(
      metric,
      ['value', 'experimental'],
      `${field}.metrics.${metricId}`,
    );
    if (
      typeof metric.value !== 'number'
      || !Number.isFinite(metric.value)
      || typeof metric.experimental !== 'boolean'
    ) {
      throw invalidActivity(`${field}.metrics.${metricId} is invalid.`);
    }
  }
  if (!isPlainObject(value.degradation_flags)) {
    throw invalidActivity(`${field}.degradation_flags must be an object.`);
  }
  for (const [flagId, enabled] of Object.entries(
    value.degradation_flags,
  )) {
    assertSafeKey(flagId, `${field} flag id`);
    if (typeof enabled !== 'boolean') {
      throw invalidActivity(`${field}.degradation_flags.${flagId} is invalid.`);
    }
  }
  validateReasonCodeCounts(
    value.slop_severity_counts,
    `${field}.slop_severity_counts`,
  );
}

function validateContinuityRules(value, field) {
  if (!isPlainObject(value) || typeof value.status !== 'string') {
    throw invalidActivity(`${field} is invalid.`);
  }
  if (value.status === 'absent') {
    assertExactKeys(value, ['status'], field);
    return;
  }
  if (value.status === 'pass_failed') {
    assertExactKeys(value, ['status', 'reason_code'], field);
    assertSafeKey(value.reason_code, `${field}.reason_code`);
    return;
  }
  if (value.status !== 'recorded') {
    throw invalidActivity(`${field}.status is unsupported.`);
  }
  assertExactKeys(value, [
    'status',
    'engine_version',
    'hard_count',
    'rule_counts',
  ], field);
  assertSafeKey(value.engine_version, `${field}.engine_version`);
  assertNonNegativeInteger(value.hard_count, `${field}.hard_count`);
  validateReasonCodeCounts(
    value.rule_counts,
    `${field}.rule_counts`,
  );
  const counted = Object.values(value.rule_counts).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (counted !== value.hard_count) {
    throw invalidActivity(`${field}.hard_count is inconsistent.`);
  }
}

function validateActivityEntry(entry, index) {
  const field = `entries[${index}]`;
  assertExactKeys(entry, [
    'schema',
    'run_id',
    'status',
    'created_at',
    'updated_at',
    'coordinate',
    'retrieval',
    'persistence',
    'safeguards',
    'usage',
    'quality',
    'continuity_rules',
  ], field);
  if (entry.schema !== ENTRY_SCHEMA) {
    throw invalidActivity(`${field}.schema is unsupported.`);
  }
  assertSafeKey(entry.run_id, `${field}.run_id`);
  if (!Object.hasOwn(STATUS_LABELS, entry.status)) {
    throw invalidActivity(`${field}.status is unsupported.`);
  }
  assertNullableTimestamp(entry.created_at, `${field}.created_at`);
  assertNullableTimestamp(entry.updated_at, `${field}.updated_at`);

  assertExactKeys(entry.coordinate, [
    'branch_id',
    'branch_epoch',
    'turn_index',
    'swipe_id',
  ], `${field}.coordinate`);
  assertOpaqueString(
    entry.coordinate.branch_id,
    `${field}.coordinate.branch_id`,
    256,
  );
  for (const key of ['branch_epoch', 'turn_index', 'swipe_id']) {
    assertNonNegativeInteger(
      entry.coordinate[key],
      `${field}.coordinate.${key}`,
    );
  }

  assertExactKeys(entry.retrieval, [
    'search_calls',
    'search_result_count',
    'read_calls',
    'read_entry_count',
    'continuation_pages_issued',
    'searched_layers',
    'read_layers',
  ], `${field}.retrieval`);
  for (const key of [
    'search_calls',
    'search_result_count',
    'read_calls',
    'read_entry_count',
    'continuation_pages_issued',
  ]) {
    assertNonNegativeInteger(
      entry.retrieval[key],
      `${field}.retrieval.${key}`,
    );
  }
  validateLayerCounts(
    entry.retrieval.searched_layers,
    `${field}.retrieval.searched_layers`,
  );
  validateLayerCounts(
    entry.retrieval.read_layers,
    `${field}.retrieval.read_layers`,
  );

  assertExactKeys(entry.persistence, [
    'story_body_sealed',
    'writeback_mode',
    'record_count',
    'updated_layers',
  ], `${field}.persistence`);
  if (typeof entry.persistence.story_body_sealed !== 'boolean') {
    throw invalidActivity(
      `${field}.persistence.story_body_sealed is invalid.`,
    );
  }
  if (
    ![null, 'changed', 'no_change']
      .includes(entry.persistence.writeback_mode)
  ) {
    throw invalidActivity(
      `${field}.persistence.writeback_mode is invalid.`,
    );
  }
  assertNonNegativeInteger(
    entry.persistence.record_count,
    `${field}.persistence.record_count`,
  );
  validateLayerCounts(
    entry.persistence.updated_layers,
    `${field}.persistence.updated_layers`,
  );

  assertExactKeys(entry.safeguards, [
    'rejected_step_count',
    'reason_code_counts',
  ], `${field}.safeguards`);
  assertNonNegativeInteger(
    entry.safeguards.rejected_step_count,
    `${field}.safeguards.rejected_step_count`,
  );
  validateReasonCodeCounts(
    entry.safeguards.reason_code_counts,
    `${field}.safeguards.reason_code_counts`,
  );

  assertExactKeys(entry.usage, [
    'prompt_tokens',
    'completion_tokens',
  ], `${field}.usage`);
  assertNonNegativeInteger(
    entry.usage.prompt_tokens,
    `${field}.usage.prompt_tokens`,
  );
  assertNonNegativeInteger(
    entry.usage.completion_tokens,
    `${field}.usage.completion_tokens`,
  );
  validateQualityMetrics(entry.quality, `${field}.quality`);
  validateContinuityRules(
    entry.continuity_rules,
    `${field}.continuity_rules`,
  );
}

export function runActivityStatusLabel(status) {
  if (!Object.hasOwn(STATUS_LABELS, status)) {
    throw activityError(
      'run_activity_status_unsupported',
      'Run Activity status is unsupported.',
    );
  }
  return STATUS_LABELS[status];
}

export function validateRunActivityResponse(
  response,
  { chatId },
) {
  assertExactKeys(
    response,
    ['schema', 'chat_id', 'entries'],
    'run activity response',
  );
  if (response.schema !== ACTIVITY_SCHEMA) {
    throw invalidActivity('Run activity schema is unsupported.');
  }
  assertOpaqueString(response.chat_id, 'response.chat_id');
  if (response.chat_id !== chatId) {
    throw invalidActivity(
      'Run activity response belongs to another chat.',
    );
  }
  if (!Array.isArray(response.entries)) {
    throw invalidActivity('response.entries must be an array.');
  }
  for (const [index, entry] of response.entries.entries()) {
    validateActivityEntry(entry, index);
  }
  return structuredClone(response);
}

function initialState() {
  return {
    open: false,
    loading: false,
    chatId: null,
    entries: [],
    status: '尚未查看。',
    statusKind: 'idle',
  };
}

export function createRunActivityController({
  post,
  onChange = () => {},
}) {
  if (
    typeof post !== 'function'
    || typeof onChange !== 'function'
  ) {
    throw new TypeError(
      'Run Activity controller dependencies are invalid.',
    );
  }
  const state = initialState();
  let requestRevision = 0;

  function snapshot() {
    return structuredClone(state);
  }

  function notify() {
    try {
      onChange(snapshot());
    } catch {
      // Activity rendering is isolated from story generation.
    }
  }

  function close() {
    requestRevision += 1;
    state.open = false;
    state.loading = false;
    notify();
  }

  function clearForChatChange() {
    requestRevision += 1;
    Object.assign(state, initialState());
    notify();
  }

  async function refresh({
    chatId,
    limit = DEFAULT_LIMIT,
  }) {
    let revision = null;
    try {
      if (
        typeof chatId !== 'string'
        || !chatId.trim()
        || chatId.length > 2048
        || /[\u0000-\u001f\u007f]/.test(chatId)
      ) {
        throw activityError(
          'run_activity_chat_unavailable',
          'Open a chat before inspecting Run Activity.',
        );
      }
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > MAXIMUM_LIMIT
      ) {
        throw activityError(
          'run_activity_input_invalid',
          'Activity limit must be between 1 and 50.',
        );
      }
      if (state.chatId !== chatId) state.entries = [];
      state.chatId = chatId;
      state.loading = true;
      state.status = '正在读取…';
      state.statusKind = 'idle';
      revision = ++requestRevision;
      notify();
      const response = await post(ACTIVITY_ROUTE, {
        chat_id: chatId,
        limit,
      });
      if (revision !== requestRevision) {
        return { ok: false, reason_code: 'run_activity_request_stale' };
      }
      const validated = validateRunActivityResponse(
        response,
        { chatId },
      );
      state.entries = validated.entries;
      state.loading = false;
      state.status = state.entries.length === 0
        ? '当前聊天还没有可显示的活动。'
        : `已读取 ${state.entries.length} 轮活动。`;
      state.statusKind = 'success';
      notify();
      return { ok: true, status: 'ready' };
    } catch (error) {
      if (
        revision !== null
        && revision !== requestRevision
      ) {
        return { ok: false, reason_code: 'run_activity_request_stale' };
      }
      state.loading = false;
      console.warn(
        '[Mnemosyne] run activity unavailable:',
        error?.reasonCode ?? 'run_activity_failed',
      );
      state.status = '每轮活动暂时不可用，请稍后重试。';
      state.statusKind = 'error';
      notify();
      return {
        ok: false,
        reason_code:
          error?.reasonCode
          ?? 'run_activity_failed',
      };
    }
  }

  async function open(options) {
    state.open = true;
    notify();
    return refresh(options);
  }

  return Object.freeze({
    snapshot,
    open,
    close,
    refresh,
    clearForChatChange,
  });
}
