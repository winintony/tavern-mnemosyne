import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, sha256 } from '../contracts/hash.js';
import { MnemosyneRequestError } from '../contracts/errors.js';

export const FRESH_CHAT_ACCEPTANCE_WITNESS_SCHEMA =
  'mnemosyne.fresh-chat-acceptance-witness.v3';
export const FRESH_INTAKE_AUTHORITY_SCHEMA =
  'mnemosyne.fresh-intake-authority.v2';
export const FRESH_INTAKE_AUTHORITY_STATE_SCHEMA =
  'mnemosyne.fresh-intake-authority-state.v2';
export const FRESH_INTAKE_STORE_MARKER_SCHEMA =
  'mnemosyne.fresh-intake-store-initialization.v2';

const BASELINE_WITNESS_SCHEMA =
  'mnemosyne.fresh-chat-baseline-witness.v1';

function isRecord(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return isRecord(value)
    && canonicalJson(Object.keys(value).sort())
      === canonicalJson([...expected].sort());
}

function isHash(value) {
  return /^[a-f0-9]{64}$/.test(value ?? '');
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(reasonCode, message) {
  throw new MnemosyneRequestError(reasonCode, message);
}

function hasSelfHash(value, field) {
  if (!isRecord(value) || !isHash(value[field])) return false;
  const {
    [field]: claimedHash,
    ...payload
  } = value;
  return claimedHash === sha256(canonicalJson(payload));
}

function isSortedUniqueStrings(values) {
  return Array.isArray(values)
    && values.every(value => typeof value === 'string' && value.length > 0)
    && new Set(values).size === values.length
    && values.every((value, index) => (
      index === 0 || values[index - 1] < value
    ));
}

function verifyBaselineWitness(witness) {
  return (
    isRecord(witness)
    && witness.schema === BASELINE_WITNESS_SCHEMA
    && witness.status === 'accepted'
    && witness.fresh_baseline === true
    && witness.formal_mode === true
    && Array.isArray(witness.reason_codes)
    && witness.reason_codes.length === 0
    && witness.observed?.user_message_count === 0
    && witness.observed?.assistant_message_count === 1
    && witness.observed?.active_static_lore_snapshot_count === 0
    && witness.observed?.dynamic_history_row_count === 0
    && witness.observed?.input_files_stable === true
    && isHash(witness.subject?.chat_id_hash)
    && isHash(witness.subject?.character_id_hash)
    && isHash(witness.subject?.character_card_hash)
    && isHash(witness.files?.chat_jsonl?.content_hash)
    && witness.files?.character_card?.content_hash
      === witness.subject.character_card_hash
    && hasSelfHash(witness, 'witness_hash')
  );
}

export function verifyFreshChatAcceptanceWitness(witness) {
  if (
    !hasExactKeys(witness, [
      'schema',
      'status',
      'formal_mode',
      'reason_codes',
      'inventory',
      'subject',
      'authority_context',
      'files',
      'baseline_witness',
      'baseline_witness_hash',
      'self_hash',
    ])
    || witness.schema !== FRESH_CHAT_ACCEPTANCE_WITNESS_SCHEMA
    || witness.status !== 'accepted'
    || witness.formal_mode !== true
    || !Array.isArray(witness.reason_codes)
    || witness.reason_codes.length !== 0
    || !hasSelfHash(witness, 'self_hash')
  ) {
    return false;
  }

  const { inventory, subject, authority_context: authority, files } =
    witness;
  if (
    !hasExactKeys(inventory, [
      'inventory_hash',
      'old_chat_ids',
      'old_chat_ids_hash',
      'before_jsonl_inventory_hash',
      'after_jsonl_inventory_hash',
    ])
    || ![
      inventory.inventory_hash,
      inventory.old_chat_ids_hash,
      inventory.before_jsonl_inventory_hash,
      inventory.after_jsonl_inventory_hash,
    ].every(isHash)
    || !isSortedUniqueStrings(inventory.old_chat_ids)
    || inventory.old_chat_ids_hash
      !== sha256(canonicalJson(inventory.old_chat_ids))
  ) {
    return false;
  }

  if (
    !hasExactKeys(subject, [
      'chat_id',
      'chat_id_hash',
      'character_id',
      'character_id_hash',
      'character_name_hash',
      'character_card_hash',
    ])
    || typeof subject.chat_id !== 'string'
    || subject.chat_id.length === 0
    || typeof subject.character_id !== 'string'
    || subject.character_id.length === 0
    || subject.chat_id_hash !== sha256(subject.chat_id)
    || subject.character_id_hash !== sha256(subject.character_id)
    || !isHash(subject.character_name_hash)
    || !isHash(subject.character_card_hash)
  ) {
    return false;
  }

  if (
    !hasExactKeys(authority, [
      'host_chat_path',
      'host_chat_path_hash',
      'host_chat_identity_hash',
      'chat_save_root',
      'chat_save_root_hash',
      'chat_save_root_identity_hash',
      'character_card_path',
      'character_card_path_hash',
      'character_card_identity_hash',
    ])
    || ![
      authority.host_chat_path,
      authority.chat_save_root,
      authority.character_card_path,
    ].every(value => typeof value === 'string' && value.length > 0)
    || ![
      authority.host_chat_path,
      authority.chat_save_root,
      authority.character_card_path,
    ].every(value => (
      path.isAbsolute(value) && path.normalize(value) === value
    ))
    || authority.host_chat_path_hash !== sha256(authority.host_chat_path)
    || authority.chat_save_root_hash !== sha256(authority.chat_save_root)
    || authority.character_card_path_hash
      !== sha256(authority.character_card_path)
    || ![
      authority.host_chat_identity_hash,
      authority.chat_save_root_identity_hash,
      authority.character_card_identity_hash,
    ].every(isHash)
  ) {
    return false;
  }

  if (
    !hasExactKeys(files, ['chat_jsonl', 'character_card'])
    || !hasExactKeys(
      files.chat_jsonl,
      ['content_hash', 'size_bytes', 'path_hash', 'identity_hash'],
    )
    || !hasExactKeys(
      files.character_card,
      ['content_hash', 'size_bytes', 'path_hash', 'identity_hash'],
    )
    || !isHash(files.chat_jsonl.content_hash)
    || !Number.isSafeInteger(files.chat_jsonl.size_bytes)
    || files.chat_jsonl.size_bytes < 1
    || files.chat_jsonl.path_hash !== authority.host_chat_path_hash
    || files.chat_jsonl.identity_hash
      !== authority.host_chat_identity_hash
    || files.character_card.content_hash !== subject.character_card_hash
    || !Number.isSafeInteger(files.character_card.size_bytes)
    || files.character_card.size_bytes < 1
    || files.character_card.path_hash !== authority.character_card_path_hash
    || files.character_card.identity_hash
      !== authority.character_card_identity_hash
  ) {
    return false;
  }

  return verifyBaselineWitness(witness.baseline_witness)
    && witness.baseline_witness_hash
      === witness.baseline_witness.witness_hash
    && witness.baseline_witness.subject.chat_id_hash
      === subject.chat_id_hash
    && witness.baseline_witness.subject.character_id_hash
      === subject.character_id_hash
    && witness.baseline_witness.subject.character_card_hash
      === subject.character_card_hash
    && witness.baseline_witness.files.chat_jsonl.content_hash
      === files.chat_jsonl.content_hash
    && witness.baseline_witness.files.character_card.content_hash
      === files.character_card.content_hash;
}

function statIdentity(stats) {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: String(stats.mode),
    size: String(stats.size),
    mtime_ns: String(stats.mtimeNs),
    ctime_ns: String(stats.ctimeNs),
  };
}

