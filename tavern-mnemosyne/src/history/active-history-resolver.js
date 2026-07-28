import { MnemosyneRequestError } from '../contracts/errors.js';

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

export function resolveBranchSegments(database, {
  chatId,
  branchId,
  branchEpoch,
  turnIndex,
}) {
  const segments = [];
  const visited = new Set();

  function visit(epoch, throughTurnIndex) {
    if (visited.has(epoch)) {
      fail(
        'branch_epoch_cycle',
        'Branch epoch ancestry contains a cycle.',
      );
    }
    visited.add(epoch);
    const row = database.prepare(`
      SELECT
        parent_branch_epoch,
        parent_cutoff_turn_index_exclusive
      FROM branch_epochs
      WHERE chat_id = ? AND branch_id = ? AND branch_epoch = ?
    `).get(chatId, branchId, epoch);
    if (!row) {
      fail(
        'branch_epoch_not_found',
        'The requested branch epoch does not exist.',
      );
    }
    if (row.parent_branch_epoch !== null) {
      visit(
        row.parent_branch_epoch,
        Math.min(
          throughTurnIndex,
          row.parent_cutoff_turn_index_exclusive - 1,
        ),
      );
    }
    segments.push({
      branch_epoch: epoch,
      through_turn_index: throughTurnIndex,
    });
  }

  visit(branchEpoch, turnIndex);
  return segments;
}

export function selectActiveTurnMemoryRows(database, {
  chatId,
  branchId,
  segments,
  recordId = null,
  stateOnly = false,
  order = 'ascending',
}) {
  if (!['ascending', 'descending'].includes(order)) {
    throw new Error('Active history row order is invalid.');
  }
  const direction = order === 'ascending' ? 'ASC' : 'DESC';
  const stateClause = stateOnly
    ? `
      AND turn_memory_records.state_domain IS NOT NULL
      AND turn_memory_records.state_key IS NOT NULL
    `
    : '';
  const statement = database.prepare(`
    SELECT
      turns.turn_index,
      turns.branch_id,
      turns.branch_epoch,
      turns.turn_id,
      turn_candidates.candidate_id,
      patches.patch_id,
      turn_memory_records.sequence_index,
      turn_memory_records.record_id,
      turn_memory_records.record_kind,
      turn_memory_records.entity_ref,
      turn_memory_records.summary,
      turn_memory_records.state_domain,
      turn_memory_records.state_key,
      turn_memory_records.state_value_json,
      turn_memory_records.state_operation,
      turn_memory_records.record_payload_json,
      turn_memory_records.source_ref,
      turn_memory_records.source_start,
      turn_memory_records.source_end,
      turn_memory_records.source_mode,
      turn_memory_records.support_strength
    FROM turn_memory_records
    JOIN patches
      ON patches.patch_id = turn_memory_records.patch_id
    JOIN turn_candidates
      ON turn_candidates.candidate_id = turn_memory_records.candidate_id
    JOIN turns
      ON turns.turn_id = turn_candidates.turn_id
    WHERE
      turns.chat_id = ?
      AND turns.branch_id = ?
      AND turns.branch_epoch = ?
      AND turns.turn_index <= ?
      AND turns.status = 'committed'
      AND turn_candidates.status = 'active'
      AND patches.status = 'applied'
      AND turn_memory_records.status = 'active'
      AND (? IS NULL OR turn_memory_records.record_id = ?)
      ${stateClause}
    ORDER BY
      turns.turn_index ${direction},
      turn_memory_records.sequence_index ASC,
      turn_memory_records.record_id ASC
  `);
  return segments.flatMap(segment => statement.all(
    chatId,
    branchId,
    segment.branch_epoch,
    segment.through_turn_index,
    recordId,
    recordId,
  ));
}
