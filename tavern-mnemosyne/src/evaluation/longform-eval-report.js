// Four-layer longform eval reporter (issue 19, slice 4).
//
// A pure function: combines already-computed per-turn
// mnemosyne.turn-capture-report.v1 and mnemosyne.story-memory-semantic-
// report.v1 rows (via turn-capture-rollup.v1 for the capture/
// continuation_use layers, and the oracle-declared layer_map for the
// governance_retrieval/semantic layers) into
// mnemosyne.longform-eval-report.v1.
//
// Behavioral priorities enforced here (see issue 19):
//  - No new evaluator: every number traces back to
//    evaluateTurnCaptureManifest / createStoryMemorySemanticEvaluator
//    output plus the rollup aggregator, never a new judgment.
//  - Anti-aggregation guard: the four layers stay siblings. There is no
//    top-level coherence/overall/total/aggregate/score scalar.
//  - Empty-layer guard: a layer with zero executed checks reports its
//    rate fields as null (never 1.0 or 0) and execution_census says so
//    explicitly.
//  - evidence_ledger: 'observation' -- fixture results are observation
//    data, never a quality claim.
//
// craft_dimensions is the fifth, craft-mechanics section (issue 19 slice
// 5): it directly passes through evaluateStoryCraftMechanics's
// promise_payoff / beat_rhythm / degradation_trajectories /
// obligation_spotlight / hard_contradictions, each independently scored
// with its own slope where applicable, never merged into the four layers'
// numbers (craftReport is the caller's already-computed, already-frozen
// mnemosyne.story-craft-mechanical-report.v1).

import { canonicalJson, sha256 } from '../contracts/hash.js';
import { rollupTurnCaptureReports } from './turn-capture-rollup.js';

const REPORT_SCHEMA = 'mnemosyne.longform-eval-report.v1';
const LAYER_KEYS = Object.freeze([
  'governance_retrieval',
  'semantic',
]);
const CRAFT_DIMENSION_KEYS = Object.freeze([
  'promise_payoff',
  'beat_rhythm',
  'degradation_trajectories',
  'obligation_spotlight',
  'hard_contradictions',
]);
// Quality-metrics lexicons (positivity/slop) are optional first-ship
// assets (issue 19 §五.7 language neutrality) -- when every quality event
// reports them disabled, the craft_dimensions census says so explicitly
// rather than silently reporting a full pass.
function craftDictionaryDisabled(qualityEvents) {
  return (
    qualityEvents.length > 0
    && qualityEvents.every(event => (
      event?.lexicons?.positivity?.status === 'disabled'
      && event?.lexicons?.slop?.status === 'disabled'
    ))
  );
}

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'LONGFORM_EVAL_REPORT_INPUT_INVALID';
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

// Story-memory-semantic-case coordinates carry no candidate_id (see
// assertCoordinate in story-memory-semantic-evaluator.js): a case is
// evaluated against stateAt()/listActiveCandidatesAt(), i.e. against
// whichever candidate is active at that turn_index at evaluation time,
// not against one fixed candidate. branch_epoch alone cannot disambiguate
// "active" here: after a branch_fork/truncate, turns before the cutoff
// are *inherited* by the new epoch, so their entries still carry the old
// epoch number yet remain fully active. The runner threads the
// candidate_id it evaluated each case under alongside the report (issue
// 19 slice 5), so the same activeCandidates: Map<turn_index,
// candidate_id> the capture rollup already uses is the single source of
// truth here too -- a turn_index whose active candidate has moved on
// (superseded by a swipe) or whose turn_index has been pruned by a
// truncate (activeCandidates no longer has that key) drops out exactly
// the same way a capture report would.
function isTurnActive(coordinate, candidateId, activeCandidates, visibleTurnIndex) {
  return (
    Number.isSafeInteger(coordinate?.turn_index)
    && coordinate.turn_index <= visibleTurnIndex
    && activeCandidates.get(coordinate.turn_index) === candidateId
  );
}

function censusEntry(executed, total) {
  const skipped = total - executed;
  const skipReasons = [];
  if (total === 0) skipReasons.push('oracle_missing');
  else if (skipped > 0) skipReasons.push('inactive_lane');
  return { executed, skipped, skip_reasons: skipReasons };
}

function partitionSemanticLayer({
  layerKey,
  semanticEntries,
  activeCandidates,
  visibleTurnIndex,
}) {
  const checks = [];
  let totalConsidered = 0;
  for (const entry of semanticEntries) {
    if (
      !isObject(entry)
      || !isObject(entry.report)
      || !Array.isArray(entry.report.checks)
      || !isObject(entry.report.coordinate)
      || !isObject(entry.layer_map)
      || typeof entry.candidate_id !== 'string'
      || !entry.candidate_id
    ) {
      throw invalid('A semantic report entry is not well-formed.');
    }
    const active = isTurnActive(
      entry.report.coordinate,
      entry.candidate_id,
      activeCandidates,
      visibleTurnIndex,
    );
    for (const check of entry.report.checks) {
      if (entry.layer_map[check.check_id] !== layerKey) continue;
      totalConsidered += 1;
      if (!active) continue;
      checks.push({
        turn_index: entry.report.coordinate.turn_index,
        candidate_id: entry.candidate_id,
        check_id: check.check_id,
        kind: check.kind,
        status: check.status,
      });
    }
  }
  const passed = checks.filter(check => check.status === 'passed').length;
  return {
    layer: {
      executed: checks.length,
      passed,
      rate: ratio(passed, checks.length),
      checks,
    },
    census: censusEntry(checks.length, totalConsidered),
  };
}