function publishedFileIdentity(stats) {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: String(stats.mode),
    size: String(stats.size),
    mtime_ns: String(stats.mtimeNs),
  };
}

function authorityDirectoryIdentity({
  canonicalPath,
  linkStats,
  targetStats,
}) {
  return {
    canonical_path: canonicalPath,
    link_dev: String(linkStats.dev),
    link_ino: String(linkStats.ino),
    link_mode: String(linkStats.mode),
    target_dev: String(targetStats.dev),
    target_ino: String(targetStats.ino),
    target_mode: String(targetStats.mode),
  };
}

async function captureStableFile(filePath, {
  driftReasonCode,
  unreadableReasonCode,
  label,
}) {
  try {
    const linkBefore = await lstat(filePath, { bigint: true });
    if (!linkBefore.isFile() || linkBefore.isSymbolicLink()) {
      fail(
        unreadableReasonCode,
        `${label} must be a regular non-symlink file.`,
      );
    }
    const resolvedBefore = await realpath(filePath);
    const targetBefore = await stat(filePath, { bigint: true });
    const bytes = await readFile(filePath);
    const [linkAfter, resolvedAfter, targetAfter] = await Promise.all([
      lstat(filePath, { bigint: true }),
      realpath(filePath),
      stat(filePath, { bigint: true }),
    ]);
    const contentHash = hashBytes(bytes);
    const beforeIdentity = {
      link: statIdentity(linkBefore),
      canonical_path: resolvedBefore,
      target: statIdentity(targetBefore),
      content_hash: contentHash,
    };
    const afterIdentity = {
      link: statIdentity(linkAfter),
      canonical_path: resolvedAfter,
      target: statIdentity(targetAfter),
      content_hash: contentHash,
    };
    if (
      !linkAfter.isFile()
      || linkAfter.isSymbolicLink()
      || canonicalJson(beforeIdentity) !== canonicalJson(afterIdentity)
    ) {
      fail(
        driftReasonCode,
        `${label} changed during fresh-intake authorization.`,
      );
    }
    return {
      resolvedPath: resolvedAfter,
      contentHash,
      identityHash: sha256(canonicalJson(afterIdentity)),
      sizeBytes: bytes.byteLength,
    };
  } catch (error) {
    if (error instanceof MnemosyneRequestError) throw error;
    fail(
      unreadableReasonCode,
      `${label} could not be read.`,
    );
  }
}

