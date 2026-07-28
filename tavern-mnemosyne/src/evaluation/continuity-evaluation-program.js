import {
  createHmac,
  randomBytes as nodeRandomBytes,
  randomUUID as nodeRandomUUID,
} from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
} from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';

const PROTOCOL_VERSION = 'mnemosyne.real-use-continuity.v1';
const QUESTIONNAIRE_VERSION = 'mnemosyne.continuity-feedback.v1';
const RUN_ATTESTATION_SCHEMA =
  'mnemosyne.continuity-evaluation-run-attestation.v1';
const FEEDBACK_COMMAND_SCHEMA = 'mnemosyne.feedback-command.v1';
const EXPORT_REQUEST_SCHEMA =
  'mnemosyne.feedback-export-request.v1';
const EXPORT_CONSENT_SCHEMA =
  'mnemosyne.feedback-export-consent.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,255}$/;
const CONTRACT_VERSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;

const STORY_FACETS = Object.freeze([
  'character_cognition',
  'causality_and_order',
  'relationships',
  'location_items_and_state',
  'world_rules',
  'open_plot_threads',
]);
const FACET_RATINGS = new Set([
  'none',
  'minor',
  'major',
  'not_applicable',
  'cannot_judge',
  'unreported',
]);
const CONTINUITY_SEVERITIES = new Set([
  'none',
  'minor',
  'major',
  'cannot_judge',
]);
const INTERVENTIONS = new Set([
  'none',
  'edit_reply',
  'swipe_or_regenerate',
  'abandon',
  'not_yet',
  'cannot_judge',
  'unreported',
]);
const OLDER_CONTEXT_HANDLING = new Set([
  'natural',
  'omitted_needed',
  'used_wrong',
  'overexplained',
  'not_applicable',
  'cannot_judge',
  'unreported',
]);
const CONFIDENCE = new Set([
  'unreported',
  'low',
  'medium',
  'high',
]);
const CONFOUNDERS = new Set([
  'model_or_preset_changed',
  'history_or_swipe_changed',
  'generation_failed_or_truncated',
  'user_prompt_dominated',
  'other',
]);
const KNOWN_TOOLS = new Set([
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
const RECORD_KINDS = new Set([
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
const STORY_COVERAGE_FACETS = new Set([
  'character',
  'character_cognition',
  'relationship',
  'scene_event',
  'world_lore',
  'plot_thread',
  'scene_state',
  'attribute_value',
  'current_state',
]);
const NOT_PROVEN = Object.freeze([
  'old_fact_outside_recent_strip',
  'semantic_completeness',
  'continuation_causally_used_retrieved_evidence',
  'real_clean_store_replay',
  'creative_quality_improvement',
  'M-D1_complete',
]);
const EXPORT_MISSINGNESS_RULES = deepFreeze({
  not_applicable: 'preserved',
  cannot_judge: 'preserved',
  unreported: 'preserved',
  nonresponse: 'not_in_record_rows',
});
const EXPORT_OMITTED_FIELDS = Object.freeze([
  'story_text',
  'prompt_text',
  'search_query',
  'memory_snippet',
  'memory_ref',
  'continuation_cursor',
  'source_ref',
  'raw_chat_id',
  'raw_run_id',
  'raw_turn_id',
  'raw_candidate_id',
  'raw_feedback_id',
  'content_hashes',
  'exact_timestamps',
  'model_name',
  'free_text',
]);

const QUESTIONNAIRE = deepFreeze({
  schema: QUESTIONNAIRE_VERSION,
  version: QUESTIONNAIRE_VERSION,
  language: 'zh-CN',
  primary_outcome: 'continuity_severity',
  measurement_note:
    'Answers are categorical or ordinal; missing, not-applicable, and cannot-judge remain distinct.',
  free_text: 'forbidden',
  facets: [...STORY_FACETS],
  fields: {
    reviewed_reply: ['yes', 'no', 'cannot_judge'],
    continuity_severity: [...CONTINUITY_SEVERITIES],
    facet_rating: [...FACET_RATINGS],
    intervention: [...INTERVENTIONS],
    older_context_handling: [...OLDER_CONTEXT_HANDLING],
    confidence: [...CONFIDENCE],
    confounders: ['unreported', ...CONFOUNDERS],
  },
  presentation: {
    schema:
      'mnemosyne.continuity-feedback-presentation.v1',
    language: 'zh-CN',
    prompt: '这次回复的剧情连续性如何？',
    facet_prompt: '如果有问题，主要涉及哪一类？',
    facets: [{
      value: 'character_cognition',
      label: '人物知情与认知',
    }, {
      value: 'causality_and_order',
      label: '因果与先后顺序',
    }, {
      value: 'relationships',
      label: '人物关系',
    }, {
      value: 'location_items_and_state',
      label: '位置、物品与状态',
    }, {
      value: 'world_rules',
      label: '世界规则',
    }, {
      value: 'open_plot_threads',
      label: '未结剧情线',
    }],
    quick_answers: [{
      value: 'continuity_ok',
      label: '没有发现问题',
      requires_facet: false,
      strategy: 'all_clear',
    }, {
      value: 'continuity_minor',
      label: '有轻微问题',
      requires_facet: true,
      strategy: 'single_facet_minor',
    }, {
      value: 'continuity_major',
      label: '有严重问题',
      requires_facet: true,
      strategy: 'single_facet_major',
    }, {
      value: 'cannot_judge',
      label: '无法判断',
      requires_facet: false,
      strategy: 'unjudgeable',
    }, {
      value: 'not_reviewed',
      label: '没有认真看',
      requires_facet: false,
      strategy: 'not_reviewed',
    }],
  },
});

const QUESTIONNAIRE_HASH = sha256(canonicalJson(QUESTIONNAIRE));

const PROTOCOL = deepFreeze({
  schema: 'mnemosyne.continuity-evaluation-protocol.v1',
  protocol_id: 'real-use-continuity',
  version: PROTOCOL_VERSION,
  study_design: 'observational_single_arm',
  assignment: 'none',
  causal_claim_allowed: false,
  primary_outcome: 'continuity_severity',
  questionnaire_version: QUESTIONNAIRE_VERSION,
  questionnaire_hash: QUESTIONNAIRE_HASH,
  response_storage: 'local_only',
  automatic_upload: false,
  free_text: false,
  retention_policy: 'chat_save_lifetime',
  withdrawal: 'logical_exclusion',
  export_policy: 'explicit_deidentified_local_bundle',
  analysis_constraints: {
    repeated_observations_are_not_independent: true,
    missing_not_applicable_and_cannot_judge_are_distinct: true,
    ordinal_answers_are_not_averaged_by_default: true,
  },
  not_proven: [...NOT_PROVEN],
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

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

function assertExactKeys(value, expected, field) {
  if (!isPlainObject(value)) {
    fail('feedback_input_invalid', `${field} must be an object.`, {
      field,
    });
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(required)) {
    fail('feedback_input_invalid', `${field} has unsupported fields.`, {
      field,
      expected_fields: required,
    });
  }
}

function assertSafeId(value, field) {
  if (
    typeof value !== 'string'
    || value.length > 256
    || !SAFE_ID_PATTERN.test(value)
  ) {
    fail('feedback_input_invalid', `${field} is invalid.`, { field });
  }
}

function assertOpaqueChatId(value, field = 'chat_id') {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 2048
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail('feedback_input_invalid', `${field} is invalid.`, { field });
  }
}

function assertHash(value, field) {
  if (!HASH_PATTERN.test(value ?? '')) {
    fail('feedback_input_invalid', `${field} is invalid.`, { field });
  }
}

function assertEnum(value, allowed, field) {
  if (!allowed.has(value)) {
    fail('feedback_input_invalid', `${field} is invalid.`, { field });
  }
}

function nowIso(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('Continuity Evaluation clock must return a Date.');
  }
  return value.toISOString();
}

function buildRunAttestation({
  runtimeBuildId,
  runtimeBuildIdSource,
}) {
  if (
    typeof runtimeBuildId !== 'string'
    || !BUILD_ID_PATTERN.test(runtimeBuildId)
  ) {
    throw new TypeError('runtimeBuildId must be a non-empty string.');
  }
  if (
    ![
      'configured',
      'source_manifest',
      'package_version',
    ].includes(runtimeBuildIdSource)
  ) {
    throw new TypeError(
      'runtimeBuildIdSource must be configured, source_manifest, or package_version.',
    );
  }
  const unsigned = {
    schema: RUN_ATTESTATION_SCHEMA,
    protocol_version: PROTOCOL_VERSION,
    runtime_build_id: runtimeBuildId,
    runtime_build_id_source: runtimeBuildIdSource,
    memory_condition: {
      condition_id: 'typed_state_progressive_retrieval.v1',
      continuity_payload: 'bounded',
      memory_search_read: 'available',
      writeback: 'required',
      output_isolation: 'production_committed',
    },
    study_design: 'observational_single_arm',
    causal_arm: false,
  };
  return deepFreeze({
    ...unsigned,
    attestation_hash: sha256(canonicalJson(unsigned)),
  });
}

function validateRunAttestation(journal, expected) {
  const actual = journal?.run_evidence?.continuity_evaluation;
  if (
    actual?.schema !== RUN_ATTESTATION_SCHEMA
    || canonicalJson(actual) !== canonicalJson(expected)
  ) {
    fail(
      'real_use_condition_attestation_invalid',
      'The completed run lacks the sealed evaluation condition attestation.',
    );
  }
  const { attestation_hash: ignored, ...unsigned } = actual;
  if (sha256(canonicalJson(unsigned)) !== actual.attestation_hash) {
    fail(
      'real_use_condition_attestation_invalid',
      'The run evaluation condition attestation is not intact.',
    );
  }
}

function evaluationTableColumns(database, tableName) {
  return new Set(database.prepare(
    `PRAGMA table_info(${tableName})`,
  ).all().map(column => column.name));
}

function initializeEvaluationDatabase(database, timestamp) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS evaluation_protocols (
      protocol_version TEXT PRIMARY KEY,
      definition_json TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      sealed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evaluation_questionnaires (
      questionnaire_version TEXT PRIMARY KEY,
      definition_json TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      sealed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evaluation_cases (
      case_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      branch_epoch INTEGER NOT NULL,
      turn_index INTEGER NOT NULL,
      swipe_id INTEGER NOT NULL,
      receipt_json TEXT NOT NULL,
      receipt_hash TEXT NOT NULL,
      journal_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evaluation_commands (
      command_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evaluation_responses (
      feedback_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL UNIQUE
        REFERENCES evaluation_cases(case_id),
      questionnaire_version TEXT NOT NULL,
      questionnaire_hash TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      feedback_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      withdrawn_at TEXT
    );
    CREATE TABLE IF NOT EXISTS evaluation_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      case_id TEXT,
      feedback_id TEXT,
      payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evaluation_exports (
      export_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      evidence_state_hash TEXT NOT NULL,
      pseudonym_key TEXT NOT NULL,
      bundle_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const responseColumns = evaluationTableColumns(
    database,
    'evaluation_responses',
  );
  if (!responseColumns.has('questionnaire_hash')) {
    database.exec(`
      ALTER TABLE evaluation_responses
      ADD COLUMN questionnaire_hash TEXT
    `);
  }
  const unsealedResponse = database.prepare(`
    SELECT feedback_id
    FROM evaluation_responses
    WHERE questionnaire_hash IS NULL
    LIMIT 1
  `).get();
  if (unsealedResponse) {
    fail(
      'evaluation_questionnaire_drift',
      'An existing feedback response has no sealed questionnaire.',
    );
  }
  const exportColumns = evaluationTableColumns(
    database,
    'evaluation_exports',
  );
  if (!exportColumns.has('chat_id')) {
    database.exec(`
      ALTER TABLE evaluation_exports
      ADD COLUMN chat_id TEXT
    `);
  }
  if (!exportColumns.has('evidence_state_hash')) {
    database.exec(`
      ALTER TABLE evaluation_exports
      ADD COLUMN evidence_state_hash TEXT
    `);
  }
  if (!exportColumns.has('pseudonym_key')) {
    database.exec(`
      ALTER TABLE evaluation_exports
      ADD COLUMN pseudonym_key TEXT
    `);
  }
  const protocolJson = canonicalJson(PROTOCOL);
  const protocolHash = sha256(protocolJson);
  database.prepare(`
    INSERT OR IGNORE INTO evaluation_protocols (
      protocol_version,
      definition_json,
      definition_hash,
      sealed_at
    ) VALUES (?, ?, ?, ?)
  `).run(PROTOCOL_VERSION, protocolJson, protocolHash, timestamp);
  const existing = database.prepare(`
    SELECT definition_json, definition_hash
    FROM evaluation_protocols
    WHERE protocol_version = ?
  `).get(PROTOCOL_VERSION);
  if (
    existing?.definition_json !== protocolJson
    || existing?.definition_hash !== protocolHash
  ) {
    fail(
      'evaluation_protocol_drift',
      'The sealed evaluation protocol differs from this runtime.',
    );
  }
  const questionnaireJson = canonicalJson(QUESTIONNAIRE);
  database.prepare(`
    INSERT OR IGNORE INTO evaluation_questionnaires (
      questionnaire_version,
      definition_json,
      definition_hash,
      sealed_at
    ) VALUES (?, ?, ?, ?)
  `).run(
    QUESTIONNAIRE_VERSION,
    questionnaireJson,
    QUESTIONNAIRE_HASH,
    timestamp,
  );
  const existingQuestionnaire = database.prepare(`
    SELECT definition_json, definition_hash
    FROM evaluation_questionnaires
    WHERE questionnaire_version = ?
  `).get(QUESTIONNAIRE_VERSION);
  if (
    existingQuestionnaire?.definition_json !== questionnaireJson
    || existingQuestionnaire?.definition_hash
      !== QUESTIONNAIRE_HASH
  ) {
    fail(
      'evaluation_questionnaire_drift',
      'The sealed evaluation questionnaire differs from this runtime.',
    );
  }
}

async function openEvaluationDatabase({ store, chatId, now }) {
  const opened = await store.openChatForAdmin({ chatId });
  const evaluationDirectory = path.join(
    opened.chat_save_path,
    'evaluation',
  );
  await mkdir(evaluationDirectory, {
    recursive: true,
    mode: 0o700,
  });
  await chmod(evaluationDirectory, 0o700);
  const evaluationPath = path.join(
    evaluationDirectory,
    'continuity-evidence.sqlite',
  );
  const evaluationHandle = await open(
    evaluationPath,
    'a',
    0o600,
  );
  await evaluationHandle.close();
  await chmod(evaluationPath, 0o600);
  const database = new DatabaseSync(evaluationPath);
  try {
    initializeEvaluationDatabase(database, nowIso(now));
    for (const filePath of [
      evaluationPath,
      `${evaluationPath}-wal`,
      `${evaluationPath}-shm`,
    ]) {
      try {
        await chmod(filePath, 0o600);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    database.close();
    throw error;
  }
  return { database, opened, evaluationPath };
}

function readGovernanceBinding(opened, {
  chatId,
  runId,
  turnId,
  candidateId,
  branchId,
  branchEpoch,
  turnIndex,
  swipeId,
}) {
  const database = new DatabaseSync(opened.ledger_path, {
    readOnly: true,
  });
  try {
    const row = database.prepare(`
      SELECT
        t.chat_id,
        t.run_id AS turn_run_id,
        t.turn_id,
        t.turn_index,
        t.branch_id,
        t.branch_epoch,
        t.status AS turn_status,
        c.candidate_id,
        c.run_id AS candidate_run_id,
        c.swipe_id,
        c.status AS candidate_status,
        c.patch_id,
        p.status AS patch_status,
        b.status AS branch_status
      FROM turns AS t
      JOIN turn_candidates AS c
        ON c.turn_id = t.turn_id
      LEFT JOIN patches AS p
        ON p.patch_id = c.patch_id
      JOIN branch_epochs AS b
        ON b.chat_id = t.chat_id
        AND b.branch_id = t.branch_id
        AND b.branch_epoch = t.branch_epoch
      WHERE
        t.chat_id = ?
        AND t.turn_id = ?
        AND c.candidate_id = ?
    `).get(chatId, turnId, candidateId);
    if (!row) {
      const governedTurn = database.prepare(`
        SELECT run_id
        FROM turns
        WHERE chat_id = ? AND turn_id = ?
      `).get(chatId, turnId);
      if (governedTurn) {
        fail(
          'real_use_run_scope_mismatch',
          'The run journal and governance ledger identities differ.',
        );
      }
      fail(
        'real_use_run_not_governed',
        'The completed run is not bound to governed history.',
      );
    }
    const exact = (
      row.chat_id === chatId
      && row.turn_run_id === runId
      && row.candidate_run_id === runId
      && row.turn_id === turnId
      && row.candidate_id === candidateId
      && row.branch_id === branchId
      && Number(row.branch_epoch) === branchEpoch
      && Number(row.turn_index) === turnIndex
      && Number(row.swipe_id) === swipeId
    );
    if (!exact) {
      fail(
        'real_use_run_scope_mismatch',
        'The run journal and governance ledger identities differ.',
      );
    }
    if (
      row.candidate_status !== 'active'
      || row.branch_status !== 'active'
    ) {
      fail(
        'real_use_candidate_unavailable',
        'The evaluated reply is no longer the active governed candidate.',
      );
    }
    if (
      row.turn_status !== 'committed'
      || row.patch_status !== 'applied'
    ) {
      fail(
        'real_use_run_not_governed',
        'The run does not have an applied governed turn.',
      );
    }
    return {
      patch_id: row.patch_id,
      candidate_status: row.candidate_status,
      branch_status: row.branch_status,
    };
  } finally {
    database.close();
  }
}

const GOVERNANCE_INVALIDATION_REASON_CODES = new Set([
  'real_use_candidate_unavailable',
  'real_use_run_scope_mismatch',
  'real_use_run_not_governed',
]);

function isGovernanceInvalidation(error) {
  return GOVERNANCE_INVALIDATION_REASON_CODES.has(
    error?.reasonCode,
  );
}

function invalidatePreparedCase(database, {
  caseId,
  reasonCode,
  timestamp,
  randomUUID,
}) {
  return withTransaction(database, () => {
    const updated = database.prepare(`
      UPDATE evaluation_cases
      SET status = 'invalidated'
      WHERE case_id = ? AND status = 'prepared'
    `).run(caseId);
    if (Number(updated.changes) === 0) return false;
    database.prepare(`
      INSERT INTO evaluation_events (
        event_id,
        event_type,
        case_id,
        feedback_id,
        payload_hash,
        created_at
      ) VALUES (?, 'case_invalidated', ?, NULL, ?, ?)
    `).run(
      `event_${randomUUID()}`,
      caseId,
      sha256(reasonCode),
      timestamp,
    );
    return true;
  });
}

function invalidatePreparedRun(database, {
  runId,
  reasonCode,
  timestamp,
  randomUUID,
}) {
  const cases = database.prepare(`
    SELECT case_id
    FROM evaluation_cases
    WHERE run_id = ? AND status = 'prepared'
  `).all(runId);
  for (const evaluationCase of cases) {
    invalidatePreparedCase(database, {
      caseId: evaluationCase.case_id,
      reasonCode,
      timestamp,
      randomUUID,
    });
  }
  return cases.length;
}

function reconcilePreparedCases({
  database,
  opened,
  chatId,
  now,
  randomUUID,
}) {
  const cases = database.prepare(`
    SELECT
      case_id,
      chat_id,
      run_id,
      turn_id,
      candidate_id,
      branch_id,
      branch_epoch,
      turn_index,
      swipe_id
    FROM evaluation_cases
    WHERE chat_id = ? AND status = 'prepared'
    ORDER BY created_at, case_id
  `).all(chatId);
  let invalidatedCount = 0;
  for (const evaluationCase of cases) {
    try {
      readGovernanceBinding(opened, {
        chatId: evaluationCase.chat_id,
        runId: evaluationCase.run_id,
        turnId: evaluationCase.turn_id,
        candidateId: evaluationCase.candidate_id,
        branchId: evaluationCase.branch_id,
        branchEpoch: Number(evaluationCase.branch_epoch),
        turnIndex: Number(evaluationCase.turn_index),
        swipeId: Number(evaluationCase.swipe_id),
      });
    } catch (error) {
      if (!isGovernanceInvalidation(error)) throw error;
      if (invalidatePreparedCase(database, {
        caseId: evaluationCase.case_id,
        reasonCode: error.reasonCode,
        timestamp: nowIso(now),
        randomUUID,
      })) {
        invalidatedCount += 1;
      }
    }
  }
  return invalidatedCount;
}

function readCoverage(event) {
  const coverage = event?.result?.coverage;
  if (!coverage) {
    return {
      requested: [],
      represented: [],
      missing: [],
    };
  }
  if (coverage.schema !== 'mnemosyne.story-coverage.v1') {
    fail(
      'real_use_extractor_unsupported',
      'The run contains an unsupported coverage receipt.',
    );
  }
  const values = {
    requested: coverage.requested_facets,
    represented: coverage.represented_facets,
    missing: coverage.missing_facets,
  };
  for (const [field, facets] of Object.entries(values)) {
    if (
      !Array.isArray(facets)
      || facets.some(facet => !STORY_COVERAGE_FACETS.has(facet))
    ) {
      fail(
        'real_use_extractor_unsupported',
        'The run coverage receipt contains unsupported facets.',
        { field },
      );
    }
  }
  return values;
}

function addCounts(target, values) {
  for (const value of values) {
    target[value] = (target[value] ?? 0) + 1;
  }
}

function sortedCountObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (
      left.localeCompare(right)
    )),
  );
}

function deriveObjectiveMetrics(journal) {
  if (!Array.isArray(journal.events)) {
    fail(
      'real_use_extractor_unsupported',
      'The completed run has no supported event list.',
    );
  }
  const events = journal.events;
  const toolSequence = [];
  const toolCounts = {};
  const reasonCodeCounts = {};
  const recordKindCounts = {};
  const coverage = {
    requested: new Set(),
    represented: new Set(),
    missing: new Set(),
  };
  const issuedCursors = new Set();
  const startedWritebacks = new Map();
  let cursorConsumedCount = 0;
  let cursorIssuedCount = 0;
  let searchResultCount = 0;
  let memoryReadEntryCount = 0;
  let memoryReadPageCount = 0;
  let storyCommitCount = 0;
  let completedWritebackCount = 0;
  let lockedCommitId = null;

  for (const journalEvent of events) {
    let event = journalEvent;
    if (!isPlainObject(event)) {
      fail(
        'real_use_extractor_unsupported',
        'The run contains an invalid journal event.',
      );
    }
    if (event.type === 'model_step_rejected') {
      if (
        event.tool !== 'main_ai_tool_protocol'
        || event.reason_code !== 'main_ai_tool_protocol_invalid'
        || !Number.isSafeInteger(event.tool_call_count)
        || event.tool_call_count < 1
        || !Array.isArray(event.tool_names)
        || event.tool_names.length !== event.tool_call_count
        || event.tool_names.some(name => (
          typeof name !== 'string'
          || !name
        ))
      ) {
        fail(
          'real_use_extractor_unsupported',
          'The run contains an unsupported model-step rejection.',
        );
      }
      reasonCodeCounts[event.reason_code] =
        (reasonCodeCounts[event.reason_code] ?? 0) + 1;
      continue;
    }
    if (event.type === 'tool_started') {
      if (
        event.tool !== 'memory_write_turn_delta'
        || typeof event.call_id !== 'string'
        || !event.call_id
        || !isPlainObject(event.arguments)
        || !Array.isArray(event.arguments.records)
        || !['changed', 'no_change'].includes(
          event.arguments.mode,
        )
        || event.arguments.records.some(
          record => !RECORD_KINDS.has(record?.kind),
        )
        || !HASH_PATTERN.test(event.arguments_hash ?? '')
        || event.arguments_hash
          !== sha256(canonicalJson(event.arguments))
        || event.result !== null
        || event.result_hash !== null
        || event.error !== null
        || startedWritebacks.has(event.call_id)
      ) {
        fail(
          'real_use_extractor_unsupported',
          'The run contains an unsupported tool lifecycle event.',
        );
      }
      startedWritebacks.set(event.call_id, event.arguments);
      continue;
    }
    const recoveredWriteback =
      event.type === 'writeback_recovered';
    if (event.type === 'writeback_recovered') {
      const started = startedWritebacks.get(event.call_id);
      if (
        event.tool !== 'memory_write_turn_delta'
        || !started
        || !isPlainObject(event.result)
        || event.result.status !== 'applied'
        || !HASH_PATTERN.test(event.result_hash ?? '')
        || event.result_hash !== sha256(canonicalJson(event.result))
      ) {
        fail(
          'real_use_extractor_unsupported',
          'The run contains an unsupported recovered writeback.',
        );
      }
      startedWritebacks.delete(event.call_id);
      event = {
        ...event,
        type: 'tool_completed',
        arguments: started,
        error: null,
      };
    }
    if (!KNOWN_TOOLS.has(event?.tool)) {
      fail(
        'real_use_extractor_unsupported',
        'The run contains an unsupported tool event.',
      );
    }
    if (!['tool_completed', 'tool_rejected'].includes(event.type)) {
      fail(
        'real_use_extractor_unsupported',
        'The run contains an unsupported tool-event state.',
      );
    }
    if (
      typeof event.call_id !== 'string'
      || !event.call_id
      || (
        event.type === 'tool_completed'
          ? !isPlainObject(event.arguments)
          : !isJsonValue(event.arguments)
      )
      || (
        !recoveredWriteback
        && (
          !HASH_PATTERN.test(event.arguments_hash ?? '')
          || event.arguments_hash
            !== sha256(canonicalJson(event.arguments))
        )
      )
      || (
        event.type === 'tool_completed'
        && (
          !isPlainObject(event.result)
          || !HASH_PATTERN.test(event.result_hash ?? '')
          || event.result_hash
            !== sha256(canonicalJson(event.result))
          || event.error !== null
        )
      )
      || (
        event.type === 'tool_rejected'
        && (
          event.result !== null
          || event.result_hash !== null
          || !isPlainObject(event.error)
        )
      )
    ) {
      fail(
        'real_use_extractor_unsupported',
        'The run contains an unsealed tool event.',
      );
    }
    if (
      event.tool === 'memory_write_turn_delta'
      && !recoveredWriteback
      && !startedWritebacks.has(event.call_id)
    ) {
      fail(
        'real_use_extractor_unsupported',
        'The writeback event has no sealed lifecycle start.',
      );
    }
    if (
      event.tool === 'memory_write_turn_delta'
      && startedWritebacks.has(event.call_id)
    ) {
      const started = startedWritebacks.get(event.call_id);
      if (canonicalJson(started) !== canonicalJson(event.arguments)) {
        fail(
          'real_use_extractor_unsupported',
          'The completed writeback does not match its lifecycle event.',
        );
      }
      startedWritebacks.delete(event.call_id);
    }
    const status = event.type === 'tool_completed'
      ? 'completed'
      : 'rejected';
    toolSequence.push({ tool: event.tool, status });
    toolCounts[event.tool] = (toolCounts[event.tool] ?? 0) + 1;
    if (status === 'rejected') {
      const allowedReasonCodes =
        REJECTION_REASON_CODES_BY_TOOL.get(event.tool);
      if (
        !isPlainObject(event.error)
        || !allowedReasonCodes?.has(event.error.reason_code)
      ) {
        fail(
          'real_use_extractor_unsupported',
          'The run contains an unsupported reason code.',
        );
      }
      reasonCodeCounts[event.error.reason_code] =
        (reasonCodeCounts[event.error.reason_code] ?? 0) + 1;
    } else if (event.error !== null) {
      fail(
        'real_use_extractor_unsupported',
        'The completed tool event contains an error.',
      );
    }
    if (event.tool === 'memory_search' && status === 'completed') {
      const results = event?.result?.results;
      if (
        event.result?.schema
          !== 'mnemosyne.memory-search-result.v2'
        || event.result.status !== 'ready'
        || !Array.isArray(results)
      ) {
        fail(
          'real_use_extractor_unsupported',
          'The memory search result shape is unsupported.',
        );
      }
      searchResultCount += results.length;
      const extracted = readCoverage(event);
      for (const facet of extracted.requested) {
        coverage.requested.add(facet);
      }
      for (const facet of extracted.represented) {
        coverage.represented.add(facet);
        coverage.missing.delete(facet);
      }
      for (const facet of extracted.missing) {
        if (!coverage.represented.has(facet)) {
          coverage.missing.add(facet);
        }
      }
    }
    if (event.tool === 'memory_read' && status === 'completed') {
      memoryReadPageCount += 1;
      const entries = event?.result?.entries;
      if (
        event.result?.schema
          !== 'mnemosyne.memory-context-pack.v2'
        || !Array.isArray(entries)
      ) {
        fail(
          'real_use_extractor_unsupported',
          'The memory read result shape is unsupported.',
        );
      }
      memoryReadEntryCount += entries.length;
      const cursors = event?.result?.continuation_cursors ?? [];
      if (!Array.isArray(cursors)) {
        fail(
          'real_use_extractor_unsupported',
          'The memory continuation result shape is unsupported.',
        );
      }
      const refs = event?.arguments?.refs ?? [];
      if (Array.isArray(refs)) {
        for (const ref of refs) {
          if (issuedCursors.has(ref)) cursorConsumedCount += 1;
        }
      }
      for (const cursor of cursors) {
        if (typeof cursor === 'string') {
          cursorIssuedCount += 1;
          issuedCursors.add(cursor);
        }
      }
    }
    if (event.tool === 'story_commit' && status === 'completed') {
      if (
        event.result.status !== 'locked'
        || typeof event.result.commit_id !== 'string'
        || !event.result.commit_id
        || !HASH_PATTERN.test(event.result.body_hash ?? '')
        || !Number.isSafeInteger(event.result.byte_length)
        || event.result.byte_length < 1
        || event.result.span_map_version !== 1
        || storyCommitCount !== 0
      ) {
        fail(
          'real_use_extractor_unsupported',
          'The run contains an unsupported story commit.',
        );
      }
      storyCommitCount += 1;
      lockedCommitId = event.result.commit_id;
    }
    if (
      event.tool === 'memory_write_turn_delta'
      && status === 'completed'
    ) {
      const records = event?.arguments?.records ?? [];
      if (
        storyCommitCount !== 1
        || event.arguments.commit_id !== lockedCommitId
        || event.result?.status !== 'applied'
        || !['changed', 'no_change'].includes(
          event.arguments.mode,
        )
        || !Array.isArray(records)
      ) {
        fail(
          'real_use_extractor_unsupported',
          'The memory writeback record shape is unsupported.',
        );
      }
      completedWritebackCount += 1;
      addCounts(
        recordKindCounts,
        records.map(record => {
          if (!RECORD_KINDS.has(record?.kind)) {
            fail(
              'real_use_extractor_unsupported',
              'The run contains an unsupported writeback record kind.',
            );
          }
          return record.kind;
        }),
      );
    }
  }
  if (startedWritebacks.size > 0) {
    fail(
      'real_use_extractor_unsupported',
      'The run contains an unsettled writeback lifecycle event.',
    );
  }
  if (
    storyCommitCount !== 1
    || completedWritebackCount !== 1
  ) {
    fail(
      'real_use_extractor_unsupported',
      'The completed run lacks one settled story commit and writeback.',
    );
  }

  const writebackMode = journal?.result?.writeback?.mode ?? null;
  if (!['changed', 'no_change'].includes(writebackMode)) {
    fail(
      'real_use_extractor_unsupported',
      'The run contains an unsupported writeback mode.',
    );
  }
  const finalWritebackEvent = [...events].reverse().find(event => (
    (
      event.type === 'tool_completed'
      || event.type === 'writeback_recovered'
    )
    && event.tool === 'memory_write_turn_delta'
  ));
  const finalWritebackArguments = (
    finalWritebackEvent?.arguments
    ?? events.find(event => (
      event.type === 'tool_started'
      && event.call_id === finalWritebackEvent?.call_id
    ))?.arguments
  );
  if (finalWritebackArguments?.mode !== writebackMode) {
    fail(
      'real_use_extractor_unsupported',
      'The final writeback mode does not match its lifecycle.',
    );
  }
  const promptTokens = Number(
    journal?.aggregate_usage?.prompt_tokens ?? 0,
  );
  const completionTokens = Number(
    journal?.aggregate_usage?.completion_tokens ?? 0,
  );
  if (
    !Number.isSafeInteger(promptTokens)
    || promptTokens < 0
    || !Number.isSafeInteger(completionTokens)
    || completionTokens < 0
  ) {
    fail(
      'real_use_extractor_unsupported',
      'The run contains unsupported usage evidence.',
    );
  }

  return {
    tool_sequence: toolSequence,
    tool_counts: sortedCountObject(toolCounts),
    rejected_reason_code_counts:
      sortedCountObject(reasonCodeCounts),
    search_result_count: searchResultCount,
    memory_read_entry_count: memoryReadEntryCount,
    memory_read_page_count: memoryReadPageCount,
    continuation_cursors_issued_count: cursorIssuedCount,
    continuation_cursors_consumed_count: cursorConsumedCount,
    coverage: {
      requested_facets: [...coverage.requested].sort(),
      represented_facets: [...coverage.represented].sort(),
      missing_facets: [...coverage.requested]
        .filter(facet => !coverage.represented.has(facet))
        .sort(),
    },
    writeback_mode: writebackMode,
    writeback_record_kind_counts:
      sortedCountObject(recordKindCounts),
    aggregate_usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    },
    output_bytes: Buffer.byteLength(
      String(journal?.result?.final_body ?? ''),
      'utf8',
    ),
    dynamic_projection_ready:
      journal?.result?.projection?.status === 'ready',
  };
}

function validateCompletedJournal(journal, {
  chatId,
  runId,
  runAttestation,
}) {
  if (
    journal?.schema !== 'mnemosyne.run-journal.v1'
    || journal.chat_id !== chatId
    || journal.run_id !== runId
  ) {
    fail(
      'real_use_run_scope_mismatch',
      'The run journal identity is invalid.',
    );
  }
  if (
    journal.state !== 'completed'
    || journal.pending_writeback !== null
    || journal?.result?.schema !== 'mnemosyne.root-turn-result.v1'
    || journal?.result?.status !== 'completed'
  ) {
    fail(
      'real_use_run_incomplete',
      'Only a fully completed governed run can be evaluated.',
    );
  }
  const scope = journal.run_scope;
  if (!isPlainObject(scope)) {
    fail(
      'real_use_run_scope_mismatch',
      'The run journal lacks a governed run scope.',
    );
  }
  const normalized = {
    chatId: scope.chat_id,
    runId: scope.run_id,
    turnId: scope.turn_id,
    candidateId: scope.candidate_id,
    branchId: scope.branch_id,
    branchEpoch: scope.branch_epoch,
    turnIndex: scope.turn_index,
    swipeId: scope.swipe_id,
  };
  if (
    normalized.chatId !== chatId
    || normalized.runId !== runId
    || !Number.isSafeInteger(normalized.branchEpoch)
    || normalized.branchEpoch < 0
    || !Number.isSafeInteger(normalized.turnIndex)
    || normalized.turnIndex < 0
    || !Number.isSafeInteger(normalized.swipeId)
    || normalized.swipeId < 0
  ) {
    fail(
      'real_use_run_scope_mismatch',
      'The run journal scope is invalid.',
    );
  }
  for (const [field, value] of Object.entries({
    run_id: normalized.runId,
    turn_id: normalized.turnId,
    candidate_id: normalized.candidateId,
    branch_id: normalized.branchId,
  })) {
    if (
      typeof value !== 'string'
      || value.length > 256
      || !SAFE_ID_PATTERN.test(value)
    ) {
      fail(
        'real_use_run_scope_mismatch',
        'The run journal scope is invalid.',
        { field },
      );
    }
  }
  validateRunAttestation(journal, runAttestation);
  if (
    !CONTRACT_VERSION_PATTERN.test(
      journal.retrieval_contract_version ?? '',
    )
  ) {
    fail(
      'real_use_extractor_unsupported',
      'The run contains an unsupported retrieval contract version.',
    );
  }
  return normalized;
}

function buildReceipt({
  journal,
  scope,
  governance,
  runAttestation,
}) {
  const unsigned = {
    schema: 'mnemosyne.run-evidence-receipt.v1',
    protocol_version: PROTOCOL_VERSION,
    protocol_hash: sha256(canonicalJson(PROTOCOL)),
    questionnaire_version: QUESTIONNAIRE_VERSION,
    questionnaire_hash: QUESTIONNAIRE_HASH,
    extractor_version: 'mnemosyne.run-evidence-extractor.v1',
    study_design: 'observational_single_arm',
    enrollment: 'voluntary_manual',
    causal_claim_allowed: false,
    md1_exit_decision: 'not_evaluated',
    not_proven: [...NOT_PROVEN],
    binding: {
      chat_id: scope.chatId,
      run_id: scope.runId,
      turn_id: scope.turnId,
      candidate_id: scope.candidateId,
      branch_id: scope.branchId,
      branch_epoch: scope.branchEpoch,
      turn_index: scope.turnIndex,
      swipe_id: scope.swipeId,
      candidate_status: governance.candidate_status,
      branch_status: governance.branch_status,
      governed_patch_present: Boolean(governance.patch_id),
    },
    runtime: {
      build_id: runAttestation.runtime_build_id,
      build_id_source: runAttestation.runtime_build_id_source,
      memory_condition_id:
        runAttestation.memory_condition.condition_id,
      condition_attestation_hash:
        runAttestation.attestation_hash,
      retrieval_contract_version:
        journal.retrieval_contract_version,
      model_fingerprint: journal.model
        ? sha256(String(journal.model))
        : null,
    },
    objective_metrics: deriveObjectiveMetrics(journal),
    provenance: {
      binding: 'trusted_run_journal_and_governance_ledger',
      runtime: 'trusted_run_attestation',
      objective_metrics: 'derived_allowlist',
    },
  };
  return {
    ...unsigned,
    receipt_hash: sha256(canonicalJson(unsigned)),
  };
}

function validateAnswers(answers) {
  if (
    isPlainObject(answers)
    && Object.keys(answers).some(key => (
      ['comment', 'notes', 'free_text', 'correction'].includes(key)
    ))
  ) {
    fail(
      'feedback_text_forbidden',
      'Free-text feedback is not accepted by this protocol.',
    );
  }
  assertExactKeys(answers, [
    'reviewed_reply',
    'continuity_severity',
    'facet_ratings',
    'intervention',
    'older_context_handling',
    'confidence',
    'confounders',
  ], 'answers');
  assertEnum(
    answers.reviewed_reply,
    new Set(['yes', 'no', 'cannot_judge']),
    'answers.reviewed_reply',
  );
  assertEnum(
    answers.continuity_severity,
    CONTINUITY_SEVERITIES,
    'answers.continuity_severity',
  );
  assertExactKeys(
    answers.facet_ratings,
    STORY_FACETS,
    'answers.facet_ratings',
  );
  for (const facet of STORY_FACETS) {
    assertEnum(
      answers.facet_ratings[facet],
      FACET_RATINGS,
      `answers.facet_ratings.${facet}`,
    );
  }
  assertEnum(
    answers.intervention,
    INTERVENTIONS,
    'answers.intervention',
  );
  assertEnum(
    answers.older_context_handling,
    OLDER_CONTEXT_HANDLING,
    'answers.older_context_handling',
  );
  assertEnum(
    answers.confidence,
    CONFIDENCE,
    'answers.confidence',
  );
  const confoundersUnreported =
    answers.confounders === 'unreported';
  const reportedConfounders = (
    Array.isArray(answers.confounders)
    && answers.confounders.every(value => CONFOUNDERS.has(value))
    && new Set(answers.confounders).size
      === answers.confounders.length
  );
  if (!confoundersUnreported && !reportedConfounders) {
    fail(
      'feedback_input_invalid',
      'answers.confounders is invalid.',
      { field: 'answers.confounders' },
    );
  }
  const ratings = Object.values(answers.facet_ratings);
  if (
    answers.reviewed_reply !== 'yes'
    && (
      answers.continuity_severity !== 'cannot_judge'
      || ratings.some(rating => rating !== 'cannot_judge')
      || answers.intervention !== 'cannot_judge'
      || answers.older_context_handling !== 'cannot_judge'
      || answers.confidence !== 'unreported'
      || !confoundersUnreported
    )
  ) {
    fail(
      'feedback_input_invalid',
      'Unread or unjudgeable replies require cannot-judge answers.',
      { field: 'answers.reviewed_reply' },
    );
  }
  if (
    answers.reviewed_reply === 'yes'
    && answers.continuity_severity === 'none'
    && ratings.some(rating => ['minor', 'major'].includes(rating))
  ) {
    fail(
      'feedback_input_invalid',
      'Facet severity conflicts with the overall severity.',
      { field: 'answers.facet_ratings' },
    );
  }
  if (
    answers.reviewed_reply === 'yes'
    && answers.continuity_severity === 'minor'
    && !ratings.some(rating => ['minor', 'major'].includes(rating))
  ) {
    fail(
      'feedback_input_invalid',
      'Minor severity requires at least one affected facet.',
      { field: 'answers.facet_ratings' },
    );
  }
  if (
    answers.reviewed_reply === 'yes'
    && answers.continuity_severity === 'major'
    && !ratings.includes('major')
  ) {
    fail(
      'feedback_input_invalid',
      'Major severity requires at least one major facet.',
      { field: 'answers.facet_ratings' },
    );
  }
  return structuredClone(answers);
}

function validateSubmitCommand(command) {
  assertExactKeys(command, [
    'schema',
    'command_id',
    'action',
    'chat_id',
    'case_id',
    'expected_receipt_hash',
    'questionnaire_version',
    'consent',
    'answers',
  ], 'command');
  if (
    command.schema !== FEEDBACK_COMMAND_SCHEMA
    || command.action !== 'submit'
    || command.questionnaire_version !== QUESTIONNAIRE_VERSION
  ) {
    fail('feedback_input_invalid', 'Feedback command contract is invalid.');
  }
  assertSafeId(command.command_id, 'command.command_id');
  assertSafeId(command.case_id, 'command.case_id');
  assertOpaqueChatId(command.chat_id, 'command.chat_id');
  assertHash(
    command.expected_receipt_hash,
    'command.expected_receipt_hash',
  );
  assertExactKeys(command.consent, [
    'storage',
    'acknowledged_not_story_memory',
    'acknowledged_no_automatic_upload',
  ], 'command.consent');
  if (
    command.consent.storage !== 'local_only'
    || command.consent.acknowledged_not_story_memory !== true
    || command.consent.acknowledged_no_automatic_upload !== true
  ) {
    fail(
      'feedback_consent_required',
      'Local-only feedback consent is required.',
    );
  }
  return {
    ...structuredClone(command),
    answers: validateAnswers(command.answers),
  };
}

function validateWithdrawCommand(command) {
  assertExactKeys(command, [
    'schema',
    'command_id',
    'action',
    'chat_id',
    'feedback_id',
    'expected_feedback_hash',
  ], 'command');
  if (
    command.schema !== FEEDBACK_COMMAND_SCHEMA
    || command.action !== 'withdraw'
  ) {
    fail('feedback_input_invalid', 'Feedback command contract is invalid.');
  }
  assertSafeId(command.command_id, 'command.command_id');
  assertSafeId(command.feedback_id, 'command.feedback_id');
  assertOpaqueChatId(command.chat_id, 'command.chat_id');
  assertHash(
    command.expected_feedback_hash,
    'command.expected_feedback_hash',
  );
  return structuredClone(command);
}

function withTransaction(database, task) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = task();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

function commandReplay(database, command, requestHash) {
  const existing = database.prepare(`
    SELECT request_hash, result_json
    FROM evaluation_commands
    WHERE command_id = ?
  `).get(command.command_id);
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    fail(
      'feedback_command_reused',
      'The command id is already bound to different feedback.',
    );
  }
  let result;
  try {
    result = JSON.parse(existing.result_json);
  } catch {
    failEvidenceDrift(
      'The cached feedback-command result is unreadable.',
    );
  }
  if (command.action === 'submit') {
    assertEvidenceKeys(result, [
      'schema',
      'status',
      'action',
      'case_id',
      'feedback_id',
      'feedback_hash',
      'storage',
      'automatic_upload',
    ], 'feedback-command result');
    const row = database.prepare(`
      SELECT
        c.receipt_hash,
        r.feedback_id,
        r.feedback_hash
      FROM evaluation_cases AS c
      JOIN evaluation_responses AS r
        ON r.case_id = c.case_id
      WHERE c.case_id = ? AND c.chat_id = ?
    `).get(command.case_id, command.chat_id);
    const feedbackId =
      `feedback_${sha256(canonicalJson({
        case_id: command.case_id,
        command_id: command.command_id,
        answers: command.answers,
      })).slice(0, 24)}`;
    const feedbackHash = sha256(canonicalJson({
      schema: 'mnemosyne.user-continuity-feedback.v1',
      feedback_id: feedbackId,
      case_id: command.case_id,
      questionnaire_version: QUESTIONNAIRE_VERSION,
      questionnaire_hash: QUESTIONNAIRE_HASH,
      answers: command.answers,
      storage: 'local_only',
      story_memory_visible: false,
      automatic_upload: false,
    }));
    const expected = {
      schema: 'mnemosyne.feedback-command-result.v1',
      status: 'recorded',
      action: 'submit',
      case_id: command.case_id,
      feedback_id: feedbackId,
      feedback_hash: feedbackHash,
      storage: 'local_only',
      automatic_upload: false,
    };
    if (
      !row
      || row.receipt_hash !== command.expected_receipt_hash
      || row.feedback_id !== feedbackId
      || row.feedback_hash !== feedbackHash
      || canonicalJson(result) !== canonicalJson(expected)
    ) {
      failEvidenceDrift(
        'The cached feedback-command result no longer matches its response.',
      );
    }
    return structuredClone(result);
  }

  assertEvidenceKeys(result, [
    'schema',
    'status',
    'action',
    'case_id',
    'feedback_id',
    'logical_withdrawal',
    'secure_erase_performed',
  ], 'feedback-command result');
  const row = database.prepare(`
    SELECT
      r.case_id,
      r.feedback_id,
      r.feedback_hash,
      r.status
    FROM evaluation_responses AS r
    JOIN evaluation_cases AS c
      ON c.case_id = r.case_id
    WHERE r.feedback_id = ? AND c.chat_id = ?
  `).get(command.feedback_id, command.chat_id);
  const expected = {
    schema: 'mnemosyne.feedback-command-result.v1',
    status: result.status,
    action: 'withdraw',
    case_id: row?.case_id,
    feedback_id: command.feedback_id,
    logical_withdrawal: true,
    secure_erase_performed: false,
  };
  if (
    !row
    || row.feedback_hash !== command.expected_feedback_hash
    || row.status !== 'withdrawn'
    || !['withdrawn', 'existing'].includes(result.status)
    || canonicalJson(result) !== canonicalJson(expected)
  ) {
    failEvidenceDrift(
      'The cached feedback-command result no longer matches its withdrawal.',
    );
  }
  return structuredClone(result);
}

function recordCommand(database, {
  commandId,
  requestHash,
  result,
  timestamp,
}) {
  database.prepare(`
    INSERT INTO evaluation_commands (
      command_id,
      request_hash,
      result_json,
      created_at
    ) VALUES (?, ?, ?, ?)
  `).run(
    commandId,
    requestHash,
    canonicalJson(result),
    timestamp,
  );
}

function failEvidenceDrift(message) {
  fail('evaluation_evidence_drift', message);
}

function assertEvidenceKeys(value, expected, field) {
  if (
    !isPlainObject(value)
    || canonicalJson(Object.keys(value).sort())
      !== canonicalJson([...expected].sort())
  ) {
    failEvidenceDrift(
      `Stored ${field} contains unsupported evidence fields.`,
    );
  }
}

function assertEvidenceCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    failEvidenceDrift(`Stored ${field} is not a supported count.`);
  }
}

function validateEvidenceCountMap(value, {
  field,
  allowedKeys,
}) {
  if (!isPlainObject(value)) {
    failEvidenceDrift(`Stored ${field} is not a count map.`);
  }
  for (const [key, count] of Object.entries(value)) {
    if (!allowedKeys.has(key)) {
      failEvidenceDrift(`Stored ${field} contains an unknown code.`);
    }
    assertEvidenceCount(count, `${field}.${key}`);
    if (count === 0) {
      failEvidenceDrift(`Stored ${field} contains a zero entry.`);
    }
  }
}

function validateStoredReceipt(receipt, row) {
  assertEvidenceKeys(receipt, [
    'schema',
    'protocol_version',
    'protocol_hash',
    'questionnaire_version',
    'questionnaire_hash',
    'extractor_version',
    'study_design',
    'enrollment',
    'causal_claim_allowed',
    'md1_exit_decision',
    'not_proven',
    'binding',
    'runtime',
    'objective_metrics',
    'provenance',
    'receipt_hash',
  ], 'receipt');
  assertEvidenceKeys(receipt.binding, [
    'chat_id',
    'run_id',
    'turn_id',
    'candidate_id',
    'branch_id',
    'branch_epoch',
    'turn_index',
    'swipe_id',
    'candidate_status',
    'branch_status',
    'governed_patch_present',
  ], 'receipt binding');
  assertEvidenceKeys(receipt.runtime, [
    'build_id',
    'build_id_source',
    'memory_condition_id',
    'condition_attestation_hash',
    'retrieval_contract_version',
    'model_fingerprint',
  ], 'receipt runtime');
  assertEvidenceKeys(receipt.objective_metrics, [
    'tool_sequence',
    'tool_counts',
    'rejected_reason_code_counts',
    'search_result_count',
    'memory_read_entry_count',
    'memory_read_page_count',
    'continuation_cursors_issued_count',
    'continuation_cursors_consumed_count',
    'coverage',
    'writeback_mode',
    'writeback_record_kind_counts',
    'aggregate_usage',
    'output_bytes',
    'dynamic_projection_ready',
  ], 'receipt objective metrics');
  assertEvidenceKeys(receipt.objective_metrics.coverage, [
    'requested_facets',
    'represented_facets',
    'missing_facets',
  ], 'receipt coverage');
  assertEvidenceKeys(receipt.objective_metrics.aggregate_usage, [
    'prompt_tokens',
    'completion_tokens',
  ], 'receipt usage');
  assertEvidenceKeys(receipt.provenance, [
    'binding',
    'runtime',
    'objective_metrics',
  ], 'receipt provenance');
  let historicalRunAttestation;
  try {
    historicalRunAttestation = buildRunAttestation({
      runtimeBuildId: receipt.runtime.build_id,
      runtimeBuildIdSource:
        receipt.runtime.build_id_source,
    });
  } catch {
    failEvidenceDrift(
      'Stored runtime identity is not a supported historical build.',
    );
  }

  if (
    receipt.schema !== 'mnemosyne.run-evidence-receipt.v1'
    || receipt.protocol_version !== PROTOCOL_VERSION
    || receipt.protocol_hash !== sha256(canonicalJson(PROTOCOL))
    || receipt.questionnaire_version !== QUESTIONNAIRE_VERSION
    || receipt.questionnaire_hash !== QUESTIONNAIRE_HASH
    || receipt.extractor_version
      !== 'mnemosyne.run-evidence-extractor.v1'
    || receipt.study_design !== 'observational_single_arm'
    || receipt.enrollment !== 'voluntary_manual'
    || receipt.causal_claim_allowed !== false
    || receipt.md1_exit_decision !== 'not_evaluated'
    || canonicalJson(receipt.not_proven)
      !== canonicalJson(NOT_PROVEN)
    || receipt.binding.chat_id !== row.chat_id
    || receipt.binding.run_id !== row.run_id
    || receipt.binding.turn_id !== row.turn_id
    || receipt.binding.candidate_id !== row.candidate_id
    || receipt.binding.branch_id !== row.branch_id
    || receipt.binding.branch_epoch !== Number(row.branch_epoch)
    || receipt.binding.turn_index !== Number(row.turn_index)
    || receipt.binding.swipe_id !== Number(row.swipe_id)
    || receipt.binding.candidate_status !== 'active'
    || receipt.binding.branch_status !== 'active'
    || receipt.binding.governed_patch_present !== true
    || receipt.runtime.memory_condition_id
      !== historicalRunAttestation.memory_condition.condition_id
    || receipt.runtime.condition_attestation_hash
      !== historicalRunAttestation.attestation_hash
    || !CONTRACT_VERSION_PATTERN.test(
      receipt.runtime.retrieval_contract_version ?? '',
    )
    || (
      receipt.runtime.model_fingerprint !== null
      && !HASH_PATTERN.test(
        receipt.runtime.model_fingerprint ?? '',
      )
    )
    || receipt.provenance.binding
      !== 'trusted_run_journal_and_governance_ledger'
    || receipt.provenance.runtime
      !== 'trusted_run_attestation'
    || receipt.provenance.objective_metrics
      !== 'derived_allowlist'
  ) {
    failEvidenceDrift(
      'Stored run evidence no longer matches its governed contract.',
    );
  }

  const metrics = receipt.objective_metrics;
  if (
    !Array.isArray(metrics.tool_sequence)
    || metrics.tool_sequence.some(item => {
      if (!isPlainObject(item)) return true;
      if (
        canonicalJson(Object.keys(item).sort())
          !== canonicalJson(['status', 'tool'])
      ) {
        return true;
      }
      return (
        !KNOWN_TOOLS.has(item.tool)
        || !['completed', 'rejected'].includes(item.status)
      );
    })
  ) {
    failEvidenceDrift('Stored tool sequence is unsupported.');
  }
  const sequenceCounts = {};
  for (const item of metrics.tool_sequence) {
    sequenceCounts[item.tool] =
      (sequenceCounts[item.tool] ?? 0) + 1;
  }
  validateEvidenceCountMap(metrics.tool_counts, {
    field: 'tool counts',
    allowedKeys: KNOWN_TOOLS,
  });
  if (
    canonicalJson(sortedCountObject(sequenceCounts))
      !== canonicalJson(metrics.tool_counts)
  ) {
    failEvidenceDrift(
      'Stored tool counts do not match the tool sequence.',
    );
  }
  validateEvidenceCountMap(
    metrics.rejected_reason_code_counts,
    {
      field: 'rejection counts',
      allowedKeys: new Set([
        ...RETRIEVAL_REJECTION_REASON_CODES,
        ...WRITEBACK_REJECTION_REASON_CODES,
        'main_ai_tool_protocol_invalid',
      ]),
    },
  );
  validateEvidenceCountMap(
    metrics.writeback_record_kind_counts,
    {
      field: 'writeback record counts',
      allowedKeys: RECORD_KINDS,
    },
  );
  for (const field of [
    'search_result_count',
    'memory_read_entry_count',
    'memory_read_page_count',
    'continuation_cursors_issued_count',
    'continuation_cursors_consumed_count',
    'output_bytes',
  ]) {
    assertEvidenceCount(metrics[field], field);
  }
  for (const field of [
    'prompt_tokens',
    'completion_tokens',
  ]) {
    assertEvidenceCount(metrics.aggregate_usage[field], field);
  }
  if (
    !['changed', 'no_change'].includes(metrics.writeback_mode)
    || typeof metrics.dynamic_projection_ready !== 'boolean'
  ) {
    failEvidenceDrift('Stored objective flags are unsupported.');
  }
  const coverage = metrics.coverage;
  for (const field of [
    'requested_facets',
    'represented_facets',
    'missing_facets',
  ]) {
    if (
      !Array.isArray(coverage[field])
      || coverage[field].some(
        facet => !STORY_COVERAGE_FACETS.has(facet),
      )
      || new Set(coverage[field]).size !== coverage[field].length
    ) {
      failEvidenceDrift('Stored coverage evidence is unsupported.');
    }
  }
  if (
    coverage.represented_facets.some(
      facet => !coverage.requested_facets.includes(facet),
    )
    || coverage.missing_facets.some(
      facet => (
        !coverage.requested_facets.includes(facet)
        || coverage.represented_facets.includes(facet)
      ),
    )
  ) {
    failEvidenceDrift('Stored coverage evidence is inconsistent.');
  }
  const {
    receipt_hash: embeddedReceiptHash,
    ...unsignedReceipt
  } = receipt;
  if (
    embeddedReceiptHash !== row.receipt_hash
    || embeddedReceiptHash
      !== sha256(canonicalJson(unsignedReceipt))
  ) {
    failEvidenceDrift(
      'Stored run evidence no longer matches its seal.',
    );
  }
  return {
    receipt: structuredClone(receipt),
    runAttestation:
      structuredClone(historicalRunAttestation),
  };
}

function deidentifiedMetrics(receipt) {
  const usage = receipt.objective_metrics.aggregate_usage;
  const totalTokens =
    Number(usage.prompt_tokens) + Number(usage.completion_tokens);
  const tokenBucket = totalTokens === 0
    ? 'none'
    : totalTokens <= 2_000
      ? 'up_to_2k'
      : totalTokens <= 8_000
        ? '2k_to_8k'
        : totalTokens <= 32_000
          ? '8k_to_32k'
          : 'over_32k';
  const outputBytes = Number(receipt.objective_metrics.output_bytes);
  const outputBucket = outputBytes <= 1_000
    ? 'up_to_1kb'
    : outputBytes <= 4_000
      ? '1kb_to_4kb'
      : outputBytes <= 16_000
        ? '4kb_to_16kb'
        : 'over_16kb';
  return {
    tool_sequence: structuredClone(
      receipt.objective_metrics.tool_sequence,
    ),
    tool_counts: structuredClone(
      receipt.objective_metrics.tool_counts,
    ),
    rejected_reason_code_counts: structuredClone(
      receipt.objective_metrics.rejected_reason_code_counts,
    ),
    search_result_count:
      receipt.objective_metrics.search_result_count,
    memory_read_entry_count:
      receipt.objective_metrics.memory_read_entry_count,
    memory_read_page_count:
      receipt.objective_metrics.memory_read_page_count,
    continuation_cursors_issued_count:
      receipt.objective_metrics
        .continuation_cursors_issued_count,
    continuation_cursors_consumed_count:
      receipt.objective_metrics
        .continuation_cursors_consumed_count,
    coverage: structuredClone(receipt.objective_metrics.coverage),
    writeback_mode: receipt.objective_metrics.writeback_mode,
    writeback_record_kind_counts: structuredClone(
      receipt.objective_metrics.writeback_record_kind_counts,
    ),
    token_count_bucket: tokenBucket,
    output_size_bucket: outputBucket,
    dynamic_projection_ready:
      receipt.objective_metrics.dynamic_projection_ready,
  };
}

function pseudonym(secret, namespace, value) {
  return `${namespace}_${createHmac('sha256', secret)
    .update(String(value))
    .digest('hex')
    .slice(0, 20)}`;
}

function validateExportRequest(request) {
  if (!isPlainObject(request) || !isPlainObject(request.consent)) {
    fail(
      'feedback_export_consent_required',
      'Explicit deidentified-export consent is required.',
    );
  }
  assertExactKeys(request, [
    'schema',
    'export_id',
    'chat_id',
    'profile',
    'consent',
  ], 'export_request');
  if (
    request.schema !== EXPORT_REQUEST_SCHEMA
    || request.profile !== 'deidentified'
  ) {
    fail(
      'feedback_input_invalid',
      'The evidence export request is invalid.',
    );
  }
  assertSafeId(request.export_id, 'export_request.export_id');
  assertOpaqueChatId(request.chat_id, 'export_request.chat_id');
  assertExactKeys(request.consent, [
    'schema',
    'acknowledged_explicit_export',
    'acknowledged_no_automatic_upload',
    'acknowledged_deidentified_not_anonymous',
  ], 'export_request.consent');
  if (
    request.consent.schema !== EXPORT_CONSENT_SCHEMA
    || request.consent.acknowledged_explicit_export !== true
    || request.consent.acknowledged_no_automatic_upload !== true
    || request.consent.acknowledged_deidentified_not_anonymous !== true
  ) {
    fail(
      'feedback_export_consent_required',
      'Explicit deidentified-export consent is required.',
    );
  }
  return structuredClone(request);
}

function evidenceRecordPayload(row) {
  const { receipt } = row;
  return {
    questionnaire_version: row.questionnaire_version,
    runtime: {
      build_id: receipt.runtime.build_id,
      build_id_source:
        receipt.runtime.build_id_source,
      memory_condition_id:
        receipt.runtime.memory_condition_id,
      retrieval_contract_version:
        receipt.runtime.retrieval_contract_version,
    },
    objective_metrics: deidentifiedMetrics(receipt),
    answers: structuredClone(row.answers),
  };
}

function validateCachedEvidenceBundle(bundle, {
  expectedRecordPayloads,
  expectedRecordBindings,
  expectedAggregateExclusions,
  pseudonymKey,
}) {
  assertEvidenceKeys(bundle, [
    'schema',
    'profile',
    'deidentified_not_anonymous',
    'protocol',
    'questionnaire',
    'questionnaire_hash',
    'study_design',
    'causal_claim_allowed',
    'md1_exit_decision',
    'not_proven',
    'automatic_upload',
    'records',
    'missingness_rules',
    'aggregate_exclusions',
    'omitted_fields',
    'bundle_hash',
  ], 'cached export');
  if (
    bundle.schema !== 'mnemosyne.deidentified-evidence-bundle.v1'
    || bundle.profile !== 'deidentified'
    || bundle.deidentified_not_anonymous !== true
    || canonicalJson(bundle.protocol) !== canonicalJson(PROTOCOL)
    || canonicalJson(bundle.questionnaire)
      !== canonicalJson(QUESTIONNAIRE)
    || bundle.questionnaire_hash !== QUESTIONNAIRE_HASH
    || bundle.study_design !== 'observational_single_arm'
    || bundle.causal_claim_allowed !== false
    || bundle.md1_exit_decision !== 'not_evaluated'
    || canonicalJson(bundle.not_proven)
      !== canonicalJson(NOT_PROVEN)
    || bundle.automatic_upload !== false
    || canonicalJson(bundle.missingness_rules)
      !== canonicalJson(EXPORT_MISSINGNESS_RULES)
    || canonicalJson(bundle.aggregate_exclusions)
      !== canonicalJson(expectedAggregateExclusions)
    || canonicalJson(bundle.omitted_fields)
      !== canonicalJson(EXPORT_OMITTED_FIELDS)
    || !Array.isArray(bundle.records)
    || bundle.records.length !== expectedRecordPayloads.length
    || expectedRecordBindings.length !== expectedRecordPayloads.length
    || !HASH_PATTERN.test(pseudonymKey ?? '')
  ) {
    failEvidenceDrift(
      'The cached evidence export no longer matches its contract.',
    );
  }
  const pseudonymSecret = Buffer.from(pseudonymKey, 'hex');
  for (const [index, record] of bundle.records.entries()) {
    assertEvidenceKeys(record, [
      'chat_ref',
      'case_ref',
      'run_ref',
      'feedback_ref',
      'questionnaire_version',
      'runtime',
      'objective_metrics',
      'answers',
    ], `cached export record ${index}`);
    const binding = expectedRecordBindings[index];
    const expectedReferences = {
      chat_ref: pseudonym(
        pseudonymSecret,
        'chat',
        binding.chat_id,
      ),
      case_ref: pseudonym(
        pseudonymSecret,
        'case',
        binding.case_id,
      ),
      run_ref: pseudonym(
        pseudonymSecret,
        'run',
        binding.run_id,
      ),
      feedback_ref: pseudonym(
        pseudonymSecret,
        'feedback',
        binding.feedback_id,
      ),
    };
    for (const [field, expected] of Object.entries(
      expectedReferences,
    )) {
      if (record[field] !== expected) {
        failEvidenceDrift(
          'The cached evidence export contains a rebound pseudonym.',
        );
      }
    }
    const {
      chat_ref: ignoredChatRef,
      case_ref: ignoredCaseRef,
      run_ref: ignoredRunRef,
      feedback_ref: ignoredFeedbackRef,
      ...payload
    } = record;
    if (
      canonicalJson(payload)
        !== canonicalJson(expectedRecordPayloads[index])
    ) {
      failEvidenceDrift(
        'The cached evidence record no longer matches active evidence.',
      );
    }
  }
  const {
    bundle_hash: embeddedBundleHash,
    ...unsignedBundle
  } = bundle;
  if (
    !HASH_PATTERN.test(embeddedBundleHash ?? '')
    || embeddedBundleHash !== sha256(canonicalJson(unsignedBundle))
  ) {
    failEvidenceDrift(
      'The cached evidence export no longer matches its seal.',
    );
  }
  return structuredClone(bundle);
}

function exportReplay(database, {
  exportId,
  requestHash,
  chatId,
  evidenceStateHash,
  expectedRecordPayloads,
  expectedRecordBindings,
  expectedAggregateExclusions,
}) {
  const existing = database.prepare(`
    SELECT
      request_hash,
      chat_id,
      evidence_state_hash,
      pseudonym_key,
      bundle_json
    FROM evaluation_exports
    WHERE export_id = ?
  `).get(exportId);
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    fail(
      'feedback_export_id_reused',
      'The export id is already bound to a different request.',
    );
  }
  if (
    existing.chat_id !== chatId
    || existing.evidence_state_hash !== evidenceStateHash
  ) {
    fail(
      'feedback_export_stale',
      'The evidence changed after this export id was sealed; use a new export id.',
    );
  }
  let bundle;
  try {
    bundle = JSON.parse(existing.bundle_json);
  } catch {
    failEvidenceDrift('The cached evidence export is unreadable.');
  }
  return validateCachedEvidenceBundle(bundle, {
    expectedRecordPayloads,
    expectedRecordBindings,
    expectedAggregateExclusions,
    pseudonymKey: existing.pseudonym_key,
  });
}

export function continuityFeedbackQuestionnaireDefinition() {
  return structuredClone(QUESTIONNAIRE);
}

export function createContinuityEvaluationProgram({
  store,
  runJournal,
  now = () => new Date(),
  randomBytes = nodeRandomBytes,
  randomUUID = nodeRandomUUID,
  runtimeBuildId = 'tavern-mnemosyne@0.1.0',
  runtimeBuildIdSource = 'package_version',
} = {}) {
  if (!store?.openChatForAdmin) {
    throw new TypeError(
      'Continuity Evaluation requires a trusted chat-save store.',
    );
  }
  if (!runJournal?.read) {
    throw new TypeError(
      'Continuity Evaluation requires a trusted Run Journal.',
    );
  }
  if (
    typeof now !== 'function'
    || typeof randomBytes !== 'function'
    || typeof randomUUID !== 'function'
  ) {
    throw new TypeError(
      'Continuity Evaluation dependencies are invalid.',
    );
  }
  const runAttestation = buildRunAttestation({
    runtimeBuildId,
    runtimeBuildIdSource,
  });

  async function prepareFeedback({ chatId, runId } = {}) {
    assertOpaqueChatId(chatId, 'chatId');
    assertSafeId(runId, 'runId');
    let journal;
    try {
      journal = await runJournal.read({ chatId, runId });
    } catch (error) {
      if (error?.reasonCode === 'run_journal_not_found') {
        fail(
          'real_use_run_not_found',
          'The requested completed run was not found.',
        );
      }
      throw error;
    }
    const scope = validateCompletedJournal(journal, {
      chatId,
      runId,
      runAttestation,
    });
    const {
      database,
      opened,
      evaluationPath,
    } = await openEvaluationDatabase({
      store,
      chatId,
      now,
    });
    try {
      let governance;
      try {
        governance = readGovernanceBinding(opened, scope);
      } catch (error) {
        if (isGovernanceInvalidation(error)) {
          invalidatePreparedRun(database, {
            runId,
            reasonCode: error.reasonCode,
            timestamp: nowIso(now),
            randomUUID,
          });
        }
        throw error;
      }
      const receipt = buildReceipt({
        journal,
        scope,
        governance,
        runAttestation,
      });
      const caseId = `case_${sha256(canonicalJson({
        protocol_version: PROTOCOL_VERSION,
        chat_id: chatId,
        run_id: runId,
        receipt_hash: receipt.receipt_hash,
      })).slice(0, 24)}`;
      const journalHash = sha256(canonicalJson(journal));
      let status = 'ready';
      let caseStatus = 'prepared';
      let activeFeedback = null;
      const existing = database.prepare(`
        SELECT case_id, receipt_hash, journal_hash, status
        FROM evaluation_cases
        WHERE run_id = ?
      `).get(runId);
      if (existing) {
        if (
          existing.receipt_hash !== receipt.receipt_hash
          || existing.journal_hash !== journalHash
        ) {
          fail(
            'real_use_receipt_drift',
            'The prepared run evidence changed after it was sealed.',
          );
        }
        status = 'existing';
        caseStatus = existing.status;
        const response = database.prepare(`
          SELECT feedback_id, feedback_hash
          FROM evaluation_responses
          WHERE case_id = ? AND status = 'active'
        `).get(existing.case_id);
        if (response) {
          activeFeedback = {
            feedback_id: response.feedback_id,
            feedback_hash: response.feedback_hash,
          };
        }
      } else {
        const timestamp = nowIso(now);
        withTransaction(database, () => {
          database.prepare(`
            INSERT INTO evaluation_cases (
              case_id,
              chat_id,
              run_id,
              turn_id,
              candidate_id,
              branch_id,
              branch_epoch,
              turn_index,
              swipe_id,
              receipt_json,
              receipt_hash,
              journal_hash,
              status,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)
          `).run(
            caseId,
            chatId,
            runId,
            scope.turnId,
            scope.candidateId,
            scope.branchId,
            scope.branchEpoch,
            scope.turnIndex,
            scope.swipeId,
            canonicalJson(receipt),
            receipt.receipt_hash,
            journalHash,
            timestamp,
          );
          database.prepare(`
            INSERT INTO evaluation_events (
              event_id,
              event_type,
              case_id,
              feedback_id,
              payload_hash,
              created_at
            ) VALUES (?, 'case_prepared', ?, NULL, ?, ?)
          `).run(
            `event_${randomUUID()}`,
            caseId,
            receipt.receipt_hash,
            timestamp,
          );
        });
      }
      return {
        schema: 'mnemosyne.continuity-feedback-preparation.v1',
        status,
        case_status: caseStatus,
        case_id: caseId,
        active_feedback: activeFeedback,
        receipt,
        questionnaire: structuredClone(QUESTIONNAIRE),
        storage: {
          location: 'chat_save_local',
          ledger: path.basename(evaluationPath),
          automatic_upload: false,
          story_memory_visible: false,
        },
      };
    } finally {
      database.close();
    }
  }

  async function applyFeedbackCommand(command) {
    if (!isPlainObject(command)) {
      fail('feedback_input_invalid', 'Feedback command is invalid.');
    }
    const normalized = command.action === 'submit'
      ? validateSubmitCommand(command)
      : command.action === 'withdraw'
        ? validateWithdrawCommand(command)
        : fail(
            'feedback_input_invalid',
            'Feedback command action is invalid.',
          );
    const requestHash = sha256(canonicalJson(normalized));
    const { database, opened } = await openEvaluationDatabase({
      store,
      chatId: normalized.chat_id,
      now,
    });
    try {
      const replay = commandReplay(
        database,
        normalized,
        requestHash,
      );
      if (replay) return replay;

      if (normalized.action === 'submit') {
        const evaluationCase = database.prepare(`
          SELECT *
          FROM evaluation_cases
          WHERE case_id = ? AND chat_id = ?
        `).get(normalized.case_id, normalized.chat_id);
        if (!evaluationCase) {
          fail(
            'feedback_case_not_found',
            'The prepared evaluation case was not found.',
          );
        }
        if (
          evaluationCase.receipt_hash
            !== normalized.expected_receipt_hash
        ) {
          fail(
            'feedback_receipt_stale',
            'The feedback receipt is no longer current.',
          );
        }
        if (evaluationCase.status !== 'prepared') {
          fail(
            evaluationCase.status === 'answered'
              ? 'feedback_already_recorded'
              : 'feedback_case_unavailable',
            evaluationCase.status === 'answered'
              ? 'This evaluation case already has feedback.'
              : 'The evaluation case is no longer available for feedback.',
          );
        }
        const existingResponse = database.prepare(`
          SELECT feedback_id, status
          FROM evaluation_responses
          WHERE case_id = ?
        `).get(evaluationCase.case_id);
        if (existingResponse) {
          fail(
            'feedback_already_recorded',
            'This evaluation case already has feedback.',
          );
        }
        try {
          readGovernanceBinding(opened, {
            chatId: evaluationCase.chat_id,
            runId: evaluationCase.run_id,
            turnId: evaluationCase.turn_id,
            candidateId: evaluationCase.candidate_id,
            branchId: evaluationCase.branch_id,
            branchEpoch: Number(evaluationCase.branch_epoch),
            turnIndex: Number(evaluationCase.turn_index),
            swipeId: Number(evaluationCase.swipe_id),
          });
        } catch (error) {
          if (isGovernanceInvalidation(error)) {
            invalidatePreparedCase(database, {
              caseId: evaluationCase.case_id,
              reasonCode: error.reasonCode,
              timestamp: nowIso(now),
              randomUUID,
            });
          }
          throw error;
        }
        const timestamp = nowIso(now);
        const feedbackId =
          `feedback_${sha256(canonicalJson({
            case_id: evaluationCase.case_id,
            command_id: normalized.command_id,
            answers: normalized.answers,
          })).slice(0, 24)}`;
        const unsignedFeedback = {
          schema: 'mnemosyne.user-continuity-feedback.v1',
          feedback_id: feedbackId,
          case_id: evaluationCase.case_id,
          questionnaire_version: QUESTIONNAIRE_VERSION,
          questionnaire_hash: QUESTIONNAIRE_HASH,
          answers: normalized.answers,
          storage: 'local_only',
          story_memory_visible: false,
          automatic_upload: false,
        };
        const feedbackHash = sha256(
          canonicalJson(unsignedFeedback),
        );
        const result = {
          schema: 'mnemosyne.feedback-command-result.v1',
          status: 'recorded',
          action: 'submit',
          case_id: evaluationCase.case_id,
          feedback_id: feedbackId,
          feedback_hash: feedbackHash,
          storage: 'local_only',
          automatic_upload: false,
        };
        withTransaction(database, () => {
          database.prepare(`
            INSERT INTO evaluation_responses (
              feedback_id,
              case_id,
              questionnaire_version,
              questionnaire_hash,
              answers_json,
              feedback_hash,
              status,
              created_at,
              withdrawn_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)
          `).run(
            feedbackId,
            evaluationCase.case_id,
            QUESTIONNAIRE_VERSION,
            QUESTIONNAIRE_HASH,
            canonicalJson(normalized.answers),
            feedbackHash,
            timestamp,
          );
          database.prepare(`
            UPDATE evaluation_cases
            SET status = 'answered'
            WHERE case_id = ?
          `).run(evaluationCase.case_id);
          recordCommand(database, {
            commandId: normalized.command_id,
            requestHash,
            result,
            timestamp,
          });
          database.prepare(`
            INSERT INTO evaluation_events (
              event_id,
              event_type,
              case_id,
              feedback_id,
              payload_hash,
              created_at
            ) VALUES (?, 'feedback_submitted', ?, ?, ?, ?)
          `).run(
            `event_${randomUUID()}`,
            evaluationCase.case_id,
            feedbackId,
            feedbackHash,
            timestamp,
          );
        });
        return result;
      }

      const response = database.prepare(`
        SELECT r.*, c.chat_id
        FROM evaluation_responses AS r
        JOIN evaluation_cases AS c ON c.case_id = r.case_id
        WHERE r.feedback_id = ? AND c.chat_id = ?
      `).get(normalized.feedback_id, normalized.chat_id);
      if (!response) {
        fail(
          'feedback_not_found',
          'The feedback record was not found.',
        );
      }
      if (
        response.feedback_hash !== normalized.expected_feedback_hash
      ) {
        fail(
          'feedback_receipt_stale',
          'The feedback receipt is no longer current.',
        );
      }
      const timestamp = nowIso(now);
      const result = {
        schema: 'mnemosyne.feedback-command-result.v1',
        status: response.status === 'withdrawn'
          ? 'existing'
          : 'withdrawn',
        action: 'withdraw',
        case_id: response.case_id,
        feedback_id: response.feedback_id,
        logical_withdrawal: true,
        secure_erase_performed: false,
      };
      withTransaction(database, () => {
        if (response.status !== 'withdrawn') {
          database.prepare(`
            UPDATE evaluation_responses
            SET status = 'withdrawn', withdrawn_at = ?
            WHERE feedback_id = ?
          `).run(timestamp, response.feedback_id);
          database.prepare(`
            UPDATE evaluation_cases
            SET status = 'withdrawn'
            WHERE case_id = ?
          `).run(response.case_id);
          database.prepare(`
            INSERT INTO evaluation_events (
              event_id,
              event_type,
              case_id,
              feedback_id,
              payload_hash,
              created_at
            ) VALUES (?, 'feedback_withdrawn', ?, ?, ?, ?)
          `).run(
            `event_${randomUUID()}`,
            response.case_id,
            response.feedback_id,
            sha256('logical_withdrawal'),
            timestamp,
          );
        }
        recordCommand(database, {
          commandId: normalized.command_id,
          requestHash,
          result,
          timestamp,
        });
      });
      return result;
    } finally {
      database.close();
    }
  }

  async function buildEvidenceExport(request) {
    const normalized = validateExportRequest(request);
    const requestHash = sha256(canonicalJson(normalized));
    const { database, opened } = await openEvaluationDatabase({
      store,
      chatId: normalized.chat_id,
      now,
    });
    try {
      reconcilePreparedCases({
        database,
        opened,
        chatId: normalized.chat_id,
        now,
        randomUUID,
      });
      const activeEvidenceSql = `
        SELECT
          c.case_id,
          c.chat_id,
          c.run_id,
          c.turn_id,
          c.candidate_id,
          c.branch_id,
          c.branch_epoch,
          c.turn_index,
          c.swipe_id,
          c.receipt_json,
          c.receipt_hash,
          c.journal_hash,
          r.feedback_id,
          r.questionnaire_version,
          r.questionnaire_hash,
          r.answers_json,
          r.feedback_hash
        FROM evaluation_cases AS c
        JOIN evaluation_responses AS r
          ON r.case_id = c.case_id
        WHERE
          c.chat_id = ?
          AND c.status = 'answered'
          AND r.status = 'active'
        ORDER BY c.created_at, c.case_id
      `;
      const rows = database.prepare(activeEvidenceSql)
        .all(normalized.chat_id);
      if (rows.length === 0) {
        fail(
          'feedback_export_empty',
          'No active feedback is available for export.',
        );
      }
      const sealedRows = [];
      for (const row of rows) {
        let receipt;
        let answers;
        try {
          receipt = JSON.parse(row.receipt_json);
          answers = JSON.parse(row.answers_json);
        } catch {
          fail(
            'evaluation_questionnaire_drift',
            'Stored evaluation evidence is not readable.',
          );
        }
        if (
          row.questionnaire_version !== QUESTIONNAIRE_VERSION
          || row.questionnaire_hash !== QUESTIONNAIRE_HASH
          || receipt?.questionnaire_version
            !== QUESTIONNAIRE_VERSION
          || receipt?.questionnaire_hash
            !== QUESTIONNAIRE_HASH
        ) {
          fail(
            'evaluation_questionnaire_drift',
            'Stored feedback is bound to a different questionnaire.',
          );
        }
        const validatedReceipt = validateStoredReceipt(
          receipt,
          row,
        );
        receipt = validatedReceipt.receipt;
        try {
          const journal = await runJournal.read({
            chatId: row.chat_id,
            runId: row.run_id,
          });
          if (
            sha256(canonicalJson(journal))
              !== row.journal_hash
          ) {
            failEvidenceDrift(
              'The source Run Journal no longer matches its case seal.',
            );
          }
          const scope = validateCompletedJournal(journal, {
            chatId: row.chat_id,
            runId: row.run_id,
            runAttestation:
              validatedReceipt.runAttestation,
          });
          const expectedReceipt = buildReceipt({
            journal,
            scope,
            governance: {
              candidate_status:
                receipt.binding.candidate_status,
              branch_status:
                receipt.binding.branch_status,
              patch_id:
                receipt.binding.governed_patch_present
                  ? 'sealed'
                  : null,
            },
            runAttestation:
              validatedReceipt.runAttestation,
          });
          if (
            canonicalJson(expectedReceipt)
              !== canonicalJson(receipt)
          ) {
            failEvidenceDrift(
              'Stored run evidence no longer matches its source journal.',
            );
          }
        } catch (error) {
          if (error?.reasonCode === 'evaluation_evidence_drift') {
            throw error;
          }
          failEvidenceDrift(
            'The source Run Journal cannot verify stored evidence.',
          );
        }
        let validatedAnswers;
        try {
          validatedAnswers = validateAnswers(answers);
        } catch {
          fail(
            'evaluation_evidence_drift',
            'Stored feedback answers no longer match the questionnaire.',
          );
        }
        const unsignedFeedback = {
          schema: 'mnemosyne.user-continuity-feedback.v1',
          feedback_id: row.feedback_id,
          case_id: row.case_id,
          questionnaire_version: QUESTIONNAIRE_VERSION,
          questionnaire_hash: QUESTIONNAIRE_HASH,
          answers: validatedAnswers,
          storage: 'local_only',
          story_memory_visible: false,
          automatic_upload: false,
        };
        if (
          row.feedback_hash
            !== sha256(canonicalJson(unsignedFeedback))
        ) {
          fail(
            'evaluation_evidence_drift',
            'Stored feedback no longer matches its seal.',
          );
        }
        sealedRows.push({
          ...row,
          receipt,
          answers: validatedAnswers,
        });
      }
      return withTransaction(database, () => {
        const currentRows = database.prepare(activeEvidenceSql)
          .all(normalized.chat_id);
        if (
          canonicalJson(currentRows)
            !== canonicalJson(rows)
        ) {
          if (currentRows.length === 0) {
            fail(
              'feedback_export_empty',
              'No active feedback is available for export.',
            );
          }
          fail(
            'feedback_export_state_changed',
            'Evaluation evidence changed while the export was being verified.',
          );
        }
        const withdrawnCount = Number(database.prepare(`
          SELECT COUNT(*) AS count
          FROM evaluation_cases AS c
          JOIN evaluation_responses AS r
            ON r.case_id = c.case_id
          WHERE c.chat_id = ? AND r.status = 'withdrawn'
        `).get(normalized.chat_id)?.count ?? 0);
        const nonresponseCount = Number(database.prepare(`
          SELECT COUNT(*) AS count
          FROM evaluation_cases AS c
          LEFT JOIN evaluation_responses AS r
            ON r.case_id = c.case_id
          WHERE
            c.chat_id = ?
            AND c.status = 'prepared'
            AND r.feedback_id IS NULL
        `).get(normalized.chat_id)?.count ?? 0);
        const invalidatedCount = Number(database.prepare(`
          SELECT COUNT(*) AS count
          FROM evaluation_cases
          WHERE chat_id = ? AND status = 'invalidated'
        `).get(normalized.chat_id)?.count ?? 0);
        const expectedAggregateExclusions = {
          logically_withdrawn_count: withdrawnCount,
          nonresponse_count: nonresponseCount,
          invalidated_count: invalidatedCount,
        };
        const expectedRecordPayloads =
          sealedRows.map(evidenceRecordPayload);
        const evidenceStateHash = sha256(canonicalJson({
          schema: 'mnemosyne.evidence-export-state.v1',
          questionnaire_hash: QUESTIONNAIRE_HASH,
          records: sealedRows.map(row => ({
            case_id: row.case_id,
            run_id: row.run_id,
            receipt_hash: row.receipt_hash,
            feedback_id: row.feedback_id,
            feedback_hash: row.feedback_hash,
          })),
          aggregate_exclusions: expectedAggregateExclusions,
        }));
        const replay = exportReplay(database, {
          exportId: normalized.export_id,
          requestHash,
          chatId: normalized.chat_id,
          evidenceStateHash,
          expectedRecordPayloads,
          expectedRecordBindings: sealedRows.map(row => ({
            chat_id: row.chat_id,
            case_id: row.case_id,
            run_id: row.run_id,
            feedback_id: row.feedback_id,
          })),
          expectedAggregateExclusions,
        });
        if (replay) return structuredClone(replay);
        const exportSecret = randomBytes(32);
        if (
          !(exportSecret instanceof Uint8Array)
          || exportSecret.byteLength !== 32
        ) {
          throw new TypeError(
            'Continuity Evaluation randomBytes must return exactly 32 secure bytes.',
          );
        }
        const pseudonymKey =
          Buffer.from(exportSecret).toString('hex');
        const unsignedBundle = {
          schema: 'mnemosyne.deidentified-evidence-bundle.v1',
          profile: 'deidentified',
          deidentified_not_anonymous: true,
          protocol: structuredClone(PROTOCOL),
          questionnaire: structuredClone(QUESTIONNAIRE),
          questionnaire_hash: QUESTIONNAIRE_HASH,
          study_design: 'observational_single_arm',
          causal_claim_allowed: false,
          md1_exit_decision: 'not_evaluated',
          not_proven: [...NOT_PROVEN],
          automatic_upload: false,
          records: sealedRows.map((row, index) => ({
            chat_ref: pseudonym(
              exportSecret,
              'chat',
              normalized.chat_id,
            ),
            case_ref: pseudonym(
              exportSecret,
              'case',
              row.case_id,
            ),
            run_ref: pseudonym(
              exportSecret,
              'run',
              row.run_id,
            ),
            feedback_ref: pseudonym(
              exportSecret,
              'feedback',
              row.feedback_id,
            ),
            ...expectedRecordPayloads[index],
          })),
          missingness_rules:
            structuredClone(EXPORT_MISSINGNESS_RULES),
          aggregate_exclusions: expectedAggregateExclusions,
          omitted_fields: [...EXPORT_OMITTED_FIELDS],
        };
        const bundle = {
          ...unsignedBundle,
          bundle_hash: sha256(canonicalJson(unsignedBundle)),
        };
        database.prepare(`
          INSERT INTO evaluation_exports (
            export_id,
            request_hash,
            chat_id,
            evidence_state_hash,
            pseudonym_key,
            bundle_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalized.export_id,
          requestHash,
          normalized.chat_id,
          evidenceStateHash,
          pseudonymKey,
          canonicalJson(bundle),
          nowIso(now),
        );
        return structuredClone(bundle);
      });
    } finally {
      database.close();
    }
  }

  return Object.freeze({
    run_attestation: runAttestation,
    protocol: PROTOCOL,
    prepareFeedback,
    applyFeedbackCommand,
    buildEvidenceExport,
  });
}
