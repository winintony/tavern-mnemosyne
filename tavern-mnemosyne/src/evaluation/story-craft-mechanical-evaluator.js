import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  verifyContinuityRulesEvent,
} from '../craft/continuity-rule-auditor.js';
import {
  verifyQualityMetricsEvent,
} from '../craft/quality-telemetry-pass.js';
import {
  SCENE_TURN_NULL_SCENE,
} from '../history/typed-turn-delta.js';

const REPORT_SCHEMA = 'mnemosyne.story-craft-mechanical-report.v1';
const ENGINE_VERSION = 'mnemosyne.story-craft-mechanics.v1';
const OPEN_STATUSES = new Set(['open', 'blocked', 'progressing']);

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'STORY_CRAFT_MECHANICAL_INPUT_INVALID';
  return error;
}

function parsePayload(row) {
  if (typeof row.record_payload_json !== 'string') return null;
  try {
    return JSON.parse(row.record_payload_json);
  } catch {
    throw invalid('A mechanical-evaluation payload is invalid JSON.');
  }
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function ratio(part, whole) {
  return whole === 0 ? null : round(part / whole);
}

function slope(points) {
  if (points.length < 2) return 0;
  const meanX = points.reduce(
    (sum, point) => sum + point.turn_index,
    0,
  ) / points.length;
  const meanY = points.reduce(
    (sum, point) => sum + point.value,
    0,
  ) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (
      (point.turn_index - meanX) * (point.value - meanY)
    );
    denominator += (point.turn_index - meanX) ** 2;
  }
  return round(denominator === 0 ? 0 : numerator / denominator);
}

function trajectorySummary(points) {
  const numeric = points.filter(point => (
    typeof point.value === 'number' && Number.isFinite(point.value)
  ));
  if (numeric.length === 0) {
    return {
      samples: 0,
      from_turn_index: null,
      through_turn_index: null,
      mean: null,
      slope: null,
    };
  }
  return {
    samples: numeric.length,
    from_turn_index: numeric[0].turn_index,
    through_turn_index: numeric.at(-1).turn_index,
    mean: round(
      numeric.reduce((sum, point) => sum + point.value, 0)
        / numeric.length,
    ),
    slope: slope(numeric),
  };
}

function overdueBucket(distance) {
  if (distance <= 0) return 'on_time';
  if (distance <= 3) return 'overdue_1_3';
  if (distance <= 10) return 'overdue_4_10';
  return 'overdue_11_plus';
}

function promiseMetrics(rows, visibleTurnIndex) {
  const promises = new Map();
  for (const row of rows) {
    if (row.record_kind !== 'plot_thread') continue;
    const payload = parsePayload(row);
    if (payload?.thread_kind !== 'promise') continue;
    const entry = promises.get(payload.thread_ref) ?? {
      due_by: null,
      latest: null,
    };
    if (Number.isInteger(payload.due_by)) {
      entry.due_by = payload.due_by;
    }
    entry.latest = { payload, turn_index: row.turn_index };
    promises.set(payload.thread_ref, entry);
  }
  const distribution = {
    on_time: 0,
    overdue_1_3: 0,
    overdue_4_10: 0,
    overdue_11_plus: 0,
    no_due_coordinate: 0,
  };
  let resolved = 0;
  let failed = 0;
  let open = 0;
  const resolvedDueErrors = [];
  for (const entry of promises.values()) {
    const status = entry.latest.payload.status;
    if (status === 'resolved') resolved += 1;
    else if (status === 'failed') failed += 1;
    else if (OPEN_STATUSES.has(status)) open += 1;
    if (entry.due_by === null) {
      distribution.no_due_coordinate += 1;
      continue;
    }
    const through = OPEN_STATUSES.has(status)
      ? visibleTurnIndex
      : entry.latest.turn_index;
    const dueDistance = through - entry.due_by;
    distribution[overdueBucket(dueDistance)] += 1;
    if (status === 'resolved') resolvedDueErrors.push(dueDistance);
  }
  const resolvedEarly = resolvedDueErrors.filter(value => value < 0).length;
  const resolvedOnTime = resolvedDueErrors.filter(value => value === 0).length;
  const resolvedLate = resolvedDueErrors.filter(value => value > 0).length;
  return {
    declared: promises.size,
    resolved,
    failed,
    open,
    realization_rate: ratio(resolved, promises.size),
    overdue_distribution: distribution,
    due_coordinate_calibration: {
      resolved_samples: resolvedDueErrors.length,
      early: resolvedEarly,
      on_time: resolvedOnTime,
      late: resolvedLate,
      on_time_rate: ratio(resolvedOnTime, resolvedDueErrors.length),
      mean_signed_turn_error: resolvedDueErrors.length === 0
        ? null
        : round(
            resolvedDueErrors.reduce((sum, value) => sum + value, 0)
              / resolvedDueErrors.length,
          ),
      mean_absolute_turn_error: resolvedDueErrors.length === 0
        ? null
        : round(
            resolvedDueErrors.reduce(
              (sum, value) => sum + Math.abs(value),
              0,
            ) / resolvedDueErrors.length,
          ),
    },
  };
}

