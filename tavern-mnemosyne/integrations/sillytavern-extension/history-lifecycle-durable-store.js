import {
  assertHistoryInvalidationGuard,
} from './history-invalidation-guard.js';

const STORE_SCHEMA =
  'mnemosyne.history-lifecycle-durable-state.v1';
const DEFAULT_KEY_PREFIX =
  'tavern-mnemosyne.history-lifecycle.v1:';

function durableError(reasonCode, message) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  return error;
}

function cloneRecord(record) {
  return structuredClone(record);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertRecord(record) {
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || record.schema !== STORE_SCHEMA
    || !Object.hasOwn(record, 'guard')
    || !Object.hasOwn(record, 'checkpoint')
    || !(
      record.guard === null
      || (
        typeof record.guard === 'object'
        && !Array.isArray(record.guard)
      )
    )
    || !(
      record.checkpoint === null
      || (
        typeof record.checkpoint === 'object'
        && !Array.isArray(record.checkpoint)
      )
    )
  ) {
    throw durableError(
      'history_durable_state_invalid',
      'The durable history lifecycle state is invalid.',
    );
  }
  if (record.guard !== null) {
    assertHistoryInvalidationGuard(record.guard);
  }
  if (
    record.checkpoint !== null
    && (
      record.checkpoint.schema
        !== 'mnemosyne.governed-history-checkpoint.v1'
      || !/^[a-f0-9]{64}$/.test(
        record.checkpoint.chat_id_hash ?? '',
      )
      || !Number.isInteger(
        record.checkpoint.branch_epoch,
      )
      || record.checkpoint.branch_epoch < 0
      || !Number.isInteger(
        record.checkpoint.message_count,
      )
      || record.checkpoint.message_count < 0
      || !Array.isArray(
        record.checkpoint.message_hashes,
      )
      || record.checkpoint.message_hashes.length
        !== record.checkpoint.message_count
      || record.checkpoint.message_hashes.some(
        hash => !/^[a-f0-9]{64}$/.test(hash),
      )
      || !/^[a-f0-9]{64}$/.test(
        record.checkpoint.checkpoint_hash ?? '',
      )
    )
  ) {
    throw durableError(
      'history_durable_state_invalid',
      'The durable history checkpoint is invalid.',
    );
  }
  return cloneRecord(record);
}

function assertChatId(chatId) {
  if (typeof chatId !== 'string' || !chatId) {
    throw durableError(
      'history_durable_chat_invalid',
      'Durable history lifecycle state requires a chat identity.',
    );
  }
  return chatId;
}

export function createHistoryLifecycleDurableStore({
  storage = null,
  keyPrefix = DEFAULT_KEY_PREFIX,
} = {}) {
  if (typeof keyPrefix !== 'string' || !keyPrefix) {
    throw new TypeError(
      'Durable history lifecycle storage requires a key prefix.',
    );
  }

  function currentStorage() {
    const target = storage ?? globalThis.localStorage;
    if (
      !target
      || typeof target.getItem !== 'function'
      || typeof target.setItem !== 'function'
    ) {
      throw durableError(
        'history_durable_store_unavailable',
        'Browser durable storage is unavailable.',
      );
    }
    return target;
  }

  function key(chatId) {
    return `${keyPrefix}${encodeURIComponent(assertChatId(chatId))}`;
  }

  function read(chatId) {
    let serialized;
    try {
      serialized = currentStorage().getItem(key(chatId));
    } catch {
      throw durableError(
        'history_durable_read_failed',
        'Durable history lifecycle state could not be read.',
      );
    }
    if (serialized === null) return null;
    try {
      return assertRecord(JSON.parse(serialized));
    } catch (error) {
      if (error?.reasonCode) throw error;
      throw durableError(
        'history_durable_state_invalid',
        'Durable history lifecycle state is not valid JSON.',
      );
    }
  }

  function write(chatId, {
    guard = null,
    checkpoint = null,
  } = {}) {
    const record = assertRecord({
      schema: STORE_SCHEMA,
      guard,
      checkpoint,
    });
    const serialized = JSON.stringify(record);
    const recordKey = key(chatId);
    try {
      const target = currentStorage();
      target.setItem(recordKey, serialized);
      if (target.getItem(recordKey) !== serialized) {
        throw new Error('readback mismatch');
      }
    } catch {
      throw durableError(
        'history_durable_write_unverified',
        'Durable history lifecycle state could not be verified after writing.',
      );
    }
    return cloneRecord(record);
  }

  function reconcile(chatId, {
    guard = null,
    checkpoint = null,
  } = {}) {
    const metadataRecord = assertRecord({
      schema: STORE_SCHEMA,
      guard,
      checkpoint,
    });
    const persisted = read(chatId);
    if (persisted === null) {
      return write(chatId, metadataRecord);
    }
    for (const field of ['guard', 'checkpoint']) {
      if (
        persisted[field] !== null
        && metadataRecord[field] !== null
        && !sameValue(
          persisted[field],
          metadataRecord[field],
        )
      ) {
        throw durableError(
          'history_durable_state_conflict',
          `Durable and chat-metadata history ${field} values conflict.`,
        );
      }
    }
    const merged = {
      guard:
        persisted.guard
        ?? metadataRecord.guard,
      checkpoint:
        persisted.checkpoint
        ?? metadataRecord.checkpoint,
    };
    if (
      sameValue(persisted.guard, merged.guard)
      && sameValue(
        persisted.checkpoint,
        merged.checkpoint,
      )
    ) {
      return cloneRecord(persisted);
    }
    return write(chatId, merged);
  }

  return Object.freeze({
    read,
    reconcile,
    write,
  });
}
