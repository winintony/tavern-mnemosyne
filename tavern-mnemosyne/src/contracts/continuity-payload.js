import { MnemosyneRequestError } from './errors.js';
import { censusMark } from '../inspection/gate-census.js';

const SCHEMA = 'mnemosyne.continuity-payload.v1';
const ARRAY_FIELDS = [
  'hard_current_state',
  'cognition_boundaries',
  'relationship_state',
  'active_dossier_deltas',
  'state_atlas_handles',
  'latent_obligation_refs',
  'retrieval_handles',
  'unknowns',
  'omissions',
];
const TOP_LEVEL_FIELDS = new Set([
  'schema',
  'run_scope',
  'active_scene',
  ...ARRAY_FIELDS,
  'beat_rhythm',
  'budget_report',
]);
// Optional data-plane blocks: validated when present, never required.
const OPTIONAL_OBJECT_FIELDS = new Set(['beat_rhythm']);
const FORBIDDEN_KEYS = new Set([
  'host_creative_contract',
  'prompt_pressure_map',
  'attention_counterweight',
  'raw_worldbook',
  'raw_persona',
  'raw_character_card',
  'raw_scenario',
  'recent_chat_recap',
  'plot_advice',
  'scene_brief',
]);
const FORBIDDEN_KEY_PATTERN = /(instruction|directive|prompt|creative|writer|prose|style_advice)/i;
const MAX_STRING_CHARS = 4096;
const MAX_ARRAY_ITEMS = 128;
const MAX_OBJECT_KEYS = 64;
const MAX_NESTING_DEPTH = 6;

const OBJECT_FIELD_KEYS = new Map([
  ['run_scope', new Set([
    'chat_id',
    'branch_epoch',
    'active_candidate_id',
    'visible_turn_index',
    'target_turn_index',
    'parent_turn_index',
    'active_swipe_id',
  ])],
  ['active_scene', new Set([
    'status',
    'ref',
    'scene_ref',
    'label',
    'time_ref',
    'location_refs',
    'participant_refs',
    'source_refs',
    'reason_code',
  ])],
  ['budget_report', new Set([
    'estimated_tokens',
    'hard_cap_tokens',
    'unavailable_lanes',
    'measurement',
  ])],
  ['beat_rhythm', new Set([
    'window_scenes',
    'unlabeled_scene_turns',
    'beat_sequence',
    'same_type_run',
    'same_type_beat',
    'positive_ending_run',
    'null_scene_run',
    'turns_since_setback',
    'trigger',
  ])],
]);

const ARRAY_ITEM_KEYS = new Map([
  ['hard_current_state', new Set([
    'ref',
    'entity_ref',
    'label',
    'state_domain',
    'state_key',
    'value',
    'current_value',
    'unit',
    'status',
    'source_refs',
    'certainty',
    'confidence',
    'valid_from',
    'valid_to',
    'updated_at',
  ])],
  ['cognition_boundaries', new Set([
    'ref',
    'character_ref',
    'knows_refs',
    'believes_refs',
    'suspects_refs',
    'does_not_know_refs',
    'source_refs',
    'certainty',
  ])],
  ['relationship_state', new Set([
    'ref',
    'relationship_ref',
    'subject_ref',
    'object_ref',
    'state_key',
    'value',
    'stage_ref',
    'source_refs',
    'certainty',
  ])],
  ['active_dossier_deltas', new Set([
    'ref',
    'dossier_ref',
    'entity_ref',
    'field',
    'value',
    'status',
    'source_refs',
  ])],
  ['state_atlas_handles', new Set([
    'ref',
    'label',
    'kind',
    'parent_ref',
    'status',
    'source_refs',
  ])],
  ['latent_obligation_refs', new Set([
    'ref',
    'kind',
    'status',
    'due_ref',
    'due',
    'actor_refs',
    'target_refs',
    'salience',
    'source_refs',
  ])],
  ['retrieval_handles', new Set([
    'ref',
    'kind',
    'label',
    'status',
    'source_refs',
  ])],
  ['unknowns', new Set([
    'code',
    'detail',
    'refs',
    'source_refs',
  ])],
  ['omissions', new Set([
    'code',
    'detail',
    'reason',
    'refs',
    'source_refs',
  ])],
]);

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function findForbiddenKey(value, path = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = findForbiddenKey(value[index], `${path}[${index}]`);
      if (result) return result;
    }
    return null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return `${path}.${key}`;
    }
    const result = findForbiddenKey(child, `${path}.${key}`);
    if (result) return result;
  }

  return null;
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('continuity_payload_field_invalid', `${name} must be an object.`, { field: name });
  }
}