function sceneSamples(rows) {
  const byTurn = new Map();
  const turnsWithSceneRows = new Set();
  for (const row of rows) {
    if (!['scene_event', 'scene_state'].includes(row.record_kind)) continue;
    turnsWithSceneRows.add(row.turn_index);
    const payload = parsePayload(row);
    if (!payload) continue;
    const sample = byTurn.get(row.turn_index) ?? {
      turn_index: row.turn_index,
      beat_type: null,
      polarity: null,
    };
    if (payload.beat_type !== null && payload.beat_type !== undefined) {
      sample.beat_type = payload.beat_type;
    }
    if (payload.scene_turn === SCENE_TURN_NULL_SCENE) {
      sample.polarity = SCENE_TURN_NULL_SCENE;
    } else if (payload.scene_turn?.polarity) {
      sample.polarity = payload.scene_turn.polarity;
    }
    byTurn.set(row.turn_index, sample);
  }
  return {
    samples: [...byTurn.values()]
      .filter(sample => (
        sample.beat_type !== null || sample.polarity !== null
      ))
      .sort((left, right) => left.turn_index - right.turn_index),
    unlabeled: turnsWithSceneRows.size
      - [...byTurn.values()].filter(sample => (
        sample.beat_type !== null || sample.polarity !== null
      )).length,
  };
}

function beatMetrics(rows) {
  const { samples, unlabeled } = sceneSamples(rows);
  let repeatedTransitions = 0;
  let transitions = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1].beat_type;
    const current = samples[index].beat_type;
    if (previous === null || current === null) continue;
    transitions += 1;
    if (previous === current) repeatedTransitions += 1;
  }
  const positive = samples.filter(
    sample => sample.polarity === 'positive',
  ).length;
  const nullScenes = samples.filter(
    sample => sample.polarity === SCENE_TURN_NULL_SCENE,
  ).length;
  return {
    labeled_scenes: samples.length,
    unlabeled_scene_turns: unlabeled,
    beat_transitions: transitions,
    repeated_beat_transitions: repeatedTransitions,
    beat_repeat_rate: ratio(repeatedTransitions, transitions),
    positive_ending_rate: ratio(positive, samples.length),
    null_scene_rate: ratio(nullScenes, samples.length),
  };
}

function metricTrajectories(events) {
  const series = new Map();
  for (const event of events) {
    for (const [metricId, metric] of Object.entries(event.metrics ?? {})) {
      if (typeof metric?.value !== 'number' || !Number.isFinite(metric.value)) {
        throw invalid('A quality trajectory metric is invalid.');
      }
      const values = series.get(metricId) ?? [];
      values.push({
        turn_index: event.coordinate.turn_index,
        value: metric.value,
      });
      series.set(metricId, values);
    }
  }
  return Object.fromEntries([...series.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([metricId, points]) => [
      metricId,
      trajectorySummary(points),
    ]));
}

