#!/usr/bin/env node
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RECEIPT_SCHEMA = 'mnemosyne.code-authority-migration.v1';
const CODE_ROOT_RELATIVE_PATH =
  'data/default-user/extensions/tavern-mnemosyne';
const LEGACY_PUBLIC_RELATIVE_PATH =
  'public/scripts/extensions/third-party/tavern-mnemosyne';
const BACKUP_ROOT_RELATIVE_PATH =
  'data/_mnemosyne/install/legacy-public-mirror-backups';
const RECEIPT_ROOT_RELATIVE_PATH =
  'data/_mnemosyne/install/code-authority-migrations';

function migrationError(reasonCode, message) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  return error;
}

async function metadataOrNull(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertRealDirectory(targetPath, {
  missingReason,
  symlinkReason,
  invalidReason,
}) {
  const metadata = await metadataOrNull(targetPath);
  if (!metadata) {
    throw migrationError(missingReason, `Required directory is missing: ${targetPath}`);
  }
  if (metadata.isSymbolicLink()) {
    throw migrationError(symlinkReason, `Refusing a symlinked directory: ${targetPath}`);
  }
  if (!metadata.isDirectory()) {
    throw migrationError(invalidReason, `Expected a directory: ${targetPath}`);
  }
  if (await realpath(targetPath) !== path.resolve(targetPath)) {
    throw migrationError(symlinkReason, `Directory resolves outside its exact path: ${targetPath}`);
  }
}

async function ensureRealDirectoryChain(rootPath, relativePath, reasonPrefix) {
  let currentPath = rootPath;
  for (const segment of relativePath.split('/')) {
    currentPath = path.join(currentPath, segment);
    const metadata = await metadataOrNull(currentPath);
    if (!metadata) {
      await mkdir(currentPath);
    }
    await assertRealDirectory(currentPath, {
      missingReason: `${reasonPrefix}_missing`,
      symlinkReason: `${reasonPrefix}_symlink`,
      invalidReason: `${reasonPrefix}_invalid`,
    });
  }
  return currentPath;
}

async function readJson(targetPath, reasonCode) {
  try {
    const value = JSON.parse(await readFile(targetPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch {
    throw migrationError(reasonCode, `Invalid release manifest: ${targetPath}`);
  }
}

async function validateUserClone(sillyTavernRoot) {
  const codeRoot = path.join(
    sillyTavernRoot,
    ...CODE_ROOT_RELATIVE_PATH.split('/'),
  );
  await assertRealDirectory(codeRoot, {
    missingReason: 'code_authority_root_missing',
    symlinkReason: 'code_authority_root_symlink',
    invalidReason: 'code_authority_root_invalid',
  });
  await assertRealDirectory(path.join(codeRoot, '.git'), {
    missingReason: 'code_authority_git_missing',
    symlinkReason: 'code_authority_git_symlink',
    invalidReason: 'code_authority_git_invalid',
  });

  const [
    rootManifest,
    rootPackage,
    extensionManifest,
    runtimeManifest,
  ] = await Promise.all([
    readJson(
      path.join(codeRoot, 'manifest.json'),
      'code_authority_manifest_invalid',
    ),
    readJson(
      path.join(codeRoot, 'package.json'),
      'code_authority_package_invalid',
    ),
    readJson(
      path.join(
        codeRoot,
        'tavern-mnemosyne',
        'integrations',
        'sillytavern-extension',
        'manifest.json',
      ),
      'code_authority_extension_manifest_invalid',
    ),
    readJson(
      path.join(
        codeRoot,
        'tavern-mnemosyne',
        'distribution',
        'runtime-bundle',
        'manifest.json',
      ),
      'code_authority_runtime_manifest_invalid',
    ),
  ]);
  const version = rootManifest.version;
  if (
    typeof version !== 'string'
    || !version
    || rootPackage.version !== version
    || extensionManifest.version !== version
    || runtimeManifest.package_version !== version
  ) {
    throw migrationError(
      'code_authority_version_mismatch',
      'The exact user clone does not contain one internally consistent release version.',
    );
  }
  return Object.freeze({ codeRoot, version });
}

function portableTimestamp(value) {
  return String(value).replaceAll(/[^0-9A-Za-z]/g, '');
}

export async function migrateCodeAuthority({
  sillyTavernRoot,
  now = () => new Date().toISOString(),
  randomUUID = nodeRandomUUID,
}) {
  const requestedRoot = path.resolve(String(sillyTavernRoot ?? ''));
  const rootMetadata = await metadataOrNull(requestedRoot);
  if (
    !rootMetadata
    || rootMetadata.isSymbolicLink()
    || !rootMetadata.isDirectory()
  ) {
    throw migrationError(
      'code_authority_sillytavern_root_invalid',
      'The migration requires one exact, non-symlinked SillyTavern root.',
    );
  }
  const canonicalRoot = await realpath(requestedRoot);
  const serverEntry = await metadataOrNull(path.join(canonicalRoot, 'server.js'));
  if (!serverEntry?.isFile() || serverEntry.isSymbolicLink()) {
    throw migrationError(
      'code_authority_sillytavern_root_invalid',
      'The selected directory is not a supported SillyTavern root.',
    );
  }

  const { version } = await validateUserClone(canonicalRoot);
  const legacyPublicPath = path.join(
    canonicalRoot,
    ...LEGACY_PUBLIC_RELATIVE_PATH.split('/'),
  );
  if (!await metadataOrNull(legacyPublicPath)) {
    return Object.freeze({
      schema: RECEIPT_SCHEMA,
      status: 'already_single_authority',
      code_root_relative_path: CODE_ROOT_RELATIVE_PATH,
      extension_version: version,
      backup_relative_path: null,
      receipt_relative_path: null,
    });
  }

  const legacyParent = path.dirname(legacyPublicPath);
  await assertRealDirectory(legacyParent, {
    missingReason: 'code_authority_public_parent_missing',
    symlinkReason: 'code_authority_public_parent_symlink',
    invalidReason: 'code_authority_public_parent_invalid',
  });
  const backupRoot = await ensureRealDirectoryChain(
    canonicalRoot,
    BACKUP_ROOT_RELATIVE_PATH,
    'code_authority_backup_root',
  );
  const receiptRoot = await ensureRealDirectoryChain(
    canonicalRoot,
    RECEIPT_ROOT_RELATIVE_PATH,
    'code_authority_receipt_root',
  );

  const migrationId = randomUUID();
  if (
    typeof migrationId !== 'string'
    || !/^[A-Za-z0-9._-]{1,160}$/.test(migrationId)
  ) {
    throw migrationError(
      'code_authority_migration_id_invalid',
      'The migration identity is invalid.',
    );
  }
  const observedAt = now();
  const backupName = `${portableTimestamp(observedAt)}-${migrationId}`;
  const backupRelativePath = `${BACKUP_ROOT_RELATIVE_PATH}/${backupName}`;
  const backupPath = path.join(backupRoot, backupName);
  const stagedReceiptPath = path.join(receiptRoot, `${migrationId}.staged.json`);
  const receiptRelativePath =
    `${RECEIPT_ROOT_RELATIVE_PATH}/${migrationId}.json`;
  const receiptPath = path.join(canonicalRoot, ...receiptRelativePath.split('/'));
  const baseReceipt = {
    schema: RECEIPT_SCHEMA,
    migration_id: migrationId,
    code_root_relative_path: CODE_ROOT_RELATIVE_PATH,
    extension_version: version,
    legacy_public_relative_path: LEGACY_PUBLIC_RELATIVE_PATH,
    backup_relative_path: backupRelativePath,
  };
  await writeFile(
    stagedReceiptPath,
    `${JSON.stringify({
      ...baseReceipt,
      status: 'prepared',
      prepared_at: observedAt,
    }, null, 2)}\n`,
    { flag: 'wx' },
  );

  let moved = false;
  try {
    await rename(legacyPublicPath, backupPath);
    moved = true;
    const result = Object.freeze({
      schema: RECEIPT_SCHEMA,
      status: 'migrated',
      code_root_relative_path: CODE_ROOT_RELATIVE_PATH,
      extension_version: version,
      backup_relative_path: backupRelativePath,
      receipt_relative_path: receiptRelativePath,
    });
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        ...baseReceipt,
        status: 'migrated',
        completed_at: now(),
      }, null, 2)}\n`,
      { flag: 'wx' },
    );
    await rm(stagedReceiptPath);
    return result;
  } catch (error) {
    if (
      moved
      && await metadataOrNull(backupPath)
      && !await metadataOrNull(legacyPublicPath)
    ) {
      try {
        await rename(backupPath, legacyPublicPath);
      } catch (restoreError) {
        throw migrationError(
          'code_authority_restore_failed',
          `Migration failed and the public mirror could not be restored: ${restoreError.message}`,
        );
      }
    }
    await rm(receiptPath, { force: true }).catch(() => {});
    throw error;
  }
}

function parseCliArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--sillytavern-root' || !argv[1]) {
    throw migrationError(
      'code_authority_cli_usage',
      'Usage: node migrate-code-authority.mjs --sillytavern-root <path>',
    );
  }
  return argv[1];
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await migrateCodeAuthority({
      sillyTavernRoot: parseCliArguments(process.argv.slice(2)),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.reasonCode ?? 'code_authority_migration_failed'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
