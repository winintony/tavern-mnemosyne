// Candidate schemas for the longform fixture + four-layer eval suite
// (issue 19). Names and fields are explicitly candidates ("实现时定版")
// per the issue; this module is the single place that fixes their shape
// for this slice. It performs structural validation only -- it does not
// know anything about story content, provider wiring, or evaluation.
//
// File layout (issue 19, "定版增补" 2026-07-28): a single turn_index can
// carry more than one document -- a swipe adds a second candidate at the
// same turn_index, and a branch_fork/truncate starts a new branch_epoch
// that reuses turn_index numbers the old epoch already used. So the unit
// of on-disk identity is a global step sequence, not a turn number:
// script/step-NNN.json + oracle/step-NNN.json, each carrying an explicit
// `sequence` plus the full coordinate (turn_index/branch_id/branch_epoch/
// candidate_id). A purely linear fixture's sequence numbers equal its
// turn numbers.

const FIXTURE_SCHEMA = 'mnemosyne.longform-fixture.v1';
const TURN_SCRIPT_SCHEMA = 'mnemosyne.longform-turn-script.v1';
const ORACLE_SCHEMA = 'mnemosyne.longform-oracle.v1';

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const LANE_OPS = new Set([null, 'swipe', 'branch_fork', 'truncate']);
const LAYER_MAP_VALUES = new Set(['governance_retrieval', 'semantic']);
const TOOL_STEP_NAMES = new Set(['memory_search', 'memory_read']);

function isObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function invalid(code, message, details) {
  const error = new TypeError(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID_PATTERN.test(value);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

// ---------------------------------------------------------------------
// typed_delta grounding (DECISION-MAP #6): every record must cite at
// least one source anchor. A committed_body anchor's quote_or_ref is the
// span itself (this fixture format has no separate numeric start/end) --
// so "in bounds" means it is found in this step's assistant_body at all,
// and "consistent" means that location is unambiguous (found exactly
// once), mirroring the two real grounding failures the runtime's own
// evidenceSpan() already enforces (src/history/typed-turn-delta.js):
// "does not occur in the committed body" and "occurs more than once in
// the committed body". Non-body anchors (existing_memory / static_lore /
// tool_result / user_author_instruction -- #6's other legitimate
// grounding sources) are accepted without a body match; only
// committed_body anchors are checked against assistant_body.
const COMMITTED_BODY_SOURCE_KIND = 'committed_body';
const NON_BODY_SOURCE_KINDS = new Set([
  'existing_memory',
  'static_lore',
  'tool_result',
  'user_author_instruction',
]);
const GROUNDING_SOURCE_KINDS = new Set([
  COMMITTED_BODY_SOURCE_KIND,
  ...NON_BODY_SOURCE_KINDS,
]);

function assertRecordEvidenceGrounding(record, assistantBody, recordIndex) {
  if (!Array.isArray(record?.evidence) || record.evidence.length < 1) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_RECORD_EVIDENCE_MISSING',
      `records[${recordIndex}] must carry at least one evidence/source ` +
        'anchor (DECISION-MAP #6 grounding).',
    );
  }
  record.evidence.forEach((item, evidenceIndex) => {
    if (!isObject(item) || !GROUNDING_SOURCE_KINDS.has(item.source_kind)) {
      throw invalid(
        'LONGFORM_TURN_SCRIPT_RECORD_EVIDENCE_MISSING',
        `records[${recordIndex}].evidence[${evidenceIndex}] must carry a ` +
          'recognized source_kind (committed_body, existing_memory, ' +
          'static_lore, tool_result, or user_author_instruction).',
      );
    }
    if (item.source_kind !== COMMITTED_BODY_SOURCE_KIND) {
      // A non-body anchor has nothing in this fixture to check it
      // against -- it stays legitimate without a body-span match.
      return;
    }
    const quote = item.quote_or_ref;
    if (!nonEmptyString(quote)) {
      throw invalid(
        'LONGFORM_TURN_SCRIPT_RECORD_EVIDENCE_SPAN_EMPTY',
        `records[${recordIndex}].evidence[${evidenceIndex}].quote_or_ref ` +
          'must be a non-empty, non-blank quote from assistant_body.',
      );
    }
    const start = assistantBody.indexOf(quote);
    if (start === -1) {
      throw invalid(
        'LONGFORM_TURN_SCRIPT_RECORD_EVIDENCE_SPAN_OUT_OF_BOUNDS',
        `records[${recordIndex}].evidence[${evidenceIndex}].quote_or_ref ` +
          "does not occur anywhere in this step's assistant_body -- its " +
          'claimed span is out of bounds.',
      );
    }
    if (assistantBody.indexOf(quote, start + quote.length) !== -1) {
      throw invalid(
        'LONGFORM_TURN_SCRIPT_RECORD_EVIDENCE_QUOTE_INCONSISTENT',
        `records[${recordIndex}].evidence[${evidenceIndex}].quote_or_ref ` +
          'occurs more than once in assistant_body -- its span is not ' +
          'consistently identifiable (ambiguous quote vs. body text).',
      );
    }
  });
}