function mechanicalTrajectories(rows, turnIndexes) {
  const series = {
    promise_realization_rate: [],
    promise_overdue_rate: [],
    beat_repeat_rate: [],
    positive_ending_rate: [],
    null_scene_rate: [],
  };
  for (const turnIndex of turnIndexes) {
    const throughRows = rows.filter(row => row.turn_index <= turnIndex);
    const promise = promiseMetrics(throughRows, turnIndex);
    const overdue = (
      promise.overdue_distribution.overdue_1_3
      + promise.overdue_distribution.overdue_4_10
      + promise.overdue_distribution.overdue_11_plus
    );
    const withDue = overdue + promise.overdue_distribution.on_time;
    const beat = beatMetrics(throughRows);
    for (const [metricId, value] of Object.entries({
      promise_realization_rate: promise.realization_rate,
      promise_overdue_rate: ratio(overdue, withDue),
      beat_repeat_rate: beat.beat_repeat_rate,
      positive_ending_rate: beat.positive_ending_rate,
      null_scene_rate: beat.null_scene_rate,
    })) {
      series[metricId].push({ turn_index: turnIndex, value });
    }
  }
  return Object.fromEntries(Object.entries(series).map(
    ([metricId, points]) => [metricId, trajectorySummary(points)],
  ));
}