async function captureStableDirectory(directoryPath, {
  invalidReasonCode = 'fresh_intake_chat_save_root_invalid',
  driftReasonCode = 'fresh_intake_chat_save_root_drift',
  label = 'Fresh intake chat-save root',
} = {}) {
  try {
    const linkBefore = await lstat(directoryPath, { bigint: true });
    if (!linkBefore.isDirectory() || linkBefore.isSymbolicLink()) {
      fail(
        invalidReasonCode,
        `${label} must be a non-symlink directory.`,
      );
    }
    const resolvedBefore = await realpath(directoryPath);
    const targetBefore = await stat(directoryPath, { bigint: true });
    const [linkAfter, resolvedAfter, targetAfter] = await Promise.all([
      lstat(directoryPath, { bigint: true }),
      realpath(directoryPath),
      stat(directoryPath, { bigint: true }),
    ]);
    if (
      !linkAfter.isDirectory()
      || linkAfter.isSymbolicLink()
      || resolvedBefore !== resolvedAfter
      || canonicalJson(statIdentity(linkBefore))
        !== canonicalJson(statIdentity(linkAfter))
      || canonicalJson(statIdentity(targetBefore))
        !== canonicalJson(statIdentity(targetAfter))
    ) {
      fail(
        driftReasonCode,
        `${label} changed during authorization.`,
      );
    }
    return {
      resolvedPath: resolvedAfter,
      pathHash: sha256(resolvedAfter),
      identityHash: sha256(canonicalJson(authorityDirectoryIdentity({
        canonicalPath: resolvedAfter,
        linkStats: linkAfter,
        targetStats: targetAfter,
      }))),
    };
  } catch (error) {
    if (error instanceof MnemosyneRequestError) throw error;
    fail(
      invalidReasonCode,
      `${label} could not be resolved.`,
    );
  }
}

function authorityFor({
  witness,
  chatId,
  characterId,
  snapshotHash,
  sourcePacketHash,
  sessionId,
  hostChatHash,
  hostChatIdentityHash,
  chatSaveRootIdentityHash,
  characterCardHash,
  characterCardIdentityHash,
}) {
  const payload = {
    schema: FRESH_INTAKE_AUTHORITY_SCHEMA,
    witness_hash: witness.self_hash,
    chat_id_hash: sha256(chatId),
    character_id_hash: sha256(characterId),
    chat_save_root_hash: witness.authority_context.chat_save_root_hash,
    chat_save_root_identity_hash: chatSaveRootIdentityHash,
    host_chat_hash: hostChatHash,
    host_chat_identity_hash: hostChatIdentityHash,
    character_card_hash: characterCardHash,
    character_card_identity_hash: characterCardIdentityHash,
    snapshot_hash: snapshotHash,
    source_packet_hash: sourcePacketHash,
    session_id_hash: sha256(sessionId),
  };
  return {
    ...payload,
    authority_hash: sha256(canonicalJson(payload)),
  };
}

function stateFor(authority) {
  const payload = {
    schema: FRESH_INTAKE_AUTHORITY_STATE_SCHEMA,
    authority,
  };
  return {
    ...payload,
    state_hash: sha256(canonicalJson(payload)),
  };
}

