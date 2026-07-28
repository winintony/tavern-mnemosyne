import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { sha256 } from '../contracts/hash.js';

const JOURNAL_SCHEMA =
  'mnemosyne.dynamic-projection-transaction.v1';
const JOURNAL_RELATIVE_PATH = path.join(
  'derived',
  'dynamic-projection-transaction.json',
);
const LOCK_RELATIVE_PATH = path.join(
  'derived',
  'dynamic-projection-writer.lock',
);
const STAGE_ROOT_RELATIVE_PATH = path.join(
  'derived',
  'dynamic-projection-transactions',
);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function assertRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string'
    || !relativePath
    || path.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).includes('..')
  ) {
    fail(
      'dynamic_projection_transaction_invalid',
      'The Dynamic Story transaction contains an unsafe path.',
      { path: relativePath ?? null },
    );
  }
}

function portableRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

async function readOptional(filePath, encoding = null) {
  try {
    return await readFile(filePath, encoding ?? undefined);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, 'r');
    await handle.sync();
  } catch (error) {
    if (![
      'EACCES',
      'EINVAL',
      'EISDIR',
      'ENOTSUP',
      'EPERM',
    ].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function writeDurable(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeDurable(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
    );
    await rename(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function replaceFromFile(sourcePath, targetPath) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.replace-${randomUUID()}`;
  try {
    await copyFile(sourcePath, temporaryPath);
    const handle = await open(temporaryPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, targetPath);
    await syncDirectory(path.dirname(targetPath));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function removeDurable(filePath) {
  await rm(filePath, { force: true });
  await syncDirectory(path.dirname(filePath));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function acquireWriterLock(chatSavePath) {
  const lockPath = path.join(chatSavePath, LOCK_RELATIVE_PATH);
  const ownerId = randomUUID();
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidatePath = `${lockPath}.candidate-${ownerId}`;
    await rm(candidatePath, { recursive: true, force: true });
    await mkdir(candidatePath, { recursive: true });
    await writeDurable(
      path.join(candidatePath, 'owner.json'),
      `${JSON.stringify({
        schema: 'mnemosyne.dynamic-projection-writer-lock.v1',
        owner_id: ownerId,
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    try {
      await rename(candidatePath, lockPath);
      await syncDirectory(path.dirname(lockPath));
      return async () => {
        let owner = null;
        try {
          owner = JSON.parse(await readFile(
            path.join(lockPath, 'owner.json'),
            'utf8',
          ));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (owner?.owner_id === ownerId) {
          await rm(lockPath, { recursive: true, force: true });
          await syncDirectory(path.dirname(lockPath));
        }
      };
    } catch (error) {
      await rm(candidatePath, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
      let owner = null;
      try {
        owner = JSON.parse(await readFile(
          path.join(lockPath, 'owner.json'),
          'utf8',
        ));
      } catch {
        // A dead process may have stopped before owner metadata was durable.
      }
      if (processIsAlive(owner?.pid)) {
        const locked = new MnemosyneRequestError(
          'dynamic_projection_write_in_progress',
          'Dynamic Story projection already has an active writer.',
        );
        locked.statusCode = 409;
        throw locked;
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, stalePath);
      } catch (renameError) {
        if (renameError?.code === 'ENOENT') continue;
        throw renameError;
      }
      await rm(stalePath, { recursive: true, force: true });
      await syncDirectory(path.dirname(lockPath));
    }
  }
  fail(
    'dynamic_projection_write_lock_unavailable',
    'The Dynamic Story writer lock could not be acquired.',
  );
}

function validateJournal(journal) {
  if (
    journal?.schema !== JOURNAL_SCHEMA
    || typeof journal.transaction_id !== 'string'
    || !SAFE_ID_PATTERN.test(journal.transaction_id)
    || !['planning', 'staged'].includes(journal.state)
    || !HASH_PATTERN.test(journal.authority_hash ?? '')
    || typeof journal.stage_path !== 'string'
    || !Array.isArray(journal.files)
  ) {
    fail(
      'dynamic_projection_transaction_invalid',
      'The pending Dynamic Story transaction journal is invalid.',
    );
  }
  assertRelativePath(journal.stage_path);
  const portableStagePath = portableRelativePath(journal.stage_path);
  const portableStageRoot = `${portableRelativePath(
    STAGE_ROOT_RELATIVE_PATH,
  )}/`;
  if (!portableStagePath.startsWith(portableStageRoot)) {
    fail(
      'dynamic_projection_transaction_invalid',
      'The pending Dynamic Story transaction stage is outside its root.',
    );
  }
  if (
    journal.state === 'staged'
    && (
      journal.result === null
      || typeof journal.result !== 'object'
      || Array.isArray(journal.result)
    )
  ) {
    fail(
      'dynamic_projection_transaction_invalid',
      'The staged Dynamic Story transaction has no result manifest.',
    );
  }
  const relativePaths = new Set();
  for (const entry of journal.files) {
    assertRelativePath(entry?.relative_path);
    if (relativePaths.has(entry.relative_path)) {
      fail(
        'dynamic_projection_transaction_invalid',
        'The Dynamic Story transaction repeats a target path.',
        { path: entry.relative_path },
      );
    }
    relativePaths.add(entry.relative_path);
    if (!['write', 'remove'].includes(entry.operation)) {
      fail(
        'dynamic_projection_transaction_invalid',
        'The Dynamic Story transaction operation is invalid.',
      );
    }
    if (entry.operation === 'write') {
      assertRelativePath(entry.staged_path);
      if (!HASH_PATTERN.test(entry.after_hash ?? '')) {
        fail(
          'dynamic_projection_transaction_invalid',
          'The Dynamic Story staged file hash is invalid.',
        );
      }
    } else if (
      entry.staged_path !== null
      || entry.after_hash !== null
    ) {
      fail(
        'dynamic_projection_transaction_invalid',
        'The Dynamic Story removal entry is invalid.',
      );
    }
  }
  return journal;
}

async function readJournal(chatSavePath) {
  const serialized = await readOptional(
    path.join(chatSavePath, JOURNAL_RELATIVE_PATH),
    'utf8',
  );
  if (serialized === null) return null;
  let journal;
  try {
    journal = JSON.parse(serialized);
  } catch {
    fail(
      'dynamic_projection_transaction_invalid',
      'The pending Dynamic Story transaction journal is not valid JSON.',
    );
  }
  return validateJournal(journal);
}

async function verifyStaging({ chatSavePath, journal }) {
  if (journal.state !== 'staged') {
    fail(
      'dynamic_projection_transaction_incomplete',
      'The Dynamic Story transaction has not finished staging.',
    );
  }
  for (const entry of journal.files) {
    if (entry.operation !== 'write') continue;
    const content = await readOptional(path.join(
      chatSavePath,
      journal.stage_path,
      entry.staged_path,
    ), 'utf8');
    if (content === null || sha256(content) !== entry.after_hash) {
      fail(
        'dynamic_projection_stage_hash_mismatch',
        'A staged Dynamic Story projection file failed verification.',
        { path: entry.relative_path },
      );
    }
  }
}

async function applyProjection({
  chatSavePath,
  journal,
  faultInjector,
}) {
  for (let entryIndex = 0; entryIndex < journal.files.length; entryIndex += 1) {
    const entry = journal.files[entryIndex];
    await faultInjector?.({
      point: 'before_apply_entry',
      entry_index: entryIndex,
      relative_path: entry.relative_path,
      transaction_id: journal.transaction_id,
    });
    const targetPath = path.join(chatSavePath, entry.relative_path);
    if (entry.operation === 'remove') {
      await removeDurable(targetPath);
    } else {
      await replaceFromFile(
        path.join(
          chatSavePath,
          journal.stage_path,
          entry.staged_path,
        ),
        targetPath,
      );
    }
    await faultInjector?.({
      point: 'after_apply_entry',
      entry_index: entryIndex,
      relative_path: entry.relative_path,
      transaction_id: journal.transaction_id,
    });
  }
}

async function verifyProjection({ chatSavePath, journal }) {
  for (const entry of journal.files) {
    const content = await readOptional(
      path.join(chatSavePath, entry.relative_path),
      'utf8',
    );
    if (
      entry.operation === 'remove'
        ? content !== null
        : content === null || sha256(content) !== entry.after_hash
    ) {
      fail(
        'dynamic_projection_publish_hash_mismatch',
        'A published Dynamic Story projection file failed verification.',
        { path: entry.relative_path },
      );
    }
  }
}

async function cleanupJournal({ chatSavePath, journal }) {
  await rm(
    path.join(chatSavePath, journal.stage_path),
    { recursive: true, force: true },
  );
  await syncDirectory(path.join(
    chatSavePath,
    STAGE_ROOT_RELATIVE_PATH,
  ));
  await removeDurable(path.join(
    chatSavePath,
    JOURNAL_RELATIVE_PATH,
  ));
}

async function stagePlan({
  chatSavePath,
  journal,
  writes,
  removals,
  result,
  now,
}) {
  if (!(writes instanceof Map) || !(removals instanceof Set)) {
    fail(
      'dynamic_projection_plan_invalid',
      'Dynamic Story writes and removals must be a Map and Set.',
    );
  }
  for (const relativePath of writes.keys()) {
    if (removals.has(relativePath)) {
      fail(
        'dynamic_projection_plan_invalid',
        'A Dynamic Story path cannot be written and removed together.',
        { path: relativePath },
      );
    }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail(
      'dynamic_projection_plan_invalid',
      'The Dynamic Story projection result manifest is invalid.',
    );
  }

  const dynamicWorldPath = portableRelativePath(path.join(
    'derived',
    'dynamic-world.json',
  ));
  const writeEntries = [...writes.entries()];
  const orderedOperations = [
    ...writeEntries.filter(([relativePath]) => (
      portableRelativePath(relativePath) !== dynamicWorldPath
    )).map(([relativePath, content]) => ({
      relativePath,
      content,
      operation: 'write',
    })),
    ...[...removals].map(relativePath => ({
      relativePath,
      content: null,
      operation: 'remove',
    })),
    ...writeEntries.filter(([relativePath]) => (
      portableRelativePath(relativePath) === dynamicWorldPath
    )).map(([relativePath, content]) => ({
      relativePath,
      content,
      operation: 'write',
    })),
  ];

  const stagePath = path.join(chatSavePath, journal.stage_path);
  await rm(stagePath, { recursive: true, force: true });
  await mkdir(stagePath, { recursive: true });
  const files = [];
  for (let index = 0; index < orderedOperations.length; index += 1) {
    const operation = orderedOperations[index];
    assertRelativePath(operation.relativePath);
    const relativePath = portableRelativePath(operation.relativePath);
    if (operation.operation === 'remove') {
      files.push({
        relative_path: relativePath,
        operation: 'remove',
        staged_path: null,
        after_hash: null,
      });
      continue;
    }
    if (typeof operation.content !== 'string') {
      fail(
        'dynamic_projection_plan_invalid',
        'Dynamic Story projection writes must contain UTF-8 text.',
        { path: relativePath },
      );
    }
    const stagedPath = portableRelativePath(path.join(
      'writes',
      String(index).padStart(6, '0'),
    ));
    await writeDurable(
      path.join(stagePath, stagedPath),
      operation.content,
    );
    files.push({
      relative_path: relativePath,
      operation: 'write',
      staged_path: stagedPath,
      after_hash: sha256(operation.content),
    });
  }
  await syncDirectory(stagePath);
  return {
    ...journal,
    state: 'staged',
    files,
    result: structuredClone(result),
    updated_at: now().toISOString(),
  };
}

export async function assertDynamicProjectionReadable({
  chatSavePath,
} = {}) {
  if (typeof chatSavePath !== 'string' || !chatSavePath) {
    throw new Error(
      'Dynamic Story projection readability requires a chat-save path.',
    );
  }
  const journal = await readJournal(chatSavePath);
  if (!journal) {
    return {
      schema: 'mnemosyne.dynamic-projection-readiness.v1',
      status: 'ready',
    };
  }
  fail(
    'dynamic_projection_recovery_required',
    'Dynamic Story projection recovery must finish before memory can be read.',
    {
      transaction_id: journal.transaction_id,
      transaction_state: journal.state,
      authority_hash: journal.authority_hash,
    },
  );
}

export function createDynamicProjectionTransaction({
  now = () => new Date(),
  faultInjector = null,
} = {}) {
  if (typeof now !== 'function') {
    throw new Error('Dynamic projection transaction clock is invalid.');
  }
  if (faultInjector !== null && typeof faultInjector !== 'function') {
    throw new Error(
      'Dynamic projection transaction fault injector is invalid.',
    );
  }

  return Object.freeze({
    async run({
      chatSavePath,
      transactionId,
      authorityHash,
      buildPlan,
      validateFiles,
    } = {}) {
      if (
        typeof chatSavePath !== 'string'
        || !chatSavePath
        || typeof transactionId !== 'string'
        || !SAFE_ID_PATTERN.test(transactionId)
        || !HASH_PATTERN.test(authorityHash ?? '')
        || typeof buildPlan !== 'function'
        || typeof validateFiles !== 'function'
      ) {
        fail(
          'dynamic_projection_transaction_input_invalid',
          'Dynamic Story transaction input is invalid.',
        );
      }

      const release = await acquireWriterLock(chatSavePath);
      let previousJournal = null;
      try {
        try {
          previousJournal = await readJournal(chatSavePath);
        } catch (error) {
          if (
            error?.reasonCode
              !== 'dynamic_projection_transaction_invalid'
          ) {
            throw error;
          }
          // An invalid journal is never trusted or applied. The durable
          // planning intent below atomically supersedes it.
        }

        if (
          previousJournal?.state === 'staged'
          && previousJournal.authority_hash === authorityHash
        ) {
          try {
            await verifyStaging({
              chatSavePath,
              journal: previousJournal,
            });
            await applyProjection({
              chatSavePath,
              journal: previousJournal,
              faultInjector,
            });
            await verifyProjection({
              chatSavePath,
              journal: previousJournal,
            });
            await validateFiles({
              result: structuredClone(previousJournal.result),
              authorityHash,
              transactionId: previousJournal.transaction_id,
              recovered: true,
            });
            await cleanupJournal({
              chatSavePath,
              journal: previousJournal,
            });
            return structuredClone(previousJournal.result);
          } catch (error) {
            if (error?.simulateProcessCrash === true) throw error;
            // Rebuild the complete projection from the current ledger below.
          }
        }

        const stageRelativePath = path.join(
          STAGE_ROOT_RELATIVE_PATH,
          `${transactionId}-${randomUUID()}`,
        );
        const timestamp = now().toISOString();
        let journal = {
          schema: JOURNAL_SCHEMA,
          transaction_id: transactionId,
          state: 'planning',
          authority_hash: authorityHash,
          stage_path: portableRelativePath(stageRelativePath),
          files: [],
          result: null,
          prepared_at: timestamp,
          updated_at: timestamp,
        };
        await writeJsonAtomic(
          path.join(chatSavePath, JOURNAL_RELATIVE_PATH),
          journal,
        );
        if (
          previousJournal?.stage_path
          && previousJournal.stage_path !== journal.stage_path
        ) {
          await rm(
            path.join(chatSavePath, previousJournal.stage_path),
            { recursive: true, force: true },
          );
        }
        await faultInjector?.({
          point: 'after_intent',
          transaction_id: transactionId,
        });

        const plan = await buildPlan();
        journal = await stagePlan({
          chatSavePath,
          journal,
          writes: plan?.writes,
          removals: plan?.removals,
          result: plan?.result,
          now,
        });
        await writeJsonAtomic(
          path.join(chatSavePath, JOURNAL_RELATIVE_PATH),
          journal,
        );
        await faultInjector?.({
          point: 'after_staged',
          transaction_id: transactionId,
        });
        await verifyStaging({ chatSavePath, journal });
        await applyProjection({
          chatSavePath,
          journal,
          faultInjector,
        });
        await verifyProjection({ chatSavePath, journal });
        await validateFiles({
          result: structuredClone(journal.result),
          authorityHash,
          transactionId,
          recovered: false,
        });
        await faultInjector?.({
          point: 'after_validation',
          transaction_id: transactionId,
        });
        await cleanupJournal({ chatSavePath, journal });
        return structuredClone(journal.result);
      } finally {
        await release();
      }
    },
  });
}