export function evaluateStoryCraftMechanics({
  rows,
  activeCandidates,
  qualityEvents = [],
  continuityRuleEvents = [],
  dormancySnapshots = [],
  spotlightDecisions = [],
  visibleTurnIndex,
} = {}) {
  if (
    !Array.isArray(rows)
    || !(activeCandidates instanceof Map)
    || !Array.isArray(qualityEvents)
    || !Array.isArray(continuityRuleEvents)
    || !Array.isArray(dormancySnapshots)
    || !Array.isArray(spotlightDecisions)
    || !Number.isSafeInteger(visibleTurnIndex)
    || visibleTurnIndex < 0
  ) {
    throw invalid('Story craft mechanics need active-lane evidence.');
  }
  const activeTurnIndexes = [];
  for (const [turnIndex, candidateId] of activeCandidates) {
    if (
      !Number.isSafeInteger(turnIndex)
      || turnIndex < 0
      || typeof candidateId !== 'string'
      || !candidateId
    ) {
      throw invalid('An active candidate coordinate is invalid.');
    }
    if (turnIndex <= visibleTurnIndex) activeTurnIndexes.push(turnIndex);
  }
  activeTurnIndexes.sort((left, right) => left - right);
  const activeRows = rows.filter(row => {
    if (
      !Number.isSafeInteger(row?.turn_index)
      || row.turn_index < 0
      || typeof row.candidate_id !== 'string'
      || !row.candidate_id
    ) {
      throw invalid('A typed mechanical-evaluation row is invalid.');
    }
    return (
      row.turn_index <= visibleTurnIndex
      && activeCandidates.get(row.turn_index) === row.candidate_id
    );
  });
  const activeEvent = event => (
    Number.isSafeInteger(event?.coordinate?.turn_index)
    && event.coordinate.turn_index <= visibleTurnIndex
    && activeCandidates.get(event.coordinate.turn_index)
      === event.coordinate.candidate_id
  );
  const activeQuality = qualityEvents.filter(activeEvent);
  for (const event of activeQuality) verifyQualityMetricsEvent(event);
  activeQuality.sort((left, right) => (
    left.coordinate.turn_index - right.coordinate.turn_index
  ));
  const activeRules = continuityRuleEvents.filter(activeEvent);
  for (const event of activeRules) verifyContinuityRulesEvent(event);
  const ruleCounts = {};
  let hardCount = 0;
  for (const event of activeRules) {
    hardCount += event.summary.hard_count;
    for (const [ruleId, count] of Object.entries(
      event.summary.rule_counts,
    )) {
      ruleCounts[ruleId] = (ruleCounts[ruleId] ?? 0) + count;
    }
  }
  const activeDormancySnapshots = dormancySnapshots.filter(snapshot => {
    if (
      !Number.isSafeInteger(snapshot?.turn_index)
      || snapshot.turn_index < 0
      || typeof snapshot.candidate_id !== 'string'
      || !snapshot.candidate_id
      || !Array.isArray(snapshot.entries)
      || snapshot.entries.some(entry => (
        !Number.isSafeInteger(entry?.dormancy_turns)
        || entry.dormancy_turns < 0
      ))
    ) {
      throw invalid('A dormancy trajectory snapshot is invalid.');
    }
    return (
      snapshot.turn_index <= visibleTurnIndex
      && activeCandidates.get(snapshot.turn_index)
        === snapshot.candidate_id
    );
  });
  activeDormancySnapshots.sort((left, right) => (
    left.turn_index - right.turn_index
  ));
  const dormancyValues = activeDormancySnapshots.flatMap(
    snapshot => snapshot.entries.map(entry => entry.dormancy_turns),
  );
  const dormancyMeanPoints = activeDormancySnapshots.map(snapshot => ({
    turn_index: snapshot.turn_index,
    value: snapshot.entries.length === 0
      ? 0
      : snapshot.entries.reduce(
          (sum, entry) => sum + entry.dormancy_turns,
          0,
        ) / snapshot.entries.length,
  }));
  const eligibleRefs = new Set();
  const seatedRefs = new Set();
  let seatedInstances = 0;
  let activeRotationDecisions = 0;
  for (const decision of spotlightDecisions) {
    if (
      !Number.isSafeInteger(decision?.turn_index)
      || decision.turn_index < 0
      || typeof decision.candidate_id !== 'string'
      || !decision.candidate_id
      || !Array.isArray(decision.eligible_refs)
      || !Array.isArray(decision.seated_refs)
      || decision.eligible_refs.some(ref => typeof ref !== 'string' || !ref)
      || decision.seated_refs.some(ref => (
        typeof ref !== 'string'
        || !decision.eligible_refs.includes(ref)
      ))
    ) {
      throw invalid('A spotlight decision is invalid.');
    }
    if (
      decision.turn_index > visibleTurnIndex
      || activeCandidates.get(decision.turn_index)
        !== decision.candidate_id
    ) {
      continue;
    }
    activeRotationDecisions += 1;
    for (const ref of decision.eligible_refs) eligibleRefs.add(ref);
    for (const ref of decision.seated_refs) seatedRefs.add(ref);
    seatedInstances += decision.seated_refs.length;
  }
  const report = {
    schema: REPORT_SCHEMA,
    engine_version: ENGINE_VERSION,
    visible_turn_index: visibleTurnIndex,
    promise_payoff: promiseMetrics(activeRows, visibleTurnIndex),
    beat_rhythm: beatMetrics(activeRows),
    hard_contradictions: {
      evaluated_turns: activeRules.length,
      hard_count: hardCount,
      rate: ratio(hardCount, activeRules.length),
      rule_counts: Object.fromEntries(
        Object.entries(ruleCounts).sort(([left], [right]) => (
          left.localeCompare(right)
        )),
      ),
    },
    obligation_spotlight: {
      dormancy_samples: dormancyValues.length,
      dormancy_mean: dormancyValues.length === 0
        ? null
        : round(
            dormancyValues.reduce((sum, value) => sum + value, 0)
              / dormancyValues.length,
          ),
      dormancy_max: dormancyValues.length === 0
        ? null
        : Math.max(...dormancyValues),
      dormancy_mean_slope: dormancyMeanPoints.length === 0
        ? null
        : slope(dormancyMeanPoints),
      rotation_decisions: activeRotationDecisions,
      seated_instances: seatedInstances,
      unique_eligible: eligibleRefs.size,
      unique_seated: seatedRefs.size,
      rotation_coverage_rate: ratio(seatedRefs.size, eligibleRefs.size),
    },
    mechanical_trajectories: mechanicalTrajectories(
      activeRows,
      activeTurnIndexes,
    ),
    degradation_trajectories: metricTrajectories(activeQuality),
  };
  return Object.freeze({
    ...report,
    report_hash: sha256(canonicalJson(report)),
  });
}