function assertAllowedKeys(value, allowedKeys, path) {
  const unknownKeys = Object.keys(value).filter(key => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    fail(
      'continuity_payload_unknown_fields',
      `Continuity Payload contains unknown fields at ${path}.`,
      { path, fields: unknownKeys },
    );
  }
}

function assertDataValue(value, path = '$', depth = 0) {
  if (depth > MAX_NESTING_DEPTH) {
    fail('continuity_payload_nesting_exceeded', 'Continuity Payload nesting is too deep.', {
      path,
      max_depth: MAX_NESTING_DEPTH,
    });
  }

  if (typeof value === 'string') {
    if (value.length > MAX_STRING_CHARS) {
      fail('continuity_payload_string_too_long', 'Continuity Payload string is too long.', {
        path,
        max_characters: MAX_STRING_CHARS,
      });
    }
    return;
  }

  if (
    value === null
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      fail('continuity_payload_array_too_large', 'Continuity Payload array is too large.', {
        path,
        max_items: MAX_ARRAY_ITEMS,
      });
    }
    value.forEach((item, index) => assertDataValue(item, `${path}[${index}]`, depth + 1));
    return;
  }

  if (!value || typeof value !== 'object') {
    fail('continuity_payload_value_invalid', 'Continuity Payload contains a non-JSON value.', {
      path,
    });
  }

  const keys = Object.keys(value);
  if (keys.length > MAX_OBJECT_KEYS) {
    fail('continuity_payload_object_too_large', 'Continuity Payload object has too many fields.', {
      path,
      max_fields: MAX_OBJECT_KEYS,
    });
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || FORBIDDEN_KEY_PATTERN.test(key)) {
      fail(
        'continuity_payload_forbidden_field',
        'Continuity Payload contains a model-visible field owned by another layer.',
        { path: `${path}.${key}` },
      );
    }
    assertDataValue(child, `${path}.${key}`, depth + 1);
  }
}

export function measureContinuityPayloadTokens(payload, { measureTokens } = {}) {
  const measuredPayload = structuredClone(payload);
  measuredPayload.budget_report ??= {};
  let estimate = 0;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    measuredPayload.budget_report.estimated_tokens = estimate;
    const serialized = JSON.stringify(measuredPayload);
    const nextEstimate = measureTokens
      ? measureTokens(serialized)
      : new TextEncoder().encode(serialized).length;
    if (!Number.isInteger(nextEstimate) || nextEstimate < 0) {
      fail(
        'continuity_payload_token_measurement_invalid',
        'Continuity Payload token measurement must return a non-negative integer.',
      );
    }
    if (nextEstimate === estimate) return estimate;
    estimate = nextEstimate;
  }

  return estimate;
}