// ---------------------------------------------------------------------
// fixture.json (mnemosyne.longform-fixture.v1)
// ---------------------------------------------------------------------

export function validateLongformFixture(fixture) {
  if (!isObject(fixture)) {
    throw invalid(
      'LONGFORM_FIXTURE_INVALID',
      'A longform fixture manifest must be an object.',
    );
  }
  if (fixture.schema !== FIXTURE_SCHEMA) {
    throw invalid(
      'LONGFORM_FIXTURE_INVALID',
      `A longform fixture manifest must carry schema "${FIXTURE_SCHEMA}".`,
    );
  }
  if (!safeId(fixture.fixture_id)) {
    throw invalid(
      'LONGFORM_FIXTURE_INVALID',
      'fixture_id is missing or unsafe.',
    );
  }
  if (!nonEmptyString(fixture.chat_id)) {
    throw invalid('LONGFORM_FIXTURE_INVALID', 'chat_id is required.');
  }
  for (const field of [
    'locale_profile',
    'content_locale',
    'genre_profile',
    'tokenizer_profile',
    'phrase_asset_id',
    'phrase_asset_hash',
  ]) {
    if (!nonEmptyString(fixture[field])) {
      throw invalid(
        'LONGFORM_FIXTURE_INVALID',
        `${field} is required and must be a non-empty string ` +
          '("disabled" when no reliable language pack exists).',
      );
    }
  }
  if (!positiveInteger(fixture.total_turns)) {
    throw invalid(
      'LONGFORM_FIXTURE_INVALID',
      'total_turns must be a positive integer.',
    );
  }
  if (!positiveInteger(fixture.total_steps) || fixture.total_steps < fixture.total_turns) {
    throw invalid(
      'LONGFORM_FIXTURE_INVALID',
      'total_steps must be a positive integer >= total_turns (swipe/' +
        'branch steps add steps without adding new turn numbers).',
    );
  }
  if (!isObject(fixture.coverage_matrix)) {
    throw invalid(
      'LONGFORM_FIXTURE_INVALID',
      'coverage_matrix must be an object mapping tag -> turn numbers.',
    );
  }
  for (const [tag, turns] of Object.entries(fixture.coverage_matrix)) {
    if (!nonEmptyString(tag)) {
      throw invalid(
        'LONGFORM_FIXTURE_COVERAGE_TAG_INVALID',
        'A coverage_matrix tag key must be a non-empty string.',
      );
    }
    if (
      !Array.isArray(turns)
      || turns.length === 0
      || turns.some(turn => (
        !positiveInteger(turn) || turn > fixture.total_turns
      ))
      || new Set(turns).size !== turns.length
    ) {
      throw invalid(
        'LONGFORM_FIXTURE_COVERAGE_TAG_EMPTY',
        `coverage_matrix tag "${tag}" must map to at least one unique ` +
          'in-range turn number.',
      );
    }
  }
  return true;
}

// ---------------------------------------------------------------------
// script/step-NNN.json (mnemosyne.longform-turn-script.v1)
// ---------------------------------------------------------------------

function assertToolScriptStep(step, index) {
  if (
    !isObject(step)
    || !TOOL_STEP_NAMES.has(step.name)
    || !isObject(step.arguments)
  ) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_TOOL_STEP_INVALID',
      `tool_script[${index}] must be a memory_search or memory_read ` +
        'step with an arguments object.',
    );
  }
}

function assertTypedDelta(typedDelta, assistantBody) {
  if (
    !isObject(typedDelta)
    || !['changed', 'no_change'].includes(typedDelta.mode)
    || !nonEmptyString(typedDelta.reason)
    || !Array.isArray(typedDelta.records)
  ) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_TYPED_DELTA_INVALID',
      'typed_delta must carry mode, reason, and a records array.',
    );
  }
  if (typedDelta.mode === 'no_change' && typedDelta.records.length !== 0) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_TYPED_DELTA_INVALID',
      'A no_change typed_delta must not carry records.',
    );
  }
  typedDelta.records.forEach((record, index) => {
    assertRecordEvidenceGrounding(record, assistantBody, index);
  });
}

