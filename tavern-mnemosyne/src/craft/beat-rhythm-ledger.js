import { MnemosyneRequestError } from '../contracts/errors.js';
import {
  SCENE_TURN_NULL_SCENE,
} from '../history/typed-turn-delta.js';

// M2 beat rhythm ledger: a pure rolling-window derivation over active-lane
// scene_event/scene_state rows. It reports distribution facts only — no
// tension score, no writing directives (those stay with the active preset).
//
// Scene sampling rule (deterministic, explicit): one committed turn yields at
// most one scene sample. Rows are consumed in active-lane order; the last
// scene_event/scene_state row of a turn carrying a non-null beat_type wins
// the beat label, and the last row carrying a non-null scene_turn wins the
// turn label. Turns with no labeled row contribute no sample and are counted
// as unlabeled instead of being guessed.

const SCENE_KINDS = new Set(['scene_event', 'scene_state']);

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function parsePayload(row) {
  if (typeof row.record_payload_json !== 'string') return null;
  try {
    return JSON.parse(row.record_payload_json);
  } catch {
    fail(
      'beat_rhythm_payload_invalid',
      'A scene record payload is not valid JSON.',
      { record_id: row.record_id },
    );
  }
}

function collectSceneSamples(rows) {
  const byTurn = new Map();
  let unlabeledTurns = 0;
  const sceneTurns = new Set();
  for (const row of rows) {
    if (!SCENE_KINDS.has(row.record_kind)) continue;
    sceneTurns.add(row.turn_index);
    const payload = parsePayload(row);
    if (!payload) continue;
    const sample = byTurn.get(row.turn_index) ?? {
      turn_index: row.turn_index,
      beat_type: null,
      scene_turn: null,
    };
    if (payload.beat_type !== null && payload.beat_type !== undefined) {
      sample.beat_type = payload.beat_type;
    }
    if (payload.scene_turn !== null && payload.scene_turn !== undefined) {
      sample.scene_turn = payload.scene_turn;
    }
    byTurn.set(row.turn_index, sample);
  }
  const samples = [...byTurn.values()]
    .filter(sample => sample.beat_type !== null || sample.scene_turn !== null)
    .sort((left, right) => left.turn_index - right.turn_index);
  unlabeledTurns = sceneTurns.size - samples.length;
  return { samples, unlabeledTurns };
}

function tailRun(values, matches) {
  let run = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (!matches(values[index])) break;
    run += 1;
  }
  return run;
}

function polarityOf(sceneTurn) {
  if (sceneTurn === null || sceneTurn === undefined) return null;
  if (sceneTurn === SCENE_TURN_NULL_SCENE) return SCENE_TURN_NULL_SCENE;
  return sceneTurn.polarity ?? null;
}

export function computeBeatRhythm({
  rows,
  windowScenes,
  sequenceLength,
  triggerSameTypeRun,
  triggerPositiveRun,
} = {}) {
  if (
    !Array.isArray(rows)
    || !Number.isInteger(windowScenes) || windowScenes < 1
    || !Number.isInteger(sequenceLength) || sequenceLength < 1
    || !Number.isInteger(triggerSameTypeRun) || triggerSameTypeRun < 1
    || !Number.isInteger(triggerPositiveRun) || triggerPositiveRun < 1
  ) {
    fail(
      'beat_rhythm_input_invalid',
      'Beat rhythm needs active rows and positive window bounds.',
    );
  }
  const { samples, unlabeledTurns } = collectSceneSamples(rows);
  const window = samples.slice(-windowScenes);
  const beats = window.map(sample => sample.beat_type);
  const polarities = window.map(sample => polarityOf(sample.scene_turn));

  const lastBeat = beats.at(-1) ?? null;
  const sameTypeRun = lastBeat === null
    ? 0
    : tailRun(beats, beat => beat === lastBeat);
  const positiveEndingRun = tailRun(
    polarities,
    polarity => polarity === 'positive',
  );
  const nullSceneRun = tailRun(
    polarities,
    polarity => polarity === SCENE_TURN_NULL_SCENE,
  );
  let turnsSinceSetback = null;
  for (let index = window.length - 1; index >= 0; index -= 1) {
    if (window[index].beat_type === 'setback') {
      turnsSinceSetback = window.length - 1 - index;
      break;
    }
  }

  const statistics = {
    window_scenes: window.length,
    unlabeled_scene_turns: unlabeledTurns,
    beat_sequence: beats
      .slice(-sequenceLength)
      .map(beat => beat ?? 'unlabeled'),
    same_type_run: sameTypeRun,
    same_type_beat: sameTypeRun > 0 ? lastBeat : null,
    positive_ending_run: positiveEndingRun,
    null_scene_run: nullSceneRun,
    turns_since_setback: turnsSinceSetback,
  };
  const trigger = {
    same_type: sameTypeRun >= triggerSameTypeRun,
    positive_ending: positiveEndingRun >= triggerPositiveRun,
  };
  return {
    statistics,
    trigger,
    triggered: trigger.same_type || trigger.positive_ending,
  };
}