export function validateContinuityPayload(
  payload,
  { availableInputTokens, measureTokens } = {},
) {
  // The contract's allowed run_scope fields (:45) have no run_id — only
  // active_candidate_id, which the browser side encodes as `run:${runId}`
  // (integrations/sillytavern-extension/index.js). Carry that honestly
  // under its own name rather than mislabeling it run_id (Codex re-audit
  // P1-3); id_source documents why run_id itself stays null.
  censusMark('CONTINUITY_PAYLOAD_CONTRACT', 'enter', {
    runId: null,
    candidateId: payload?.run_scope?.active_candidate_id ?? null,
    idSource: 'contract_absent',
  });
  assertObject(payload, 'payload');

  if (payload.schema !== SCHEMA) {
    fail('continuity_payload_schema_unsupported', `Expected ${SCHEMA}.`, {
      received: payload.schema ?? null,
    });
  }

  const unknownFields = Object.keys(payload).filter(key => !TOP_LEVEL_FIELDS.has(key));
  if (unknownFields.length > 0) {
    fail('continuity_payload_unknown_fields', 'Continuity Payload contains unknown top-level fields.', {
      fields: unknownFields,
    });
  }

  const forbiddenPath = findForbiddenKey(payload);
  if (forbiddenPath) {
    fail('continuity_payload_forbidden_field', 'Continuity Payload contains a model-visible field owned by another layer.', {
      path: forbiddenPath,
    });
  }

  assertObject(payload.run_scope, 'run_scope');
  assertObject(payload.active_scene, 'active_scene');
  assertObject(payload.budget_report, 'budget_report');
  for (const [field, allowedKeys] of OBJECT_FIELD_KEYS) {
    if (OPTIONAL_OBJECT_FIELDS.has(field) && payload[field] === undefined) {
      continue;
    }
    if (OPTIONAL_OBJECT_FIELDS.has(field)) {
      assertObject(payload[field], field);
    }
    assertAllowedKeys(payload[field], allowedKeys, `$.${field}`);
    assertDataValue(payload[field], `$.${field}`);
  }

  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(payload[field])) {
      fail('continuity_payload_field_invalid', `${field} must be an array.`, { field });
    }
    if (payload[field].length > MAX_ARRAY_ITEMS) {
      fail('continuity_payload_array_too_large', `${field} contains too many items.`, {
        field,
        max_items: MAX_ARRAY_ITEMS,
      });
    }
    const allowedKeys = ARRAY_ITEM_KEYS.get(field);
    payload[field].forEach((item, index) => {
      assertObject(item, `${field}[${index}]`);
      assertAllowedKeys(item, allowedKeys, `$.${field}[${index}]`);
      assertDataValue(item, `$.${field}[${index}]`);
    });
  }

  const { chat_id: chatId, branch_epoch: branchEpoch, visible_turn_index: turnIndex } = payload.run_scope;
  if (!chatId || typeof chatId !== 'string') {
    fail('continuity_payload_scope_invalid', 'run_scope.chat_id is required.');
  }
  if (!Number.isInteger(branchEpoch) || branchEpoch < 0) {
    fail('continuity_payload_scope_invalid', 'run_scope.branch_epoch must be a non-negative integer.');
  }
  if (!Number.isInteger(turnIndex) || turnIndex < 0) {
    fail('continuity_payload_scope_invalid', 'run_scope.visible_turn_index must be a non-negative integer.');
  }
  const parentTurnIndex = payload.run_scope.parent_turn_index;
  if (
    parentTurnIndex !== undefined
    && (
      !Number.isInteger(parentTurnIndex)
      || parentTurnIndex < 0
      || parentTurnIndex > turnIndex
    )
  ) {
    fail(
      'continuity_payload_scope_invalid',
      'run_scope.parent_turn_index must be a non-negative integer no later than the visible turn.',
    );
  }
  const targetTurnIndex = payload.run_scope.target_turn_index;
  if (
    targetTurnIndex !== undefined
    && (
      !Number.isInteger(targetTurnIndex)
      || targetTurnIndex < turnIndex
    )
  ) {
    fail(
      'continuity_payload_scope_invalid',
      'run_scope.target_turn_index must be a non-negative integer at or after the visible boundary.',
    );
  }

  const reportedTokens = payload.budget_report.estimated_tokens;
  const configuredHardCap = payload.budget_report.hard_cap_tokens;
  if (!Number.isInteger(reportedTokens) || reportedTokens < 0) {
    fail('continuity_payload_budget_invalid', 'budget_report.estimated_tokens must be a non-negative integer.');
  }
  if (!Number.isInteger(configuredHardCap) || configuredHardCap <= 0) {
    fail('continuity_payload_budget_invalid', 'budget_report.hard_cap_tokens must be a positive integer.');
  }

  const availableCap = Number.isFinite(availableInputTokens)
    ? Math.floor(availableInputTokens * 0.15)
    : 2400;
  const effectiveHardCap = Math.min(2400, availableCap);
  const validated = structuredClone(payload);
  validated.budget_report.measurement = measureTokens
    ? 'host_tokenizer'
    : 'utf8_byte_upper_bound';
  const measuredTokens = measureContinuityPayloadTokens(validated, { measureTokens });

  if (configuredHardCap > effectiveHardCap || measuredTokens > configuredHardCap) {
    fail('continuity_payload_budget_exceeded', 'Continuity Payload exceeds its allowed input budget.', {
      reported_estimated_tokens: reportedTokens,
      measured_tokens: measuredTokens,
      configured_hard_cap_tokens: configuredHardCap,
      effective_hard_cap_tokens: effectiveHardCap,
    });
  }

  validated.budget_report.estimated_tokens = measuredTokens;
  censusMark('CONTINUITY_PAYLOAD_CONTRACT', 'passed', {
    runId: null,
    candidateId: validated?.run_scope?.active_candidate_id ?? null,
    idSource: 'contract_absent',
  });
  return validated;
}

export function renderContinuityPayload(payload) {
  const validated = validateContinuityPayload(payload);
  return [
    `<mnemosyne-continuity-payload schema="${SCHEMA}">`,
    JSON.stringify(validated, null, 2),
    '</mnemosyne-continuity-payload>',
  ].join('\n');
}
