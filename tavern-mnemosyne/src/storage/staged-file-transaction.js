import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { sha256 } from '../contracts/hash.js';

const JOURNAL_SCHEMA = 'mnemosyne.staged-file-transaction.v1';
const JOURNAL_RELATIVE_PATH = path.join(
  'derived',
  'static-lore-transaction.json',
);
const LOCK_RELATIVE_PATH = path.join(
  'derived',
  'static-lore-writer.lock',
);

function assertRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string'
    || !relativePath
    || path.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`Unsafe staged transaction path: ${relativePath}`);
  }
}

async function readOptional(filePath, encoding = null) {
  try {
    return await readFile(filePath, encoding ?? undefined);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  await rename(temporaryPath, filePath);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function acquireWriterLock(chatSavePath) {
  const lockPath = path.join(chatSavePath, LOCK_RELATIVE_PATH);
  const ownerId = randomUUID();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidatePath = `${lockPath}.candidate-${ownerId}`;
    await rm(candidatePath, { recursive: true, force: true });
    await mkdir(candidatePath, { recursive: true });
    await writeFile(
      path.join(candidatePath, 'owner.json'),
      `${JSON.stringify({
        schema: 'mnemosyne.chat-writer-lock.v1',
        owner_id: ownerId,
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    try {
      await rename(candidatePath, lockPath);
      return async () => {
        let owner = null;
        try {
          owner = JSON.parse(await readFile(
            path.join(lockPath, 'owner.json'),
            'utf8',
          ));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (owner?.owner_id === ownerId) {
          await rm(lockPath, { recursive: true, force: true });
        }
      };
    } catch (error) {
      await rm(candidatePath, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      let owner = null;
      try {
        owner = JSON.parse(await readFile(
          path.join(lockPath, 'owner.json'),
          'utf8',
        ));
      } catch {
        // A writer may have stopped before owner metadata was durable.
      }
      if (processIsAlive(owner?.pid)) {
        const locked = new Error(
          'Static Lore projection already has an active writer.',
        );
        locked.reasonCode = 'static_lore_write_in_progress';
        locked.statusCode = 409;
        throw locked;
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, stalePath);
      } catch (renameError) {
        if (renameError.code === 'ENOENT') continue;
        throw renameError;
      }
      await rm(stalePath, { recursive: true, force: true });
    }
  }
  throw new Error('Static Lore writer lock could not be acquired.');
}

async function replaceFromFile(sourcePath, targetPath) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.replace-${randomUUID()}`;
  await copyFile(sourcePath, temporaryPath);
  await rename(temporaryPath, targetPath);
}

async function applyJournalProjection({
  chatSavePath,
  journal,
}) {
  for (const entry of journal.files) {
    const targetPath = path.join(chatSavePath, entry.relative_path);
    if (entry.operation === 'remove') {
      await rm(targetPath, { force: true });
      continue;
    }
    await replaceFromFile(
      path.join(chatSavePath, journal.stage_path, entry.staged_path),
      targetPath,
    );
  }
}

async function restoreJournalProjection({
  chatSavePath,
  journal,
}) {
  for (const entry of journal.files) {
    const targetPath = path.join(chatSavePath, entry.relative_path);
    if (!entry.existed_before) {
      await rm(targetPath, { force: true });
      continue;
    }
    await replaceFromFile(
      path.join(chatSavePath, journal.stage_path, entry.backup_path),
      targetPath,
    );
  }
}

async function verifyJournalStaging({
  chatSavePath,
  journal,
}) {
  for (const entry of journal.files) {
    if (entry.existed_before) {
      const backup = await readOptional(path.join(
        chatSavePath,
        journal.stage_path,
        entry.backup_path,
      ));
      if (backup === null || sha256(backup) !== entry.before_hash) {
        throw new Error(
          `Static Lore transaction backup hash mismatch: ${entry.relative_path}`,
        );
      }
    }
    if (entry.operation === 'write') {
      const staged = await readOptional(path.join(
        chatSavePath,
        journal.stage_path,
        entry.staged_path,
      ));
      if (staged === null || sha256(staged) !== entry.after_hash) {
        throw new Error(
          `Static Lore transaction staged hash mismatch: ${entry.relative_path}`,
        );
      }
    }
  }
}

async function verifyJournalProjection({
  chatSavePath,
  journal,
  state,
}) {
  for (const entry of journal.files) {
    const content = await readOptional(path.join(
      chatSavePath,
      entry.relative_path,
    ));
    if (state === 'after') {
      if (
        entry.operation === 'remove'
          ? content !== null
          : content === null || sha256(content) !== entry.after_hash
      ) {
        throw new Error(
          `Static Lore transaction after-hash mismatch: ${entry.relative_path}`,
        );
      }
      continue;
    }
    if (
      entry.existed_before
        ? content === null || sha256(content) !== entry.before_hash
        : content !== null
    ) {
      throw new Error(
        `Static Lore transaction rollback hash mismatch: ${entry.relative_path}`,
      );
    }
  }
}

async function cleanupJournal({
  chatSavePath,
  journal,
}) {
  await rm(
    path.join(chatSavePath, journal.stage_path),
    { recursive: true, force: true },
  );
  await rm(
    path.join(chatSavePath, JOURNAL_RELATIVE_PATH),
    { force: true },
  );
}

async function recoverJournal({
  chatSavePath,
  getActiveSnapshotId,
  validateFiles,
}) {
  const journalPath = path.join(chatSavePath, JOURNAL_RELATIVE_PATH);
  const serialized = await readOptional(journalPath, 'utf8');
  if (serialized === null) return null;
  const journal = JSON.parse(serialized);
  if (
    journal?.schema !== JOURNAL_SCHEMA
    || !Array.isArray(journal.files)
    || typeof journal.stage_path !== 'string'
  ) {
    throw new Error('Static Lore transaction journal is invalid.');
  }
  assertRelativePath(journal.stage_path);
  for (const entry of journal.files) {
    assertRelativePath(entry?.relative_path);
    if (!['write', 'remove'].includes(entry?.operation)) {
      throw new Error('Static Lore transaction journal is invalid.');
    }
    if (entry.existed_before) {
      assertRelativePath(entry.backup_path);
      if (!/^[a-f0-9]{64}$/.test(entry.before_hash ?? '')) {
        throw new Error('Static Lore transaction journal is invalid.');
      }
    }
    if (entry.operation === 'write') {
      assertRelativePath(entry.staged_path);
      if (!/^[a-f0-9]{64}$/.test(entry.after_hash ?? '')) {
        throw new Error('Static Lore transaction journal is invalid.');
      }
    }
  }
  await verifyJournalStaging({ chatSavePath, journal });
  const activeSnapshotId = await getActiveSnapshotId();
  if (activeSnapshotId === journal.target_snapshot_id) {
    await applyJournalProjection({ chatSavePath, journal });
    await verifyJournalProjection({
      chatSavePath,
      journal,
      state: 'after',
    });
  } else if (activeSnapshotId === journal.previous_snapshot_id) {
    await restoreJournalProjection({ chatSavePath, journal });
    await verifyJournalProjection({
      chatSavePath,
      journal,
      state: 'before',
    });
  } else {
    throw new Error(
      'Static Lore transaction cannot recover against the current ledger state.',
    );
  }
  await validateFiles();
  await cleanupJournal({ chatSavePath, journal });
  return {
    transaction_id: journal.transaction_id,
    recovered_to_snapshot_id: activeSnapshotId,
  };
}

export async function recoverStagedFileTransaction({
  chatSavePath,
  getActiveSnapshotId,
  validateFiles,
}) {
  const release = await acquireWriterLock(chatSavePath);
  try {
    return await recoverJournal({
      chatSavePath,
      getActiveSnapshotId,
      validateFiles,
    });
  } finally {
    await release();
  }
}

async function stageJournal({
  chatSavePath,
  transactionId,
  targetSnapshotId,
  previousSnapshotId,
  writes,
  removals,
}) {
  const stageRelativePath = path.join(
    'derived',
    'static-lore-transactions',
    transactionId,
  );
  const stagePath = path.join(chatSavePath, stageRelativePath);
  await rm(stagePath, { recursive: true, force: true });
  const files = [];
  for (const relativePath of new Set([
    ...writes.keys(),
    ...removals,
  ])) {
    assertRelativePath(relativePath);
    const targetPath = path.join(chatSavePath, relativePath);
    const before = await readOptional(targetPath);
    const backupPath = path.join('backups', relativePath);
    if (before !== null) {
      const absoluteBackupPath = path.join(stagePath, backupPath);
      await mkdir(path.dirname(absoluteBackupPath), { recursive: true });
      await writeFile(absoluteBackupPath, before, { flag: 'wx' });
    }
    if (writes.has(relativePath)) {
      const content = writes.get(relativePath);
      const stagedPath = path.join('writes', relativePath);
      const absoluteStagedPath = path.join(stagePath, stagedPath);
      await mkdir(path.dirname(absoluteStagedPath), { recursive: true });
      await writeFile(absoluteStagedPath, content, {
        encoding: 'utf8',
        flag: 'wx',
      });
      files.push({
        relative_path: relativePath,
        operation: 'write',
        existed_before: before !== null,
        before_hash: before === null ? null : sha256(String(before)),
        after_hash: sha256(content),
        backup_path: backupPath,
        staged_path: stagedPath,
      });
    } else {
      files.push({
        relative_path: relativePath,
        operation: 'remove',
        existed_before: before !== null,
        before_hash: before === null ? null : sha256(String(before)),
        after_hash: null,
        backup_path: backupPath,
        staged_path: null,
      });
    }
  }
  const journal = {
    schema: JOURNAL_SCHEMA,
    transaction_id: transactionId,
    state: 'files_staged',
    target_snapshot_id: targetSnapshotId,
    previous_snapshot_id: previousSnapshotId,
    stage_path: stageRelativePath,
    files,
    prepared_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await writeJsonAtomic(
    path.join(chatSavePath, JOURNAL_RELATIVE_PATH),
    journal,
  );
  return journal;
}

async function updateJournalState({
  chatSavePath,
  journal,
  state,
}) {
  journal.state = state;
  journal.updated_at = new Date().toISOString();
  await writeJsonAtomic(
    path.join(chatSavePath, JOURNAL_RELATIVE_PATH),
    journal,
  );
}

export async function runStagedFileTransaction({
  chatSavePath,
  transactionId,
  targetSnapshotId,
  previousSnapshotId,
  writes,
  removals,
  getActiveSnapshotId,
  validateFiles,
  prepareLedger,
  commitLedger,
}) {
  if (!(writes instanceof Map) || !(removals instanceof Set)) {
    throw new Error('Staged transaction writes and removals must be Map/Set.');
  }
  if (
    typeof transactionId !== 'string'
    || !/^[A-Za-z0-9_.-]+$/.test(transactionId)
  ) {
    throw new Error('Staged transaction ID is invalid.');
  }
  const release = await acquireWriterLock(chatSavePath);
  let journal = null;
  let ledgerResult;
  try {
    await recoverJournal({
      chatSavePath,
      getActiveSnapshotId,
      validateFiles,
    });
    const activeBefore = await getActiveSnapshotId();
    if (activeBefore !== previousSnapshotId) {
      throw new Error(
        'Static Lore active snapshot changed before file staging.',
      );
    }
    if (prepareLedger) {
      await prepareLedger();
    }
    journal = await stageJournal({
      chatSavePath,
      transactionId,
      targetSnapshotId,
      previousSnapshotId,
      writes,
      removals,
    });
    await verifyJournalStaging({ chatSavePath, journal });
    await applyJournalProjection({ chatSavePath, journal });
    await verifyJournalProjection({
      chatSavePath,
      journal,
      state: 'after',
    });
    await updateJournalState({
      chatSavePath,
      journal,
      state: 'files_written',
    });
    await validateFiles();
    ledgerResult = await commitLedger();
    await updateJournalState({
      chatSavePath,
      journal,
      state: 'ledger_committed',
    });
    await cleanupJournal({ chatSavePath, journal });
    journal = null;
    return ledgerResult;
  } catch (error) {
    if (journal) {
      const activeSnapshotId = await getActiveSnapshotId().catch(() => null);
      try {
        if (activeSnapshotId === targetSnapshotId) {
          await applyJournalProjection({ chatSavePath, journal });
          await verifyJournalProjection({
            chatSavePath,
            journal,
            state: 'after',
          });
          await validateFiles();
          await cleanupJournal({ chatSavePath, journal });
          journal = null;
          return ledgerResult;
        }
        if (activeSnapshotId === previousSnapshotId) {
          await restoreJournalProjection({ chatSavePath, journal });
          await verifyJournalProjection({
            chatSavePath,
            journal,
            state: 'before',
          });
          await validateFiles();
          await cleanupJournal({ chatSavePath, journal });
          journal = null;
        } else {
          throw new Error(
            'Static Lore transaction failed against an unexpected ledger state.',
          );
        }
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          'Static Lore transaction failed and recovery did not complete.',
        );
      }
    }
    throw error;
  } finally {
    await release();
  }
}