export function validateLongformTurnScript(script) {
  if (!isObject(script) || script.schema !== TURN_SCRIPT_SCHEMA) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_INVALID',
      `A turn script must carry schema "${TURN_SCRIPT_SCHEMA}".`,
    );
  }
  if (!positiveInteger(script.sequence)) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_INVALID',
      'sequence must be a positive integer (global step order).',
    );
  }
  if (!positiveInteger(script.turn_index)) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_INVALID',
      'turn_index must be a positive integer.',
    );
  }
  for (const field of ['turn_id', 'branch_id', 'candidate_id']) {
    if (!safeId(script[field])) {
      throw invalid(
        'LONGFORM_TURN_SCRIPT_INVALID',
        `${field} is missing or unsafe.`,
      );
    }
  }
  if (!nonNegativeInteger(script.branch_epoch)) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_INVALID',
      'branch_epoch must be a non-negative integer.',
    );
  }
  if (!nonNegativeInteger(script.swipe_id)) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_INVALID',
      'swipe_id must be a non-negative integer.',
    );
  }
  if (!LANE_OPS.has(script.lane_op)) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_INVALID',
      'lane_op must be null, "swipe", "branch_fork", or "truncate".',
    );
  }
  if (
    script.lane_op === 'branch_fork'
    || script.lane_op === 'truncate'
  ) {
    if (
      !isObject(script.lane_op_params)
      || !nonNegativeInteger(script.lane_op_params.cutoff_turn_index)
      || !nonNegativeInteger(script.lane_op_params.expected_branch_epoch)
      || !safeId(script.lane_op_params.reason_code)
    ) {
      throw invalid(
        'LONGFORM_TURN_SCRIPT_LANE_OP_PARAMS_INVALID',
        'branch_fork/truncate require lane_op_params with ' +
          'cutoff_turn_index, expected_branch_epoch, and reason_code ' +
          '(the target coordinate for the new epoch).',
      );
    }
    if (script.branch_epoch !== script.lane_op_params.expected_branch_epoch + 1) {
      throw invalid(
        'LONGFORM_TURN_SCRIPT_LANE_OP_PARAMS_INVALID',
        'branch_fork/truncate steps must commit into ' +
          'expected_branch_epoch + 1 (the epoch the truncate creates).',
      );
    }
    if (script.turn_index !== script.lane_op_params.cutoff_turn_index) {
      throw invalid(
        'LONGFORM_TURN_SCRIPT_LANE_OP_PARAMS_INVALID',
        'branch_fork/truncate steps must resume exactly at ' +
          'cutoff_turn_index on the new epoch.',
      );
    }
  } else if (script.lane_op_params !== undefined) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_LANE_OP_PARAMS_INVALID',
      'lane_op_params is only valid alongside branch_fork/truncate.',
    );
  }
  if (!nonEmptyString(script.user_message)) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_INVALID',
      'user_message is required.',
    );
  }
  if (!Array.isArray(script.tool_script)) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_INVALID',
      'tool_script must be an array (may be empty).',
    );
  }
  script.tool_script.forEach(assertToolScriptStep);
  if (!nonEmptyString(script.assistant_body)) {
    throw invalid(
      'LONGFORM_TURN_SCRIPT_INVALID',
      'assistant_body is required.',
    );
  }
  assertTypedDelta(script.typed_delta, script.assistant_body);
  return true;
}

// ---------------------------------------------------------------------
// oracle/step-NNN.json (mnemosyne.longform-oracle.v1)
// ---------------------------------------------------------------------

