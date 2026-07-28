import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  isCanonicalTypedRecordKind,
} from '../history/typed-turn-delta.js';
import { STORY_COVERAGE_FACETS } from '../memory/story-coverage.js';

const CASE_SCHEMA = 'mnemosyne.story-memory-semantic-case.v1';
const REPORT_SCHEMA = 'mnemosyne.story-memory-semantic-report.v1';
const SAFE_REPORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SEMANTIC_RETRIEVAL_LIMIT = 12;
const SEMANTIC_ABSENCE_LIMIT = 50;

function isObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isObject(value)
    && Object.keys(value).length === expected.length
    && Object.keys(value).every(key => expected.includes(key));
}

function isSafeReportId(value) {
  return typeof value === 'string'
    && SAFE_REPORT_ID_PATTERN.test(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (
    value === null
    || typeof value !== 'object'
    || seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'STORY_MEMORY_SEMANTIC_CASE_INVALID';
  return error;
}

function assertCoordinate(coordinate) {
  if (
    !exactKeys(coordinate, [
      'chat_id',
      'branch_id',
      'branch_epoch',
      'turn_index',
    ])
    || typeof coordinate.chat_id !== 'string'
    || !coordinate.chat_id
    || coordinate.branch_id !== 'main'
    || !Number.isSafeInteger(coordinate.branch_epoch)
    || coordinate.branch_epoch < 0
    || !Number.isSafeInteger(coordinate.turn_index)
    || coordinate.turn_index < 0
  ) {
    throw invalid('Semantic evaluation requires one exact active coordinate.');
  }
}

function assertCurrentStateCheck(check) {
  if (
    !exactKeys(check, [
      'check_id',
      'kind',
      'entity_ref',
      'state_domain',
      'state_key',
      'expected_status',
      'expected_value',
    ])
    || !isSafeReportId(check.check_id)
    || check.kind !== 'current_state'
    || typeof check.entity_ref !== 'string'
    || !check.entity_ref.startsWith('okf://entity/')
    || typeof check.state_domain !== 'string'
    || !check.state_domain
    || typeof check.state_key !== 'string'
    || !check.state_key
    || !['present', 'absent'].includes(check.expected_status)
    || (
      check.expected_status === 'absent'
      && check.expected_value !== null
    )
  ) {
    throw invalid('Current-state semantic check is invalid.');
  }
  try {
    canonicalJson(check.expected_value);
  } catch {
    throw invalid('Current-state expected value must be canonical JSON.');
  }
}

function assertTypedRecordCheck(check, coordinate) {
  if (
    !exactKeys(check, [
      'check_id',
      'kind',
      'turn_id',
      'candidate_id',
      'sequence_index',
      'record_kind',
      'expected_payload',
      'expected_revealed_at_turn',
    ])
    || !isSafeReportId(check.check_id)
    || check.kind !== 'typed_record'
    || typeof check.turn_id !== 'string'
    || !check.turn_id
    || typeof check.candidate_id !== 'string'
    || !check.candidate_id
    || !Number.isSafeInteger(check.sequence_index)
    || check.sequence_index < 0
    || !isCanonicalTypedRecordKind(check.record_kind)
    || !isObject(check.expected_payload)
    || !Number.isSafeInteger(check.expected_revealed_at_turn)
    || check.expected_revealed_at_turn < 0
    || check.expected_revealed_at_turn > coordinate.turn_index
  ) {
    throw invalid('Typed-record semantic check is invalid.');
  }
  try {
    canonicalJson(check.expected_payload);
  } catch {
    throw invalid('Typed-record expected payload must be canonical JSON.');
  }
}

function compactStringArray(value, max) {
  return Array.isArray(value)
    && value.length <= max
    && value.every(item => typeof item === 'string' && Boolean(item.trim()))
    && new Set(value).size === value.length;
}

function assertRetrievalCheck(check) {
  if (
    !exactKeys(check, [
      'check_id',
      'kind',
      'query',
      'purpose',
      'needs',
      'coverage_facets',
      'expected_type',
      'expected_entity_ref',
    ])
    || !isSafeReportId(check.check_id)
    || check.kind !== 'retrieval'
    || typeof check.query !== 'string'
    || !check.query.trim()
    || typeof check.purpose !== 'string'
    || !check.purpose.trim()
    || !compactStringArray(check.needs, 4)
    || !compactStringArray(
      check.coverage_facets,
      STORY_COVERAGE_FACETS.length,
    )
    || check.coverage_facets.length === 0
    || check.coverage_facets.some(
      facet => !STORY_COVERAGE_FACETS.includes(facet),
    )
    || !STORY_COVERAGE_FACETS.includes(check.expected_type)
    || typeof check.expected_entity_ref !== 'string'
    || !check.expected_entity_ref.startsWith('okf://entity/')
  ) {
    throw invalid('Retrieval semantic check is invalid.');
  }
}

function assertRetrievalAbsenceCheck(check) {
  if (
    !exactKeys(check, [
      'check_id',
      'kind',
      'query',
      'purpose',
      'needs',
      'coverage_facets',
      'forbidden_entity_refs',
    ])
    || !isSafeReportId(check.check_id)
    || check.kind !== 'retrieval_absence'
    || typeof check.query !== 'string'
    || !check.query.trim()
    || typeof check.purpose !== 'string'
    || !check.purpose.trim()
    || !compactStringArray(check.needs, 4)
    || !compactStringArray(
      check.coverage_facets,
      STORY_COVERAGE_FACETS.length,
    )
    || check.coverage_facets.length === 0
    || check.coverage_facets.some(
      facet => !STORY_COVERAGE_FACETS.includes(facet),
    )
    || !compactStringArray(check.forbidden_entity_refs, 32)
    || check.forbidden_entity_refs.length === 0
    || check.forbidden_entity_refs.some(
      entityRef => !entityRef.startsWith('okf://entity/'),
    )
  ) {
    throw invalid('Retrieval-absence semantic check is invalid.');
  }
}

function assertCase(input) {
  if (
    !exactKeys(input, [
      'schema',
      'case_id',
      'coordinate',
      'checks',
    ])
    || input.schema !== CASE_SCHEMA
    || !isSafeReportId(input.case_id)
    || !Array.isArray(input.checks)
    || input.checks.length === 0
    || input.checks.length > 64
  ) {
    throw invalid('Story-memory semantic case is invalid.');
  }
  assertCoordinate(input.coordinate);
  const ids = new Set();
  for (const check of input.checks) {
    if (check?.kind === 'current_state') {
      assertCurrentStateCheck(check);
    } else if (check?.kind === 'typed_record') {
      assertTypedRecordCheck(check, input.coordinate);
    } else if (check?.kind === 'retrieval') {
      assertRetrievalCheck(check);
    } else if (check?.kind === 'retrieval_absence') {
      assertRetrievalAbsenceCheck(check);
    } else {
      throw invalid(
        `Unsupported semantic check kind: ${String(check?.kind)}.`,
      );
    }
    if (ids.has(check.check_id)) {
      throw invalid(`Duplicate semantic check id: ${check.check_id}.`);
    }
    ids.add(check.check_id);
  }
}

function currentStateResult(check, state) {
  const matching = state.current_state.filter(item => (
    item.entity_ref === check.entity_ref
    && item.state_domain === check.state_domain
    && item.state_key === check.state_key
  ));
  const observedValue = matching.length === 1
    ? structuredClone(matching[0].current_value)
    : null;
  const observedStatus = matching.length === 1
    ? 'present'
    : matching.length === 0
      ? 'absent'
      : 'ambiguous';
  const observed = {
    status: observedStatus,
    value_hash: observedStatus === 'present'
      ? sha256(canonicalJson(observedValue))
      : null,
  };
  const passed = check.expected_status === observed.status
    && (
      observed.status !== 'present'
      || canonicalJson(observedValue) === canonicalJson(check.expected_value)
    );
  return {
    check_id: check.check_id,
    kind: check.kind,
    status: passed ? 'passed' : 'failed',
    observed,
  };
}

function typedRecordResult(check, artifact, active) {
  const record = artifact?.delta?.records?.[check.sequence_index];
  const payload = record?.payload ?? record?.event ?? null;
  const observed = {
    status: !active
      ? 'inactive'
      : !record
        ? 'missing'
        : 'observed',
    record_kind: record?.kind ?? null,
    payload_hash: payload === null ? null : sha256(canonicalJson(payload)),
    revealed_at_turn: artifact?.turn_index ?? null,
  };
  const passed = (
    active
    && record?.kind === check.record_kind
    && canonicalJson(payload) === canonicalJson(check.expected_payload)
    && artifact.turn_index === check.expected_revealed_at_turn
  );
  return {
    check_id: check.check_id,
    kind: check.kind,
    status: passed ? 'passed' : 'failed',
    observed,
  };
}

async function retrievalResult(check, coordinate, memoryReader) {
  const search = await memoryReader.search({
    chatId: coordinate.chat_id,
    branchId: coordinate.branch_id,
    branchEpoch: coordinate.branch_epoch,
    turnIndex: coordinate.turn_index,
    query: check.query,
    purpose: check.purpose,
    needs: check.needs,
    coverageFacets: check.coverage_facets,
    limit: SEMANTIC_RETRIEVAL_LIMIT,
  });
  const result = search.results.find(candidate => (
    candidate.type === check.expected_type
    && candidate.entity_ref === check.expected_entity_ref
  ));
  const read = result
    ? await memoryReader.read({
        chatId: coordinate.chat_id,
        branchId: coordinate.branch_id,
        branchEpoch: coordinate.branch_epoch,
        turnIndex: coordinate.turn_index,
        ref: result.ref,
      })
    : null;
  const passed = (
    search.status === 'ready'
    && result
    && read?.status === 'ready'
    && read.memory?.type === check.expected_type
    && read.memory?.entity_ref === check.expected_entity_ref
    && Array.isArray(read.memory?.source_refs)
    && read.memory.source_refs.length > 0
  );
  return {
    check_id: check.check_id,
    kind: check.kind,
    status: passed ? 'passed' : 'failed',
    observed: {
      status: result ? 'found' : 'missing',
      result_type: result?.type ?? null,
      entity_ref_hash: result?.entity_ref
        ? sha256(result.entity_ref)
        : null,
      read_status: read?.status ?? null,
      ref_hash: result?.ref ? sha256(result.ref) : null,
      source_ref_hashes: read?.status === 'ready'
        ? read.memory.source_refs.map(sourceRef => sha256(sourceRef))
        : [],
    },
  };
}

async function retrievalAbsenceResult(check, coordinate, memoryReader) {
  const search = await memoryReader.search({
    chatId: coordinate.chat_id,
    branchId: coordinate.branch_id,
    branchEpoch: coordinate.branch_epoch,
    turnIndex: coordinate.turn_index,
    query: check.query,
    purpose: check.purpose,
    needs: check.needs,
    coverageFacets: check.coverage_facets,
    limit: SEMANTIC_ABSENCE_LIMIT,
  });
  const forbidden = new Set(check.forbidden_entity_refs);
  const matched = search.results.filter(
    result => forbidden.has(result.entity_ref),
  );
  const passed = search.status === 'ready' && matched.length === 0;
  return {
    check_id: check.check_id,
    kind: check.kind,
    status: passed ? 'passed' : 'failed',
    observed: {
      search_status: search.status,
      result_count: search.results.length,
      inspected_result_limit: SEMANTIC_ABSENCE_LIMIT,
      forbidden_entity_hashes: matched.map(
        result => sha256(result.entity_ref),
      ),
    },
  };
}

export function createStoryMemorySemanticEvaluator({
  memoryReader,
  stateHistory,
} = {}) {
  if (
    typeof memoryReader?.search !== 'function'
    || typeof memoryReader?.read !== 'function'
    || typeof stateHistory?.stateAt !== 'function'
    || typeof stateHistory?.readTurn !== 'function'
    || typeof stateHistory?.listActiveCandidatesAt !== 'function'
  ) {
    throw new TypeError(
      'Story-memory semantic evaluator requires Memory Reader and State History.',
    );
  }

  return Object.freeze({
    schema: REPORT_SCHEMA,

    async evaluateCase(input) {
      assertCase(input);
      const semanticCase = structuredClone(input);
      const state = await stateHistory.stateAt({
        chatId: semanticCase.coordinate.chat_id,
        branchId: semanticCase.coordinate.branch_id,
        branchEpoch: semanticCase.coordinate.branch_epoch,
        turnIndex: semanticCase.coordinate.turn_index,
      });
      if (state?.status !== 'ready') {
        const error = new Error('Story-memory state is unavailable for evaluation.');
        error.code = 'STORY_MEMORY_SEMANTIC_STATE_UNAVAILABLE';
        throw error;
      }
      const active = await stateHistory.listActiveCandidatesAt({
        chatId: semanticCase.coordinate.chat_id,
        branchId: semanticCase.coordinate.branch_id,
        branchEpoch: semanticCase.coordinate.branch_epoch,
        turnIndex: semanticCase.coordinate.turn_index,
      });
      const activeCandidateIds = new Set(
        active.candidates.map(candidate => candidate.candidate_id),
      );
      const artifacts = new Map();
      const checks = [];
      for (const check of semanticCase.checks) {
        if (check.kind === 'current_state') {
          checks.push(currentStateResult(check, state));
          continue;
        }
        if (check.kind === 'retrieval') {
          checks.push(await retrievalResult(
            check,
            semanticCase.coordinate,
            memoryReader,
          ));
          continue;
        }
        if (check.kind === 'retrieval_absence') {
          checks.push(await retrievalAbsenceResult(
            check,
            semanticCase.coordinate,
            memoryReader,
          ));
          continue;
        }
        const key = canonicalJson([check.turn_id, check.candidate_id]);
        let artifact = artifacts.get(key);
        if (artifact === undefined && activeCandidateIds.has(check.candidate_id)) {
          artifact = await stateHistory.readTurn({
            chatId: semanticCase.coordinate.chat_id,
            turnId: check.turn_id,
            candidateId: check.candidate_id,
          });
          artifacts.set(key, artifact);
        }
        checks.push(typedRecordResult(
          check,
          artifact ?? null,
          activeCandidateIds.has(check.candidate_id),
        ));
      }
      const passed = checks.filter(check => check.status === 'passed').length;
      const report = {
        schema: REPORT_SCHEMA,
        case_id: semanticCase.case_id,
        case_hash: sha256(canonicalJson(semanticCase)),
        coordinate: structuredClone(semanticCase.coordinate),
        checks,
        summary: {
          total: checks.length,
          passed,
          failed: checks.length - passed,
        },
      };
      return deepFreeze({
        ...report,
        report_hash: sha256(canonicalJson(report)),
      });
    },
  });
}