function validState(state) {
  if (
    !hasExactKeys(state, ['schema', 'authority', 'state_hash'])
    || state.schema !== FRESH_INTAKE_AUTHORITY_STATE_SCHEMA
    || !hasSelfHash(state, 'state_hash')
  ) {
    return false;
  }
  const { authority } = state;
  return hasExactKeys(authority, [
    'schema',
    'witness_hash',
    'chat_id_hash',
    'character_id_hash',
    'chat_save_root_hash',
    'chat_save_root_identity_hash',
    'host_chat_hash',
    'host_chat_identity_hash',
    'character_card_hash',
    'character_card_identity_hash',
    'snapshot_hash',
    'source_packet_hash',
    'session_id_hash',
    'authority_hash',
  ])
    && authority.schema === FRESH_INTAKE_AUTHORITY_SCHEMA
    && [
      authority.witness_hash,
      authority.chat_id_hash,
      authority.character_id_hash,
      authority.chat_save_root_hash,
      authority.chat_save_root_identity_hash,
      authority.host_chat_hash,
      authority.host_chat_identity_hash,
      authority.character_card_hash,
      authority.character_card_identity_hash,
      authority.snapshot_hash,
      authority.source_packet_hash,
      authority.session_id_hash,
      authority.authority_hash,
    ].every(isHash)
    && authority.authority_hash === sha256(canonicalJson({
      schema: authority.schema,
      witness_hash: authority.witness_hash,
      chat_id_hash: authority.chat_id_hash,
      character_id_hash: authority.character_id_hash,
      chat_save_root_hash: authority.chat_save_root_hash,
      chat_save_root_identity_hash:
        authority.chat_save_root_identity_hash,
      host_chat_hash: authority.host_chat_hash,
      host_chat_identity_hash: authority.host_chat_identity_hash,
      character_card_hash: authority.character_card_hash,
      character_card_identity_hash:
        authority.character_card_identity_hash,
      snapshot_hash: authority.snapshot_hash,
      source_packet_hash: authority.source_packet_hash,
      session_id_hash: authority.session_id_hash,
    }));
}

function storeMarkerFor(
  authority,
  chatSavePath,
  chatSaveIdentityHash,
) {
  const payload = {
    schema: FRESH_INTAKE_STORE_MARKER_SCHEMA,
    authority_hash: authority.authority_hash,
    chat_save_path_hash: sha256(chatSavePath),
    chat_save_identity_hash: chatSaveIdentityHash,
  };
  return {
    ...payload,
    marker_hash: sha256(canonicalJson(payload)),
  };
}

function validStoreMarker(marker) {
  return hasExactKeys(marker, [
    'schema',
    'authority_hash',
    'chat_save_path_hash',
    'chat_save_identity_hash',
    'marker_hash',
  ])
    && marker.schema === FRESH_INTAKE_STORE_MARKER_SCHEMA
    && [
      marker.authority_hash,
      marker.chat_save_path_hash,
      marker.chat_save_identity_hash,
      marker.marker_hash,
    ].every(isHash)
    && hasSelfHash(marker, 'marker_hash');
}

async function readState(statePath) {
  try {
    const before = await lstat(statePath, { bigint: true });
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || (before.mode & 0o077n) !== 0n
    ) {
      fail(
        'fresh_intake_authority_state_invalid',
        'Fresh intake authority state is not a private regular file.',
      );
    }
    const source = await readFile(statePath, 'utf8');
    const after = await lstat(statePath, { bigint: true });
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || canonicalJson(publishedFileIdentity(before))
        !== canonicalJson(publishedFileIdentity(after))
    ) {
      fail(
        'fresh_intake_authority_state_invalid',
        'Fresh intake authority state changed while it was read.',
      );
    }
    const parsed = JSON.parse(source);
    if (!validState(parsed)) {
      fail(
        'fresh_intake_authority_state_invalid',
        'Fresh intake authority state failed integrity validation.',
      );
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof MnemosyneRequestError) throw error;
    fail(
      'fresh_intake_authority_state_invalid',
      'Fresh intake authority state could not be read.',
    );
  }
}