export function validateLongformOracle(oracle) {
  if (!isObject(oracle) || oracle.schema !== ORACLE_SCHEMA) {
    throw invalid(
      'LONGFORM_ORACLE_INVALID',
      `An oracle must carry schema "${ORACLE_SCHEMA}".`,
    );
  }
  if (!positiveInteger(oracle.sequence)) {
    throw invalid(
      'LONGFORM_ORACLE_INVALID',
      'sequence must be a positive integer binding it to its script step.',
    );
  }
  if (!positiveInteger(oracle.turn_index)) {
    throw invalid(
      'LONGFORM_ORACLE_INVALID',
      'turn_index must be a positive integer.',
    );
  }
  if (!isObject(oracle.capture_manifest)) {
    throw invalid(
      'LONGFORM_ORACLE_INVALID',
      'capture_manifest (mnemosyne.turn-capture-manifest.v1) is required.',
    );
  }
  if (
    oracle.capture_manifest.schema !== 'mnemosyne.turn-capture-manifest.v1'
  ) {
    throw invalid(
      'LONGFORM_ORACLE_INVALID',
      'capture_manifest must carry schema ' +
        '"mnemosyne.turn-capture-manifest.v1" unmodified.',
    );
  }
  if (!isObject(oracle.semantic_case)) {
    throw invalid(
      'LONGFORM_ORACLE_INVALID',
      'semantic_case (mnemosyne.story-memory-semantic-case.v1) is required.',
    );
  }
  if (
    oracle.semantic_case.schema !== 'mnemosyne.story-memory-semantic-case.v1'
  ) {
    throw invalid(
      'LONGFORM_ORACLE_INVALID',
      'semantic_case must carry schema ' +
        '"mnemosyne.story-memory-semantic-case.v1" unmodified.',
    );
  }
  if (!isObject(oracle.layer_map)) {
    throw invalid(
      'LONGFORM_ORACLE_INVALID',
      'layer_map must be an object mapping check_id -> layer.',
    );
  }
  const semanticCheckIds = new Set(
    (oracle.semantic_case.checks ?? []).map(check => check?.check_id),
  );
  for (const [checkId, layer] of Object.entries(oracle.layer_map)) {
    if (!semanticCheckIds.has(checkId)) {
      throw invalid(
        'LONGFORM_ORACLE_LAYER_MAP_UNKNOWN_CHECK',
        `layer_map references unknown semantic check_id "${checkId}".`,
      );
    }
    if (!LAYER_MAP_VALUES.has(layer)) {
      throw invalid(
        'LONGFORM_ORACLE_LAYER_MAP_INVALID',
        `layer_map["${checkId}"] must be governance_retrieval or semantic.`,
      );
    }
  }
  for (const checkId of semanticCheckIds) {
    if (!(checkId in oracle.layer_map)) {
      throw invalid(
        'LONGFORM_ORACLE_LAYER_MAP_INCOMPLETE',
        `layer_map is missing an entry for semantic check_id "${checkId}".`,
      );
    }
  }
  if (
    !Array.isArray(oracle.coverage_tags)
    || oracle.coverage_tags.length === 0
    || oracle.coverage_tags.some(tag => !nonEmptyString(tag))
  ) {
    throw invalid(
      'LONGFORM_ORACLE_INVALID',
      'coverage_tags must be a non-empty array of non-empty strings.',
    );
  }
  return true;
}

// ---------------------------------------------------------------------
// Cross-file bundle validation.
// ---------------------------------------------------------------------

function coordinateKey({ branch_id: branchId, branch_epoch: branchEpoch, turn_index: turnIndex }) {
  return `${branchId}\u0000${branchEpoch}\u0000${turnIndex}`;
}