// captureEntries: array of turn-capture-report.v1 rows (all candidates,
// active or not, on any epoch ever visited -- rollupTurnCaptureReports
// filters to the active lane via activeCandidates, so a superseded
// candidate (old swipe, or a turn_index a truncate pruned out of
// activeCandidates) drops out and an *inherited* turn (same candidate_id,
// older branch_epoch, still the active one) correctly stays in).
//
// semanticEntries: array of { report: story-memory-semantic-report.v1,
// layer_map: { check_id -> 'governance_retrieval' | 'semantic' },
// candidate_id }, one entry per evaluated turn/candidate (layer_map and
// candidate_id travel with the oracle/script pair the runner evaluated
// this case under, per issue 19 section 1 and the "定版增补" step layout;
// story-memory-semantic-case coordinates carry no candidate_id of their
// own, so the runner supplies it for active-lane filtering).
//
// craftReport: the already-computed, already-frozen
// mnemosyne.story-craft-mechanical-report.v1 (from
// evaluateStoryCraftMechanics) for the same active lane, or null when the
// caller has no craft evidence to offer (its census then shows executed:
// 0, never a fabricated pass).
//
// qualityEvents: the raw mnemosyne.quality-metrics.v1 events that fed
// craftReport's degradation_trajectories -- used only to decide whether
// execution_census.craft_dimensions notes the dictionary_disabled skip
// reason (issue 19 §五.7 language neutrality); craftReport itself does
// not carry per-event lexicon status.
export function buildLongformEvalReport({
  fixtureId,
  fixtureHash,
  providerMode,
  captureEntries,
  semanticEntries,
  activeCandidates,
  visibleTurnIndex,
  craftReport = null,
  qualityEvents = [],
} = {}) {
  if (
    typeof fixtureId !== 'string' || !fixtureId
    || typeof fixtureHash !== 'string' || !fixtureHash
    || !['scripted', 'audit'].includes(providerMode)
    || !Array.isArray(captureEntries)
    || !Array.isArray(semanticEntries)
    || !(activeCandidates instanceof Map)
    || !Number.isSafeInteger(visibleTurnIndex)
    || visibleTurnIndex < 0
    || !Array.isArray(qualityEvents)
  ) {
    throw invalid('Longform eval report inputs are incomplete.');
  }

  const rollup = rollupTurnCaptureReports({
    captureReports: captureEntries,
    activeCandidates,
    visibleTurnIndex,
  });

  const captureLayer = {
    facets: rollup.facets,
    source_correctness: rollup.source_correctness,
  };
  const captureCensus = censusEntry(
    rollup.active_turns,
    rollup.turns_considered,
  );

  const continuationExecuted = (
    rollup.active_turns - rollup.continuation_use_histogram.not_evaluated
  );
  const continuationLayer = {
    histogram: rollup.continuation_use_histogram,
  };
  const continuationCensus = censusEntry(
    continuationExecuted,
    rollup.active_turns,
  );

  const layers = {};
  const layerCensus = {};
  for (const layerKey of LAYER_KEYS) {
    const { layer, census } = partitionSemanticLayer({
      layerKey,
      semanticEntries,
      activeCandidates,
      visibleTurnIndex,
    });
    layers[layerKey] = layer;
    layerCensus[layerKey] = census;
  }

  const craftDimensions = craftReport === null
    ? null
    : Object.fromEntries(CRAFT_DIMENSION_KEYS.map(key => [
        key,
        craftReport[key] ?? null,
      ]));
  const craftDictionarySkip = craftDictionaryDisabled(
    qualityEvents,
  );
  const craftCensus = {
    executed: craftReport === null ? 0 : 1,
    skipped: craftReport === null ? 1 : 0,
    skip_reasons: [
      ...(craftReport === null ? ['oracle_missing'] : []),
      ...(craftDictionarySkip ? ['dictionary_disabled'] : []),
    ],
  };

  const report = {
    schema: REPORT_SCHEMA,
    evidence_ledger: 'observation',
    provider_mode: providerMode,
    fixture_id: fixtureId,
    fixture_hash: fixtureHash,
    visible_turn_index: visibleTurnIndex,
    capture: captureLayer,
    governance_retrieval: layers.governance_retrieval,
    semantic: layers.semantic,
    continuation_use: continuationLayer,
    craft_dimensions: craftDimensions,
    execution_census: {
      capture: captureCensus,
      governance_retrieval: layerCensus.governance_retrieval,
      semantic: layerCensus.semantic,
      continuation_use: continuationCensus,
      craft_dimensions: craftCensus,
    },
  };
  return Object.freeze({
    ...report,
    report_hash: sha256(canonicalJson(report)),
  });
}

export const LONGFORM_EVAL_REPORT_SCHEMA = REPORT_SCHEMA;
