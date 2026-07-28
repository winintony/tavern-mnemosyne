import { MnemosyneRequestError } from '../contracts/errors.js';

// M1 Chekhov due ledger: a pure derivation over active-lane plot_thread
// rows. Due state is a state_at-style function of (active rows, visible turn
// index); it never reads wall-clock time, journals, or inactive candidates.
//
// Cross-epoch rule (explicit): due_by is a coordinate on the branch's visible
// turn axis. Truncation or swipe changes which declaration is the latest
// active one, and overdue distance is always
// `visible_turn_index - due_by` over that active set — epochs never rescale
// an already-declared deadline.

export const OPEN_PLOT_THREAD_STATUSES = Object.freeze([
  'open',
  'blocked',
  'progressing',
]);
const OPEN_STATUS_SET = new Set(OPEN_PLOT_THREAD_STATUSES);

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function parsePayload(row) {
  if (typeof row.record_payload_json !== 'string') return null;
  try {
    return JSON.parse(row.record_payload_json);
  } catch {
    fail(
      'promise_due_ledger_payload_invalid',
      'A plot_thread record payload is not valid JSON.',
      { record_id: row.record_id },
    );
  }
}

export function collectPromiseDueLedger({
  rows,
  visibleTurnIndex,
} = {}) {
  if (!Array.isArray(rows) || !Number.isInteger(visibleTurnIndex)
    || visibleTurnIndex < 0) {
    fail(
      'promise_due_ledger_input_invalid',
      'The due ledger needs active rows and a visible turn index.',
    );
  }
  const latest = new Map();
  const firstSeenTurn = new Map();
  for (const row of rows) {
    if (row.record_kind !== 'plot_thread') continue;
    const payload = parsePayload(row);
    if (!payload || typeof payload.thread_ref !== 'string') continue;
    if (!firstSeenTurn.has(payload.thread_ref)) {
      firstSeenTurn.set(payload.thread_ref, row.turn_index);
    }
    latest.set(payload.thread_ref, { row, payload });
  }

  const due = [];
  for (const [threadRef, { row, payload }] of latest) {
    if (!OPEN_STATUS_SET.has(payload.status)) continue;
    const dueBy = payload.due_by ?? null;
    if (!Number.isInteger(dueBy)) continue;
    if (visibleTurnIndex < dueBy) continue;
    due.push({
      thread_ref: threadRef,
      thread_kind: payload.thread_kind,
      status: payload.status,
      due_by_turn: dueBy,
      overdue_turns: visibleTurnIndex - dueBy,
      salience: payload.salience ?? null,
      setup_turn_index: firstSeenTurn.get(threadRef),
      record_entity_ref: row.entity_ref,
      source_ref: row.source_ref,
    });
  }

  due.sort((left, right) => (
    right.overdue_turns - left.overdue_turns
    || (right.salience ?? 0) - (left.salience ?? 0)
    || left.thread_ref.localeCompare(right.thread_ref)
  ));
  return due;
}

export function selectDuePromiseRows({
  rows,
  visibleTurnIndex,
  topK,
} = {}) {
  if (!Number.isInteger(topK) || topK < 1) {
    fail(
      'promise_due_ledger_input_invalid',
      'The due ledger needs a positive top-K bound.',
    );
  }
  return collectPromiseDueLedger({ rows, visibleTurnIndex }).slice(0, topK);
}
