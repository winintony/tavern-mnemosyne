import { DatabaseSync } from 'node:sqlite';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { sha256 } from '../contracts/hash.js';
import {
  resolveBranchSegments,
  selectActiveTurnMemoryRows,
} from '../history/active-history-resolver.js';
import { readActiveLaneBodies } from '../craft/active-lane-bodies.js';
import {
  collectObligationDormancy,
  collectVerifiedRetrievalActivity,
} from '../craft/obligation-spotlight.js';

const SCHEMA = 'mnemosyne.dormant-threads.v1';

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

// M5 read-only "dormant threads" panel source. This is user-facing
// observability over the same deterministic dormancy derivation the
// Composer rotation uses. It exposes thread identifiers and numeric
// statistics only — never stakes, summaries, prompts, replies, queries, or
// any other narrative payload text — and it writes nothing.
export function createDormantThreadInspection({
  store,
  runJournal = null,
} = {}) {
  if (!store?.openChatForAdmin) {
    throw new Error(
      'Dormant thread inspection requires a trusted chat-save store.',
    );
  }

  return Object.freeze({
    async inspect({ chatId } = {}) {
      if (typeof chatId !== 'string' || !chatId.trim()) {
        fail(
          'dormant_threads_input_invalid',
          'Dormant thread inspection requires a chat id.',
        );
      }
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      let coordinate = null;
      let rows = [];
      try {
        const branch = database.prepare(`
          SELECT branch_id, branch_epoch
          FROM branch_epochs
          WHERE chat_id = ? AND status = 'active'
          ORDER BY branch_epoch DESC
          LIMIT 1
        `).get(chatId);
        if (branch) {
          const latest = database.prepare(`
            SELECT MAX(turns.turn_index) AS latest_turn_index
            FROM turns
            JOIN turn_candidates
              ON turn_candidates.turn_id = turns.turn_id
            JOIN patches
              ON patches.patch_id = turn_candidates.patch_id
            WHERE
              turns.chat_id = ?
              AND turns.branch_id = ?
              AND turns.status = 'committed'
              AND turn_candidates.status = 'active'
              AND patches.status = 'applied'
          `).get(chatId, branch.branch_id)?.latest_turn_index;
          if (Number.isInteger(latest)) {
            coordinate = {
              branchId: branch.branch_id,
              branchEpoch: branch.branch_epoch,
              visibleTurnIndex: latest,
            };
            const segments = resolveBranchSegments(database, {
              chatId,
              branchId: branch.branch_id,
              branchEpoch: branch.branch_epoch,
              turnIndex: latest,
            });
            rows = selectActiveTurnMemoryRows(database, {
              chatId,
              branchId: branch.branch_id,
              segments,
              order: 'ascending',
            });
          }
        }
      } finally {
        database.close();
      }
      if (!coordinate) {
        return {
          schema: SCHEMA,
          status: 'ready',
          threads: [],
          includes_story_content: false,
        };
      }
      const bodies = await readActiveLaneBodies({
        chatSavePath: opened.chat_save_path,
        ledgerPath: opened.ledger_path,
        chatId,
        branchId: coordinate.branchId,
        branchEpoch: coordinate.branchEpoch,
        throughTurnIndex: coordinate.visibleTurnIndex,
      });
      const baseDormancy = collectObligationDormancy({
        rows,
        bodies,
        visibleTurnIndex: coordinate.visibleTurnIndex,
      });
      let journals = [];
      if (runJournal?.list) {
        journals = (await runJournal.list({
          chatId,
          limit: 50,
        })).journals;
      }
      const retrievalActivity = runJournal?.list
        ? collectVerifiedRetrievalActivity({
            journals,
            dormancy: baseDormancy,
            activeCandidates: new Map(bodies.map(body => [
              body.turn_index,
              body.candidate_id,
            ])),
            chatId,
            branchId: coordinate.branchId,
            branchEpoch: coordinate.branchEpoch,
            throughTurnIndex: coordinate.visibleTurnIndex,
          })
        : {};
      const dormancy = collectObligationDormancy({
        rows,
        bodies,
        retrievalActivity,
        visibleTurnIndex: coordinate.visibleTurnIndex,
      });
      return {
        schema: SCHEMA,
        status: 'ready',
        includes_story_content: false,
        threads: dormancy.map(entry => ({
          thread_ref_hash: sha256(entry.thread_ref),
          thread_kind: entry.thread_kind,
          status: entry.status,
          dormancy_turns: entry.dormancy_turns,
          payoff_pending_age: entry.payoff_pending_age,
          appearance_count: entry.appearance_count,
          retrieval_citation_gap:
            entry.retrieval_count - entry.body_appearance_count,
        })),
      };
    },
  });
}
