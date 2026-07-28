// Cross-turn capture rollup (issue 19, slice 3 -- closes milestone
// condition 2). A pure function: it aggregates an array of already-computed
// mnemosyne.turn-capture-report.v1 objects (one per evaluated turn
// candidate, active or not) into cross-turn facet recall, source
// correctness, abstention rate, update/supersede rate, and a four-state
// continuation-use histogram.
//
// It is a derived view of state_at, not an append-only log: it takes the
// same activeCandidates: Map<turn_index, candidate_id> + visibleTurnIndex
// convention already used by evaluateStoryCraftMechanics
// (src/evaluation/story-craft-mechanical-evaluator.js) so callers can
// recompute it after a swipe/branch/truncate and have superseded turns
// drop out of every denominator automatically.

import { canonicalJson, sha256 } from '../contracts/hash.js';
import { STORY_COVERAGE_FACETS } from '../memory/story-coverage.js';

const ROLLUP_SCHEMA = 'mnemosyne.turn-capture-rollup.v1';
const CONTINUATION_OUTCOMES = Object.freeze([
  'correct_use',
  'retrieved_but_unused',
  'used_wrong_version',
  'correct_use_with_contradiction',
  'not_evaluated',
]);

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'TURN_CAPTURE_ROLLUP_INPUT_INVALID';
  return error;
}

function isObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function ratio(part, whole) {
  return whole === 0 ? null : part / whole;
}

export function rollupTurnCaptureReports({
  captureReports,
  activeCandidates,
  visibleTurnIndex,
} = {}) {
  if (
    !Array.isArray(captureReports)
    || !(activeCandidates instanceof Map)
    || !Number.isSafeInteger(visibleTurnIndex)
    || visibleTurnIndex < 0
  ) {
    throw invalid(
      'Turn capture rollup needs report rows and active-lane evidence.',
    );
  }
  for (const [turnIndex, candidateId] of activeCandidates) {
    if (
      !Number.isSafeInteger(turnIndex)
      || turnIndex < 0
      || typeof candidateId !== 'string'
      || !candidateId
    ) {
      throw invalid('An active candidate coordinate is invalid.');
    }
  }
  const activeReports = captureReports.filter(report => {
    if (
      !isObject(report)
      || !isObject(report.coordinate)
      || !Number.isSafeInteger(report.coordinate.turn_index)
      || typeof report.coordinate.candidate_id !== 'string'
      || !isObject(report.capture)
      || !isObject(report.capture.facets)
      || !isObject(report.source_correctness)
      || !isObject(report.abstention)
      || !isObject(report.update_supersede)
      || !isObject(report.continuation_use)
      || !CONTINUATION_OUTCOMES.includes(report.continuation_use.outcome)
    ) {
      throw invalid('A turn-capture-report row is not well-formed.');
    }
    return (
      report.coordinate.turn_index <= visibleTurnIndex
      && activeCandidates.get(report.coordinate.turn_index)
        === report.coordinate.candidate_id
    );
  });

  const facets = Object.fromEntries(STORY_COVERAGE_FACETS.map(facet => [
    facet,
    { expected: 0, captured: 0, recall: null },
  ]));
  let sourceExpected = 0;
  let sourceCorrect = 0;
  let abstentionExpected = 0;
  let abstentionCorrect = 0;
  let updateExpected = 0;
  let updateCorrect = 0;
  const continuationHistogram = Object.fromEntries(
    CONTINUATION_OUTCOMES.map(outcome => [outcome, 0]),
  );

  for (const report of activeReports) {
    for (const facet of STORY_COVERAGE_FACETS) {
      const facetReport = report.capture.facets[facet];
      if (!isObject(facetReport)) {
        throw invalid(`Turn-capture-report facet "${facet}" is missing.`);
      }
      facets[facet].expected += facetReport.expected ?? 0;
      facets[facet].captured += facetReport.captured ?? 0;
    }
    sourceExpected += report.source_correctness.expected ?? 0;
    sourceCorrect += report.source_correctness.correct ?? 0;
    abstentionExpected += report.abstention.expected ?? 0;
    abstentionCorrect += report.abstention.correct ?? 0;
    updateExpected += report.update_supersede.expected ?? 0;
    updateCorrect += report.update_supersede.correct ?? 0;
    continuationHistogram[report.continuation_use.outcome] += 1;
  }
  for (const value of Object.values(facets)) {
    value.recall = ratio(value.captured, value.expected);
  }

  const report = {
    schema: ROLLUP_SCHEMA,
    visible_turn_index: visibleTurnIndex,
    turns_considered: captureReports.length,
    active_turns: activeReports.length,
    facets,
    source_correctness: {
      expected: sourceExpected,
      correct: sourceCorrect,
      rate: ratio(sourceCorrect, sourceExpected),
    },
    abstention: {
      expected: abstentionExpected,
      correct: abstentionCorrect,
      rate: ratio(abstentionCorrect, abstentionExpected),
    },
    update_supersede: {
      expected: updateExpected,
      correct: updateCorrect,
      rate: ratio(updateCorrect, updateExpected),
    },
    continuation_use_histogram: continuationHistogram,
  };
  return Object.freeze({
    ...report,
    report_hash: sha256(canonicalJson(report)),
  });
}

export const TURN_CAPTURE_ROLLUP_SCHEMA = ROLLUP_SCHEMA;
export const TURN_CAPTURE_ROLLUP_CONTINUATION_OUTCOMES = CONTINUATION_OUTCOMES;