async function readStoreMarker(markerPath) {
  try {
    const before = await lstat(markerPath, { bigint: true });
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || (before.mode & 0o077n) !== 0n
    ) {
      fail(
        'fresh_intake_store_marker_invalid',
        'Fresh intake store marker is not a private regular file.',
      );
    }
    const source = await readFile(markerPath, 'utf8');
    const after = await lstat(markerPath, { bigint: true });
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || (after.mode & 0o077n) !== 0n
      || canonicalJson(publishedFileIdentity(before))
        !== canonicalJson(publishedFileIdentity(after))
    ) {
      fail(
        'fresh_intake_store_marker_invalid',
        'Fresh intake store marker changed while it was read.',
      );
    }
    const marker = JSON.parse(source);
    if (!validStoreMarker(marker)) {
      fail(
        'fresh_intake_store_marker_invalid',
        'Fresh intake store marker failed integrity validation.',
      );
    }
    return marker;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof MnemosyneRequestError) throw error;
    fail(
      'fresh_intake_store_marker_invalid',
      'Fresh intake store marker could not be read.',
    );
  }
}

async function pathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function publishPrivateJsonNoReplace({
  targetPath,
  expected,
  readExisting,
  driftReasonCode,
  driftMessage,
}) {
  const existing = await readExisting(targetPath);
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(expected)) {
      fail(driftReasonCode, driftMessage);
    }
    return;
  }
  const parentPath = path.dirname(targetPath);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    parentPath,
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let published = false;
  let publishAttempted = false;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(
      `${JSON.stringify(expected, null, 2)}\n`,
      'utf8',
    );
    await handle.sync();
    await handle.close();
    handle = null;
    publishAttempted = true;
    await link(temporaryPath, targetPath);
    published = true;
  } catch (error) {
    if (error?.code !== 'EEXIST' || !publishAttempted) throw error;
    const raced = await readExisting(targetPath);
    if (canonicalJson(raced) !== canonicalJson(expected)) {
      fail(driftReasonCode, driftMessage);
    }
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
  if (published) {
    const persisted = await readExisting(targetPath);
    if (canonicalJson(persisted) !== canonicalJson(expected)) {
      fail(driftReasonCode, driftMessage);
    }
  }
}

async function persistOrVerifyState(statePath, expected) {
  await publishPrivateJsonNoReplace({
    targetPath: statePath,
    expected,
    readExisting: readState,
    driftReasonCode: 'fresh_intake_authority_drift',
    driftMessage:
      'Fresh intake authority no longer matches its persisted state.',
  });
}