export function validateLongformFixtureBundle({
  fixture,
  scripts,
  oracles,
} = {}) {
  validateLongformFixture(fixture);
  if (!(scripts instanceof Map) || !(oracles instanceof Map)) {
    throw invalid(
      'LONGFORM_FIXTURE_BUNDLE_INVALID',
      'scripts and oracles must be Map<sequence, document>.',
    );
  }

  const turnIndexesSeen = new Set();
  // The step that first established a (branch_id, branch_epoch,
  // turn_index) coordinate -- swipes must reuse its turn_id/user_message,
  // and branch_fork/truncate must not collide with an existing one.
  const originStepByCoordinate = new Map();

  for (let sequence = 1; sequence <= fixture.total_steps; sequence += 1) {
    const script = scripts.get(sequence);
    const oracle = oracles.get(sequence);
    if (!script) {
      throw invalid(
        'LONGFORM_FIXTURE_BUNDLE_MISSING_SCRIPT',
        `Step ${sequence} is missing its script document.`,
      );
    }
    if (!oracle) {
      throw invalid(
        'LONGFORM_FIXTURE_BUNDLE_MISSING_ORACLE',
        `Step ${sequence} is missing its oracle document.`,
      );
    }
    validateLongformTurnScript(script);
    validateLongformOracle(oracle);
    if (script.sequence !== sequence || oracle.sequence !== sequence) {
      throw invalid(
        'LONGFORM_FIXTURE_BUNDLE_SEQUENCE_MISMATCH',
        `Step ${sequence} script/oracle sequence must match its file.`,
      );
    }
    if (script.turn_index !== oracle.turn_index) {
      throw invalid(
        'LONGFORM_FIXTURE_BUNDLE_COORDINATE_MISMATCH',
        `Step ${sequence} oracle.turn_index must match its script.`,
      );
    }
    if (script.turn_index > fixture.total_turns) {
      throw invalid(
        'LONGFORM_FIXTURE_BUNDLE_COORDINATE_MISMATCH',
        `Step ${sequence} turn_index exceeds fixture.total_turns.`,
      );
    }
    turnIndexesSeen.add(script.turn_index);

    const manifestCoordinate = oracle.capture_manifest.coordinate ?? {};
    if (
      manifestCoordinate.chat_id !== fixture.chat_id
      || manifestCoordinate.branch_id !== script.branch_id
      || manifestCoordinate.branch_epoch !== script.branch_epoch
      || manifestCoordinate.turn_index !== script.turn_index
      || manifestCoordinate.candidate_id !== script.candidate_id
    ) {
      throw invalid(
        'LONGFORM_FIXTURE_BUNDLE_COORDINATE_MISMATCH',
        `Step ${sequence} capture_manifest.coordinate does not bind to ` +
          'its own script.',
      );
    }
    const caseCoordinate = oracle.semantic_case.coordinate ?? {};
    if (
      caseCoordinate.chat_id !== fixture.chat_id
      || caseCoordinate.branch_id !== 'main'
      || caseCoordinate.branch_epoch !== script.branch_epoch
      || caseCoordinate.turn_index !== script.turn_index
    ) {
      throw invalid(
        'LONGFORM_FIXTURE_BUNDLE_COORDINATE_MISMATCH',
        `Step ${sequence} semantic_case.coordinate does not bind to its ` +
          'own script.',
      );
    }

    const key = coordinateKey(script);
    if (script.lane_op === 'swipe') {
      const origin = originStepByCoordinate.get(key);
      if (!origin) {
        throw invalid(
          'LONGFORM_TURN_SCRIPT_SWIPE_TARGET_MISSING',
          `Step ${sequence} swipes a (branch_id, branch_epoch, ` +
            'turn_index) coordinate with no earlier step.',
        );
      }
      if (
        origin.turn_id !== script.turn_id
        || origin.user_message !== script.user_message
      ) {
        throw invalid(
          'LONGFORM_TURN_SCRIPT_SWIPE_MISMATCH',
          `Step ${sequence} is a swipe and must reuse the same turn_id ` +
            'and user_message as the turn it swipes.',
        );
      }
      if (origin.candidate_id === script.candidate_id) {
        throw invalid(
          'LONGFORM_TURN_SCRIPT_SWIPE_MISMATCH',
          `Step ${sequence} is a swipe and must use a new candidate_id.`,
        );
      }
    } else {
      if (originStepByCoordinate.has(key)) {
        throw invalid(
          'LONGFORM_FIXTURE_BUNDLE_COORDINATE_DUPLICATE',
          `Step ${sequence} reuses an existing (branch_id, branch_epoch, ` +
            'turn_index) coordinate without lane_op: "swipe".',
        );
      }
      originStepByCoordinate.set(key, script);
    }
  }

  const coveredTurns = new Set(Object.values(fixture.coverage_matrix).flat());
  for (let turnIndex = 1; turnIndex <= fixture.total_turns; turnIndex += 1) {
    if (!turnIndexesSeen.has(turnIndex)) {
      throw invalid(
        'LONGFORM_FIXTURE_BUNDLE_TURN_MISSING',
        `Turn ${turnIndex} has no step at all.`,
      );
    }
    if (!coveredTurns.has(turnIndex)) {
      throw invalid(
        'LONGFORM_FIXTURE_BUNDLE_TURN_UNCOVERED',
        `Turn ${turnIndex} is not represented in any coverage_matrix tag.`,
      );
    }
  }
  if (scripts.size !== fixture.total_steps || oracles.size !== fixture.total_steps) {
    throw invalid(
      'LONGFORM_FIXTURE_BUNDLE_EXTRA_TURNS',
      'scripts/oracles must contain exactly total_steps documents.',
    );
  }
  return true;
}

export const LONGFORM_FIXTURE_SCHEMA = FIXTURE_SCHEMA;
export const LONGFORM_TURN_SCRIPT_SCHEMA = TURN_SCRIPT_SCHEMA;
export const LONGFORM_ORACLE_SCHEMA = ORACLE_SCHEMA;
