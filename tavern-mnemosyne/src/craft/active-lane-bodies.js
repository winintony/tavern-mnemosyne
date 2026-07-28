import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { sha256 } from '../contracts/hash.js';
import {
  resolveBranchSegments,
} from '../history/active-history-resolver.js';

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

// Reads the committed assistant bodies of the active lane from sealed turn
// artifacts, verifying each body against its ledger body_hash. Tampered or
// unreadable artifacts fail closed instead of feeding silent statistics.
export async function readActiveLaneBodies({
  chatSavePath,
  ledgerPath,
  chatId,
  branchId,
  branchEpoch,
  throughTurnIndex,
  limitTurns = null,
} = {}) {
  if (
    typeof chatSavePath !== 'string' || !chatSavePath
    || typeof ledgerPath !== 'string' || !ledgerPath
    || typeof chatId !== 'string' || !chatId
    || typeof branchId !== 'string' || !branchId
    || !Number.isInteger(branchEpoch) || branchEpoch < 0
    || !Number.isInteger(throughTurnIndex) || throughTurnIndex < 0
    || (limitTurns !== null
      && (!Number.isInteger(limitTurns) || limitTurns < 1))
  ) {
    fail(
      'active_lane_bodies_input_invalid',
      'Active-lane body reads need exact chat coordinates.',
    );
  }
  const database = new DatabaseSync(ledgerPath, { readOnly: true });
  let candidateRows;
  try {
    const branchExists = database.prepare(`
      SELECT 1
      FROM branch_epochs
      WHERE chat_id = ? AND branch_id = ? AND branch_epoch = ?
    `).get(chatId, branchId, branchEpoch);
    if (!branchExists) return [];
    const segments = resolveBranchSegments(database, {
      chatId,
      branchId,
      branchEpoch,
      turnIndex: throughTurnIndex,
    });
    const statement = database.prepare(`
      SELECT
        turns.turn_index,
        turn_candidates.candidate_id,
        turn_candidates.body_hash,
        turn_candidates.artifact_path
      FROM turns
      JOIN turn_candidates
        ON turn_candidates.turn_id = turns.turn_id
      JOIN patches
        ON patches.patch_id = turn_candidates.patch_id
      WHERE
        turns.chat_id = ?
        AND turns.branch_id = ?
        AND turns.branch_epoch = ?
        AND turns.turn_index <= ?
        AND turns.status = 'committed'
        AND turn_candidates.status = 'active'
        AND patches.status = 'applied'
      ORDER BY turns.turn_index ASC
    `);
    candidateRows = segments.flatMap(segment => statement.all(
      chatId,
      branchId,
      segment.branch_epoch,
      segment.through_turn_index,
    ));
  } finally {
    database.close();
  }
  candidateRows.sort((left, right) => left.turn_index - right.turn_index);
  const selected = limitTurns === null
    ? candidateRows
    : candidateRows.slice(-limitTurns);

  const bodies = [];
  for (const row of selected) {
    if (typeof row.artifact_path !== 'string' || !row.artifact_path) {
      fail(
        'active_lane_body_unsealed',
        'An active candidate has no sealed turn artifact path.',
        { turn_index: row.turn_index, candidate_id: row.candidate_id },
      );
    }
    let artifact;
    try {
      artifact = JSON.parse(await readFile(
        path.join(chatSavePath, row.artifact_path),
        'utf8',
      ));
    } catch {
      fail(
        'active_lane_body_unreadable',
        'A sealed turn artifact for the active lane cannot be read.',
        { turn_index: row.turn_index, candidate_id: row.candidate_id },
      );
    }
    const body = artifact?.assistant_message?.content;
    if (typeof body !== 'string' || sha256(body) !== row.body_hash) {
      fail(
        'active_lane_body_hash_mismatch',
        'A sealed turn artifact body no longer matches its ledger hash.',
        { turn_index: row.turn_index, candidate_id: row.candidate_id },
      );
    }
    bodies.push({
      turn_index: row.turn_index,
      candidate_id: row.candidate_id,
      body,
    });
  }
  return bodies;
}
