import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson } from '../contracts/hash.js';

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function assertId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    fail('run_journal_identity_invalid', `${field} is invalid.`, { field });
  }
}

function assertOpaqueHostId(value, field) {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 2048
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail('run_journal_identity_invalid', `${field} is invalid.`, { field });
  }
}

function journalRelativePath(runId) {
  return path.posix.join('run-journals', `${runId}.json`);
}

function journalDirectoryPath(chatSavePath) {
  return path.join(chatSavePath, 'run-journals');
}

async function readOptionalJson(filePath) {
  let serialized;
  try {
    serialized = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(serialized);
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(
        'run_journal_invalid',
        'Run journal is invalid.',
      );
    }
    throw error;
  }
}

async function replaceJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function assertJournalIdentity(journal, { chatId, runId }) {
  if (
    journal?.schema !== 'mnemosyne.run-journal.v1'
    || journal.chat_id !== chatId
    || journal.run_id !== runId
  ) {
    fail(
      'run_journal_identity_mismatch',
      'Run journal identity does not match the requested run.',
    );
  }
}

export function createRunJournal({
  store,
  now = () => new Date(),
} = {}) {
  if (!store?.openChatForAdmin) {
    throw new Error('Run Journal requires a trusted chat-save store.');
  }

  return Object.freeze({
    async begin({
      chatId,
      runId,
      requestHash,
      promptSpineHash,
      retrievalContractVersion,
      runScope,
      runEvidence = null,
    }) {
      assertOpaqueHostId(chatId, 'chatId');
      assertId(runId, 'runId');
      if (
        typeof retrievalContractVersion !== 'string'
        || !retrievalContractVersion
      ) {
        fail(
          'run_journal_retrieval_contract_invalid',
          'A retrieval contract version is required.',
        );
      }
      const opened = await store.openChatForAdmin({ chatId });
      const journalPath = path.join(
        opened.chat_save_path,
        journalRelativePath(runId),
      );
      const existing = await readOptionalJson(journalPath);
      if (existing) {
        assertJournalIdentity(existing, { chatId, runId });
        if (existing.request_hash !== requestHash) {
          fail(
            'run_id_reused',
            'The run id is already bound to a different request.',
          );
        }
        if (
          canonicalJson(existing.run_evidence ?? null)
          !== canonicalJson(runEvidence)
        ) {
          fail(
            'run_id_reused',
            'The run id is already bound to different host evidence.',
          );
        }
        return {
          status: 'existing',
          journal: structuredClone(existing),
        };
      }

      const timestamp = now().toISOString();
      const journal = {
        schema: 'mnemosyne.run-journal.v1',
        chat_id: chatId,
        run_id: runId,
        request_hash: requestHash,
        prompt_spine_hash: promptSpineHash,
        retrieval_contract_version: retrievalContractVersion,
        run_scope: structuredClone(runScope),
        run_evidence: structuredClone(runEvidence),
        state: 'running',
        committed: null,
        pending_writeback: null,
        model: null,
        aggregate_usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
        },
        transcript: [],
        result: null,
        events: [],
        created_at: timestamp,
        updated_at: timestamp,
      };
      await mkdir(path.dirname(journalPath), { recursive: true });
      try {
        await writeFile(
          journalPath,
          `${JSON.stringify(journal, null, 2)}\n`,
          { encoding: 'utf8', flag: 'wx' },
        );
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const raced = await readOptionalJson(journalPath);
        assertJournalIdentity(raced, { chatId, runId });
        if (raced.request_hash !== requestHash) {
          fail(
            'run_id_reused',
            'The run id is already bound to a different request.',
          );
        }
        if (
          canonicalJson(raced.run_evidence ?? null)
          !== canonicalJson(runEvidence)
        ) {
          fail(
            'run_id_reused',
            'The run id is already bound to different host evidence.',
          );
        }
        return {
          status: 'existing',
          journal: structuredClone(raced),
        };
      }
      return {
        status: 'created',
        journal: structuredClone(journal),
      };
    },

    async checkpoint({
      chatId,
      runId,
      requestHash,
      patch,
      event = null,
    }) {
      assertOpaqueHostId(chatId, 'chatId');
      assertId(runId, 'runId');
      const opened = await store.openChatForAdmin({ chatId });
      const journalPath = path.join(
        opened.chat_save_path,
        journalRelativePath(runId),
      );
      const current = await readOptionalJson(journalPath);
      if (!current) {
        fail('run_journal_not_found', 'Run journal does not exist.');
      }
      assertJournalIdentity(current, { chatId, runId });
      if (current.request_hash !== requestHash) {
        fail(
          'run_id_reused',
          'The run id is already bound to a different request.',
        );
      }
      const next = {
        ...current,
        ...structuredClone(patch),
        schema: current.schema,
        chat_id: current.chat_id,
        run_id: current.run_id,
        request_hash: current.request_hash,
        events: event === null
          ? current.events
          : [...current.events, structuredClone(event)],
        updated_at: now().toISOString(),
      };
      await replaceJsonAtomic(journalPath, next);
      return structuredClone(next);
    },

    async read({ chatId, runId }) {
      assertOpaqueHostId(chatId, 'chatId');
      assertId(runId, 'runId');
      const opened = await store.openChatForAdmin({ chatId });
      const journal = await readOptionalJson(path.join(
        opened.chat_save_path,
        journalRelativePath(runId),
      ));
      if (!journal) {
        fail('run_journal_not_found', 'Run journal does not exist.');
      }
      assertJournalIdentity(journal, { chatId, runId });
      return structuredClone(journal);
    },

    async list({ chatId, limit = 20 } = {}) {
      assertOpaqueHostId(chatId, 'chatId');
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > 50
      ) {
        fail(
          'run_journal_list_limit_invalid',
          'Run Journal list limit must be between 1 and 50.',
        );
      }
      const opened = await store.openChatForAdmin({ chatId });
      const directoryPath = journalDirectoryPath(
        opened.chat_save_path,
      );
      let entries;
      try {
        entries = await readdir(directoryPath, {
          withFileTypes: true,
        });
      } catch (error) {
        if (error.code === 'ENOENT') {
          return {
            schema: 'mnemosyne.run-journal-list.v1',
            chat_id: chatId,
            journals: [],
          };
        }
        throw error;
      }
      const candidates = [];
      for (const entry of entries) {
        if (
          !entry.isFile()
          || !entry.name.endsWith('.json')
        ) {
          continue;
        }
        const runId = entry.name.slice(0, -'.json'.length);
        if (!SAFE_ID_PATTERN.test(runId)) continue;
        const filePath = path.join(directoryPath, entry.name);
        const fileStat = await stat(filePath, { bigint: true });
        if (!fileStat.isFile()) continue;
        candidates.push({
          runId,
          filePath,
          modifiedAt: fileStat.mtimeNs,
        });
      }
      candidates.sort((left, right) => {
        if (left.modifiedAt !== right.modifiedAt) {
          return left.modifiedAt > right.modifiedAt ? -1 : 1;
        }
        return right.runId.localeCompare(left.runId);
      });
      const journals = [];
      for (const candidate of candidates.slice(0, limit)) {
        const journal = await readOptionalJson(
          candidate.filePath,
        );
        if (!journal) continue;
        assertJournalIdentity(journal, {
          chatId,
          runId: candidate.runId,
        });
        journals.push(journal);
      }
      journals.sort((left, right) => {
        const byUpdated = String(right.updated_at ?? '')
          .localeCompare(String(left.updated_at ?? ''));
        if (byUpdated !== 0) return byUpdated;
        return right.run_id.localeCompare(left.run_id);
      });
      return {
        schema: 'mnemosyne.run-journal-list.v1',
        chat_id: chatId,
        journals: structuredClone(journals.slice(0, limit)),
      };
    },
  });
}