export async function createFreshIntakeAdmissionGuard({
  witness,
  statePath,
  chatSaveRoot,
  allowHostChatProgression = false,
} = {}) {
  if (!verifyFreshChatAcceptanceWitness(witness)) {
    fail(
      'fresh_intake_witness_invalid',
      'Fresh intake requires a valid formal fresh-chat witness.',
    );
  }
  const acceptedWitness = structuredClone(witness);
  if (
    typeof statePath !== 'string'
    || statePath.trim().length === 0
    || typeof chatSaveRoot !== 'string'
    || chatSaveRoot.trim().length === 0
  ) {
    throw new Error(
      'Fresh Intake Admission requires statePath and chatSaveRoot.',
    );
  }
  if (typeof allowHostChatProgression !== 'boolean') {
    throw new Error(
      'Fresh Intake Admission host-chat progression flag must be boolean.',
    );
  }
  const resolvedStatePath = path.resolve(statePath);
  const storeMarkerPath = `${resolvedStatePath}.store-initialized`;
  const configuredRootPath = path.resolve(chatSaveRoot);
  const initialRoot = await captureStableDirectory(configuredRootPath);
  const canonicalRoot = initialRoot.resolvedPath;
  if (
    canonicalRoot !== acceptedWitness.authority_context.chat_save_root
    || initialRoot.pathHash
      !== acceptedWitness.authority_context.chat_save_root_hash
    || initialRoot.identityHash
      !== acceptedWitness.authority_context.chat_save_root_identity_hash
  ) {
    fail(
      'fresh_intake_chat_save_root_mismatch',
      'Fresh intake chat-save root does not match the witness.',
    );
  }

  async function currentWitnessInputs({
    allowProgression = false,
    allowCharacterCardIdentityProgression = false,
  } = {}) {
    const [root, hostChat, characterCard] = await Promise.all([
      captureStableDirectory(configuredRootPath),
      captureStableFile(
        acceptedWitness.authority_context.host_chat_path,
        {
          driftReasonCode: 'fresh_intake_host_chat_drift',
          unreadableReasonCode: 'fresh_intake_host_chat_unreadable',
          label: 'Fresh intake host-chat evidence',
        },
      ),
      captureStableFile(
        acceptedWitness.authority_context.character_card_path,
        {
          driftReasonCode: 'fresh_intake_character_card_drift',
          unreadableReasonCode: 'fresh_intake_character_card_unreadable',
          label: 'Fresh intake character-card evidence',
        },
      ),
    ]);
    if (
      root.resolvedPath !== canonicalRoot
      || root.pathHash
        !== acceptedWitness.authority_context.chat_save_root_hash
      || root.identityHash
        !== acceptedWitness.authority_context.chat_save_root_identity_hash
    ) {
      fail(
        'fresh_intake_chat_save_root_drift',
        'Fresh intake chat-save root no longer matches the witness.',
      );
    }
    if (
      hostChat.resolvedPath
        !== acceptedWitness.authority_context.host_chat_path
      || sha256(hostChat.resolvedPath)
        !== acceptedWitness.authority_context.host_chat_path_hash
      || (
        !allowProgression
        && (
          hostChat.contentHash
            !== acceptedWitness.files.chat_jsonl.content_hash
          || hostChat.identityHash
            !== acceptedWitness.authority_context.host_chat_identity_hash
          || hostChat.sizeBytes
            !== acceptedWitness.files.chat_jsonl.size_bytes
        )
      )
    ) {
      fail(
        'fresh_intake_host_chat_drift',
        'Fresh intake host-chat evidence no longer matches the witness.',
      );
    }
    if (
      characterCard.resolvedPath
        !== acceptedWitness.authority_context.character_card_path
      || sha256(characterCard.resolvedPath)
        !== acceptedWitness.authority_context.character_card_path_hash
      || characterCard.contentHash
        !== acceptedWitness.files.character_card.content_hash
      || characterCard.contentHash
        !== acceptedWitness.subject.character_card_hash
      || (
        !allowCharacterCardIdentityProgression
        && characterCard.identityHash
          !== acceptedWitness.authority_context
            .character_card_identity_hash
      )
      || characterCard.sizeBytes
        !== acceptedWitness.files.character_card.size_bytes
    ) {
      fail(
        'fresh_intake_character_card_drift',
        'Fresh intake character-card evidence no longer matches the witness.',
      );
    }
    return { root, hostChat, characterCard };
  }

  const [initialState, initialMarker] = await Promise.all([
    readState(resolvedStatePath),
    readStoreMarker(storeMarkerPath),
  ]);
  await currentWitnessInputs({
    allowProgression: allowHostChatProgression,
    allowCharacterCardIdentityProgression: Boolean(
      initialState && initialMarker,
    ),
  });

  async function assertCurrentAuthority(authority) {
    const expectedState = stateFor(authority);
    if (!validState(expectedState)) {
      fail(
        'fresh_intake_binding_invalid',
        'Fresh intake authority binding is invalid.',
      );
    }
    const [state, marker] = await Promise.all([
      readState(resolvedStatePath),
      readStoreMarker(storeMarkerPath),
    ]);
    if (
      !state
      || canonicalJson(state) !== canonicalJson(expectedState)
    ) {
      fail(
        'fresh_intake_authority_drift',
        'Fresh intake authority no longer matches its persisted state.',
      );
    }
    const allowCharacterCardIdentityProgression = Boolean(marker);
    if (marker) {
      await assertStoreMarkerCurrent(authority);
    }
    const current = await currentWitnessInputs({
      allowCharacterCardIdentityProgression,
    });
    if (
      authority.witness_hash !== acceptedWitness.self_hash
      || authority.chat_id_hash !== acceptedWitness.subject.chat_id_hash
      || authority.character_id_hash
        !== acceptedWitness.subject.character_id_hash
      || authority.chat_save_root_hash
        !== acceptedWitness.authority_context.chat_save_root_hash
      || authority.chat_save_root_identity_hash
        !== current.root.identityHash
      || authority.host_chat_hash !== current.hostChat.contentHash
      || authority.host_chat_identity_hash
        !== current.hostChat.identityHash
      || authority.character_card_hash
        !== current.characterCard.contentHash
      || authority.character_card_identity_hash
        !== (
          allowCharacterCardIdentityProgression
            ? acceptedWitness.authority_context
              .character_card_identity_hash
            : current.characterCard.identityHash
        )
    ) {
      fail(
        'fresh_intake_authority_drift',
        'Fresh intake authority no longer matches the witness.',
      );
    }
    return state;
  }

  const chatSavePath = path.join(
    canonicalRoot,
    `chat-${acceptedWitness.subject.chat_id_hash.slice(0, 24)}`,
  );

  async function assertStoreMarkerCurrent(authority) {
    const marker = await readStoreMarker(storeMarkerPath);
    if (!marker) {
      fail(
        'fresh_intake_store_not_initialized',
        'Fresh intake store has not been initialized for this authority.',
      );
    }
    const store = await captureStableDirectory(chatSavePath, {
      invalidReasonCode: 'fresh_intake_store_missing',
      driftReasonCode: 'fresh_intake_store_drift',
      label: 'Fresh intake chat-save store',
    });
    const expected = storeMarkerFor(
      authority,
      chatSavePath,
      store.identityHash,
    );
    if (canonicalJson(marker) !== canonicalJson(expected)) {
      fail(
        'fresh_intake_store_generation_drift',
        'Fresh intake chat-save store generation no longer matches.',
      );
    }
    return marker;
  }

  return Object.freeze({
    async authorize({
      chatId,
      characterId,
      snapshotHash,
      sourcePacketHash,
      sessionId,
    } = {}) {
      if (
        typeof chatId !== 'string'
        || sha256(chatId) !== acceptedWitness.subject.chat_id_hash
        || typeof characterId !== 'string'
        || sha256(characterId) !== acceptedWitness.subject.character_id_hash
      ) {
        fail(
          'fresh_intake_subject_mismatch',
          'Fresh intake subject does not match the witness.',
        );
      }
      if (
        !isHash(snapshotHash)
        || !isHash(sourcePacketHash)
        || typeof sessionId !== 'string'
        || sessionId.length === 0
      ) {
        fail(
          'fresh_intake_binding_invalid',
          'Fresh intake snapshot, packet, or session binding is invalid.',
        );
      }
      const [existingState, existingMarker] = await Promise.all([
        readState(resolvedStatePath),
        readStoreMarker(storeMarkerPath),
      ]);
      const allowCharacterCardIdentityProgression = Boolean(
        existingState && existingMarker,
      );
      const current = await currentWitnessInputs({
        allowCharacterCardIdentityProgression,
      });
      const authority = authorityFor({
        witness: acceptedWitness,
        chatId,
        characterId,
        snapshotHash,
        sourcePacketHash,
        sessionId,
        hostChatHash: current.hostChat.contentHash,
        hostChatIdentityHash: current.hostChat.identityHash,
        chatSaveRootIdentityHash: current.root.identityHash,
        characterCardHash: current.characterCard.contentHash,
        characterCardIdentityHash:
          allowCharacterCardIdentityProgression
            ? acceptedWitness.authority_context
              .character_card_identity_hash
            : current.characterCard.identityHash,
      });
      const expectedState = stateFor(authority);
      if (existingState) {
        if (
          canonicalJson(existingState) !== canonicalJson(expectedState)
        ) {
          fail(
            'fresh_intake_authority_drift',
            'Fresh intake authority no longer matches its persisted state.',
          );
        }
        const [marker, storeExists] = await Promise.all([
          readStoreMarker(storeMarkerPath),
          pathExists(chatSavePath),
        ]);
        if (Boolean(marker) !== storeExists) {
          fail(
            'fresh_intake_store_lifecycle_drift',
            'Fresh intake store path and initialization marker disagree.',
          );
        }
        if (marker) {
          await assertStoreMarkerCurrent(authority);
        }
        return structuredClone(authority);
      }
      if (
        await pathExists(path.join(
          canonicalRoot,
          `chat-${sha256(chatId).slice(0, 24)}`,
        ))
      ) {
        fail(
          'fresh_intake_preexisting_state_without_authority',
          'Fresh intake found preexisting chat-save state without authority.',
        );
      }
      await persistOrVerifyState(
        resolvedStatePath,
        expectedState,
      );
      return structuredClone(authority);
    },
    async assertCurrent(authority) {
      await assertCurrentAuthority(structuredClone(authority));
      return structuredClone(authority);
    },
    async markStoreInitialized(authority) {
      const boundAuthority = structuredClone(authority);
      await assertCurrentAuthority(boundAuthority);
      const store = await captureStableDirectory(chatSavePath, {
        invalidReasonCode: 'fresh_intake_store_missing',
        driftReasonCode: 'fresh_intake_store_drift',
        label: 'Fresh intake chat-save store',
      });
      const marker = storeMarkerFor(
        boundAuthority,
        chatSavePath,
        store.identityHash,
      );
      await publishPrivateJsonNoReplace({
        targetPath: storeMarkerPath,
        expected: marker,
        readExisting: readStoreMarker,
        driftReasonCode: 'fresh_intake_store_marker_drift',
        driftMessage:
          'Fresh intake store marker belongs to another authority.',
      });
      await assertStoreMarkerCurrent(boundAuthority);
      return {
        phase: 'store_initialized',
        authority: structuredClone(boundAuthority),
        marker_hash: marker.marker_hash,
      };
    },
    async assertStoreCurrent(authority) {
      const boundAuthority = structuredClone(authority);
      await assertCurrentAuthority(boundAuthority);
      const marker = await assertStoreMarkerCurrent(boundAuthority);
      return {
        phase: 'store_initialized',
        authority: structuredClone(boundAuthority),
        marker_hash: marker.marker_hash,
      };
    },
    async healthSummary() {
      const [state, marker] = await Promise.all([
        readState(resolvedStatePath),
        readStoreMarker(storeMarkerPath),
      ]);
      const current = await currentWitnessInputs({
        allowProgression: allowHostChatProgression,
        allowCharacterCardIdentityProgression: Boolean(
          state && marker,
        ),
      });
      const storeExists = await pathExists(chatSavePath);
      if (
        marker && !state
      ) {
        fail(
          'fresh_intake_store_marker_drift',
          'Fresh intake store marker exists without authority state.',
        );
      }
      if (
        (!state && storeExists)
        || (state && Boolean(marker) !== storeExists)
      ) {
        fail(
          'fresh_intake_store_lifecycle_drift',
          'Fresh intake store path and initialization marker disagree.',
        );
      }
      if (
        state && (
          state.authority.witness_hash !== acceptedWitness.self_hash
          || state.authority.chat_id_hash
            !== acceptedWitness.subject.chat_id_hash
          || state.authority.character_id_hash
            !== acceptedWitness.subject.character_id_hash
          || state.authority.chat_save_root_hash
            !== acceptedWitness.authority_context.chat_save_root_hash
          || state.authority.chat_save_root_identity_hash
            !== current.root.identityHash
          || state.authority.host_chat_hash
            !== (
              allowHostChatProgression
                ? acceptedWitness.files.chat_jsonl.content_hash
                : current.hostChat.contentHash
            )
          || state.authority.host_chat_identity_hash
            !== (
              allowHostChatProgression
                ? acceptedWitness.authority_context
                  .host_chat_identity_hash
                : current.hostChat.identityHash
            )
          || state.authority.character_card_hash
            !== current.characterCard.contentHash
          || state.authority.character_card_identity_hash
            !== (
              marker
                ? acceptedWitness.authority_context
                  .character_card_identity_hash
                : current.characterCard.identityHash
            )
        )
      ) {
        fail(
          'fresh_intake_authority_drift',
          'Fresh intake authority no longer matches its persisted state.',
        );
      }
      if (state && marker) {
        await assertStoreMarkerCurrent(state.authority);
      }
      return {
        schema: 'mnemosyne.fresh-intake-authority-guard.v1',
        status: 'ready',
        witness_hash: acceptedWitness.self_hash,
        phase: marker
          ? 'store_initialized'
          : (state ? 'intake_started' : 'fresh'),
        chat_id_hash: acceptedWitness.subject.chat_id_hash,
        character_id_hash: acceptedWitness.subject.character_id_hash,
        chat_save_root_hash:
          acceptedWitness.authority_context.chat_save_root_hash,
        host_chat_hash: allowHostChatProgression
          ? acceptedWitness.files.chat_jsonl.content_hash
          : current.hostChat.contentHash,
        state_hash: state?.state_hash ?? null,
      };
    },
  });
}

export async function loadFreshIntakeAdmissionGuard({
  witnessPath,
  statePath,
  chatSaveRoot,
  allowHostChatProgression = false,
} = {}) {
  if (
    typeof witnessPath !== 'string'
    || witnessPath.trim().length === 0
  ) {
    throw new Error('Fresh Intake Admission requires witnessPath.');
  }
  let witness;
  try {
    witness = JSON.parse(await readFile(path.resolve(witnessPath), 'utf8'));
  } catch {
    fail(
      'fresh_intake_witness_invalid',
      'Fresh intake witness could not be read.',
    );
  }
  return createFreshIntakeAdmissionGuard({
    witness,
    statePath,
    chatSaveRoot,
    allowHostChatProgression,
  });
}
