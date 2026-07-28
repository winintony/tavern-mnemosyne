import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';

// M5 deterministic director layer, statistics half. Everything here is a
// pure function of active-lane rows, hash-verified committed bodies, and the
// visible turn index. The outputs are internal salience evidence: they feed
// the Composer seat rotation and the read-only Memory Activity panel, and
// are never rendered as a model-visible pressure map.
//
// "Appearance" detection is deliberately conservative (宁漏勿误):
// - record-write channel: a plot_thread row for the thread itself;
// - ref-citation channel: another typed record whose payload contains the
//   exact thread ref URI;
// - lexical channel: a committed body containing the thread's exact stakes
//   or open_question string. Paraphrases are intentionally missed rather
//   than guessed.

const OPEN_STATUSES = new Set(['open', 'blocked', 'progressing']);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function parsePayload(row) {
  if (typeof row.record_payload_json !== 'string') return null;
  try {
    return JSON.parse(row.record_payload_json);
  } catch {
    fail(
      'obligation_spotlight_payload_invalid',
      'A typed record payload is not valid JSON.',
      { record_id: row.record_id },
    );
  }
}

export function collectObligationDormancy({
  rows,
  bodies = [],
  retrievalActivity = {},
  visibleTurnIndex,
} = {}) {
  if (
    !Array.isArray(rows)
    || !Array.isArray(bodies)
    || !isPlainObject(retrievalActivity)
    || !Number.isInteger(visibleTurnIndex)
    || visibleTurnIndex < 0
  ) {
    fail(
      'obligation_spotlight_input_invalid',
      'Dormancy needs active rows, verified bodies, and a turn index.',
    );
  }

  const threads = new Map();
  for (const row of rows) {
    if (row.record_kind !== 'plot_thread') continue;
    const payload = parsePayload(row);
    if (!payload || typeof payload.thread_ref !== 'string') continue;
    const entry = threads.get(payload.thread_ref) ?? {
      thread_ref: payload.thread_ref,
      first_seen_turn: row.turn_index,
      last_appearance_turn: row.turn_index,
      appearance_turns: new Set(),
      body_appearance_turns: new Set(),
      record_refs: new Set(),
      latest: null,
    };
    entry.appearance_turns.add(row.turn_index);
    entry.body_appearance_turns.add(row.turn_index);
    entry.record_refs.add(row.entity_ref);
    entry.last_appearance_turn = Math.max(
      entry.last_appearance_turn,
      row.turn_index,
    );
    entry.latest = { row, payload };
    threads.set(payload.thread_ref, entry);
  }

  for (const row of rows) {
    if (row.record_kind === 'plot_thread') continue;
    if (typeof row.record_payload_json !== 'string') continue;
    for (const entry of threads.values()) {
      if (row.record_payload_json.includes(entry.thread_ref)) {
        entry.appearance_turns.add(row.turn_index);
        entry.body_appearance_turns.add(row.turn_index);
        entry.last_appearance_turn = Math.max(
          entry.last_appearance_turn,
          row.turn_index,
        );
      }
    }
  }

  for (const { turn_index: turnIndex, body } of bodies) {
    if (typeof body !== 'string' || !body) continue;
    for (const entry of threads.values()) {
      const anchors = [
        entry.latest?.payload?.stakes,
        entry.latest?.payload?.open_question,
      ].filter(anchor => typeof anchor === 'string' && anchor.trim());
      if (anchors.some(anchor => body.includes(anchor))) {
        entry.appearance_turns.add(turnIndex);
        entry.body_appearance_turns.add(turnIndex);
        entry.last_appearance_turn = Math.max(
          entry.last_appearance_turn,
          turnIndex,
        );
      }
    }
  }

  const dormancy = [];
  for (const entry of threads.values()) {
    const retrieval = retrievalActivity[entry.thread_ref];
    if (retrieval !== undefined) {
      if (
        !isPlainObject(retrieval)
        || !Number.isSafeInteger(retrieval.count)
        || retrieval.count < 0
        || !Array.isArray(retrieval.turns)
        || retrieval.turns.some(turn => (
          !Number.isInteger(turn)
          || turn < 0
          || turn > visibleTurnIndex
        ))
      ) {
        fail(
          'obligation_spotlight_retrieval_invalid',
          'Retrieval activity is not a valid sealed citation summary.',
        );
      }
      for (const turn of retrieval.turns) {
        entry.appearance_turns.add(turn);
        entry.last_appearance_turn = Math.max(
          entry.last_appearance_turn,
          turn,
        );
      }
    }
    const status = entry.latest?.payload?.status;
    if (!OPEN_STATUSES.has(status)) continue;
    dormancy.push({
      thread_ref: entry.thread_ref,
      thread_kind: entry.latest.payload.thread_kind,
      status,
      record_entity_ref: entry.latest.row.entity_ref,
      record_refs: [...entry.record_refs].sort(),
      dormancy_turns: visibleTurnIndex - entry.last_appearance_turn,
      payoff_pending_age: visibleTurnIndex - entry.first_seen_turn,
      appearance_count: entry.appearance_turns.size,
      body_appearance_count: entry.body_appearance_turns.size,
      retrieval_count: retrieval?.count ?? 0,
      last_appearance_turn: entry.last_appearance_turn,
      first_seen_turn: entry.first_seen_turn,
    });
  }
  dormancy.sort((left, right) => (
    right.dormancy_turns - left.dormancy_turns
    || left.thread_ref.localeCompare(right.thread_ref)
  ));
  return dormancy;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

// Converts completed, hash-sealed memory-search results into exact reference
// citations for the active lane. Old swipe candidates and other branch/epoch
// journals are ignored; malformed matching events fail closed.
export function collectVerifiedRetrievalActivity({
  journals,
  dormancy,
  activeCandidates,
  chatId,
  branchId,
  branchEpoch,
  throughTurnIndex,
} = {}) {
  if (
    !Array.isArray(journals)
    || !Array.isArray(dormancy)
    || !(activeCandidates instanceof Map)
    || typeof chatId !== 'string' || !chatId
    || typeof branchId !== 'string' || !branchId
    || !Number.isInteger(branchEpoch) || branchEpoch < 0
    || !Number.isInteger(throughTurnIndex) || throughTurnIndex < 0
  ) {
    fail(
      'obligation_spotlight_retrieval_invalid',
      'Retrieval citations need journals and exact active coordinates.',
    );
  }
  const threadByReference = new Map();
  const activity = {};
  for (const entry of dormancy) {
    const references = [
      entry.thread_ref,
      ...(Array.isArray(entry.record_refs) ? entry.record_refs : []),
    ];
    for (const ref of references) {
      if (typeof ref !== 'string' || !ref) continue;
      const threads = threadByReference.get(ref) ?? new Set();
      threads.add(entry.thread_ref);
      threadByReference.set(ref, threads);
    }
    activity[entry.thread_ref] = {
      count: 0,
      turns: [],
    };
  }

  for (const journal of journals) {
    const scope = journal?.run_scope;
    if (
      journal?.chat_id !== chatId
      || scope?.chat_id !== chatId
      || scope?.branch_id !== branchId
      || scope?.branch_epoch !== branchEpoch
      || !Number.isInteger(scope?.turn_index)
      || scope.turn_index > throughTurnIndex
      || activeCandidates.get(scope.turn_index) !== scope.candidate_id
    ) {
      continue;
    }
    const events = Array.isArray(journal.events) ? journal.events : [];
    for (const event of events) {
      if (event?.tool !== 'memory_search') continue;
      if (
        event.type !== 'tool_completed'
        || !isPlainObject(event.result)
        || event.result.schema !== 'mnemosyne.memory-search-result.v2'
        || event.result.status !== 'ready'
        || !Array.isArray(event.result.results)
        || !HASH_PATTERN.test(event.result_hash ?? '')
        || event.result_hash !== sha256(canonicalJson(event.result))
      ) {
        fail(
          'obligation_spotlight_retrieval_invalid',
          'A matching memory-search event is not a sealed completed result.',
        );
      }
      const citedThreads = new Set();
      for (const result of event.result.results) {
        if (!isPlainObject(result)) {
          fail(
            'obligation_spotlight_retrieval_invalid',
            'A matching memory-search result entry is invalid.',
          );
        }
        for (const ref of [result.ref, result.entity_ref]) {
          const threads = threadByReference.get(ref);
          if (!threads) continue;
          for (const threadRef of threads) {
            citedThreads.add(threadRef);
          }
        }
      }
      for (const threadRef of citedThreads) {
        activity[threadRef].count += 1;
        activity[threadRef].turns.push(scope.turn_index);
      }
    }
  }
  for (const entry of Object.values(activity)) {
    entry.turns = [...new Set(entry.turns)].sort((left, right) => (
      left - right
    ));
  }
  return activity;
}

// Seat rotation: the trailing `quotaSeats` positions of the capped
// obligations lane belong to the most dormant open threads that would not
// otherwise be visible. Two factors only — dormancy first, current-scene
// relevance as the tie preference — with a lexicographic thread_ref
// tiebreak so replay rebuilds the identical seating.
export function applySpotlightRotation({
  obligations,
  dormancy,
  laneCapacity,
  quotaSeats,
  sceneRefs = [],
} = {}) {
  if (
    !Array.isArray(obligations)
    || !Array.isArray(dormancy)
    || !Number.isInteger(laneCapacity) || laneCapacity < 1
    || !Number.isInteger(quotaSeats) || quotaSeats < 0
  ) {
    fail(
      'obligation_spotlight_input_invalid',
      'Spotlight rotation needs lanes, dormancy, and seat bounds.',
    );
  }
  const capped = obligations.slice(0, laneCapacity);
  if (quotaSeats === 0 || obligations.length <= capped.length) {
    return { lane: capped, seated_refs: [] };
  }
  const seatCount = Math.min(quotaSeats, capped.length);
  const headCount = capped.length - seatCount;
  const head = capped.slice(0, headCount);
  const headRefs = new Set(head.map(item => item.ref));

  const dormancyByRef = new Map(dormancy.map(entry => [
    entry.record_entity_ref,
    entry,
  ]));
  const sceneRefSet = new Set(
    sceneRefs.filter(ref => typeof ref === 'string' && ref),
  );
  const sceneRelevant = item => {
    const refs = [
      ...(Array.isArray(item.actor_refs) ? item.actor_refs : []),
      ...(Array.isArray(item.target_refs) ? item.target_refs : []),
    ];
    return refs.some(ref => sceneRefSet.has(ref)) ? 1 : 0;
  };
  const candidates = obligations
    .filter(item => !headRefs.has(item.ref))
    .map(item => ({
      item,
      dormancy_turns: dormancyByRef.get(item.ref)?.dormancy_turns ?? 0,
      scene_relevant: sceneRelevant(item),
    }))
    .sort((left, right) => (
      right.dormancy_turns - left.dormancy_turns
      || right.scene_relevant - left.scene_relevant
      || left.item.ref.localeCompare(right.item.ref)
    ));
  const seated = candidates.slice(0, seatCount).map(entry => entry.item);
  const seatedRefs = seated.map(item => item.ref);
  const lane = [...head, ...seated];
  for (const item of capped.slice(headCount)) {
    if (lane.length >= capped.length) break;
    if (!lane.some(existing => existing.ref === item.ref)) {
      lane.push(item);
    }
  }
  return { lane, seated_refs: seatedRefs };
}
