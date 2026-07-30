import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const BINDING_SCHEMA = 'mnemosyne.bootstrap-binding.v1';
const ownDirectory = path.dirname(fileURLToPath(import.meta.url));
const sillyTavernRoot = path.resolve(ownDirectory, '..', '..');
const dataRoot = path.join(sillyTavernRoot, 'data');
const EXPECTED_CODE_ROOT_RELATIVE =
  'data/default-user/extensions/tavern-mnemosyne';
const bindingPath = path.join(ownDirectory, 'binding.json');
const RELEASE_REPOSITORY = 'winintony/tavern-mnemosyne';
const MAX_RUNTIME_ARCHIVE_BYTES = 128 * 1024 * 1024;

export const info = Object.freeze({
  id: 'tavern-mnemosyne',
  name: 'Tavern Mnemosyne Bootstrap',
  description: 'Loads one sealed local Mnemosyne runtime binding.',
});

function fail(reasonCode, message) {
  const error = new Error(message);
  error.code = reasonCode;
  throw error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertRelativePath(value) {
  if (
    typeof value !== 'string'
    || !value
    || path.isAbsolute(value)
    || value.replaceAll('\\', '/').split('/').some(
      segment => !segment || segment === '.' || segment === '..',
    )
  ) {
    fail(
      'MNEMOSYNE_BOOTSTRAP_PATH_UNSAFE',
      'The Mnemosyne code binding path is unsafe.',
    );
  }
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function tarString(header, start, length) {
  return header.subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/s, '');
}

function tarOctal(header, start, length) {
  const value = tarString(header, start, length).trim();
  if (!/^[0-7]*$/.test(value)) {
    fail(
      'MNEMOSYNE_RUNTIME_ASSET_TAR_INVALID',
      'The runtime Release asset has an invalid tar field.',
    );
  }
  return value ? Number.parseInt(value, 8) : 0;
}

function tarChecksum(header) {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}

function unpackRuntimeTar(compressed) {
  let archive;
  try {
    archive = gunzipSync(compressed);
  } catch {
    fail(
      'MNEMOSYNE_RUNTIME_ASSET_GZIP_INVALID',
      'The runtime Release asset is not a valid gzip archive.',
    );
  }
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    if (tarChecksum(header) !== tarOctal(header, 148, 8)) {
      fail(
        'MNEMOSYNE_RUNTIME_ASSET_TAR_INVALID',
        'The runtime Release asset has an invalid tar checksum.',
      );
    }
    const relativePath = tarString(header, 0, 100);
    assertRelativePath(relativePath);
    const type = String.fromCharCode(header[156] || 0x30);
    if (type !== '0' && type !== '\0') {
      fail(
        'MNEMOSYNE_RUNTIME_ASSET_TAR_INVALID',
        `Unsupported runtime archive entry ${relativePath}.`,
      );
    }
    if (files.has(relativePath)) {
      fail(
        'MNEMOSYNE_RUNTIME_ASSET_TAR_INVALID',
        `Duplicate runtime archive entry ${relativePath}.`,
      );
    }
    const size = tarOctal(header, 124, 12);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > archive.length) {
      fail(
        'MNEMOSYNE_RUNTIME_ASSET_TAR_INVALID',
        `Truncated runtime archive entry ${relativePath}.`,
      );
    }
    files.set(relativePath, archive.subarray(contentStart, contentEnd));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function validateRuntimeFiles(manifest, files) {
  validateRuntimeManifest(manifest);
  const expected = new Set();
  for (const record of manifest.files) {
    expected.add(record.path);
    const content = files.get(record.path);
    if (
      !content
      || content.length !== record.bytes
      || sha256(content) !== record.sha256
    ) {
      fail(
        'MNEMOSYNE_RUNTIME_ASSET_FILE_MISMATCH',
        `The runtime Release asset file ${record.path} is invalid.`,
      );
    }
  }
  if (
    files.size !== expected.size
    || [...files.keys()].some(file => !expected.has(file))
  ) {
    fail(
      'MNEMOSYNE_RUNTIME_ASSET_EXTRA_FILE',
      'The runtime Release asset contains an unsealed file.',
    );
  }
}

function validateRuntimeManifest(manifest) {
  if (
    !Array.isArray(manifest.files)
    || !manifest.files.some(
      record => record.path === 'distribution/server-plugin/index.mjs',
    )
  ) {
    fail(
      'MNEMOSYNE_BOOTSTRAP_SERVER_ENTRY_UNSEALED',
      'The runtime manifest does not seal the server entry.',
    );
  }
  if (
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(
      manifest?.package_version ?? '',
    )
    || !/^[a-f0-9]{64}$/.test(manifest?.archive_sha256 ?? '')
    || !Number.isSafeInteger(manifest?.archive_bytes)
    || manifest.archive_bytes <= 0
    || manifest.archive_bytes > MAX_RUNTIME_ARCHIVE_BYTES
  ) {
    fail(
      'MNEMOSYNE_RUNTIME_ASSET_MANIFEST_INVALID',
      'The runtime Release asset manifest is invalid.',
    );
  }
  const tag = `v${manifest.package_version}`;
  const assetName =
    `Tavern-Mnemosyne-Runtime-${tag}.tar.gz`;
  if (
    manifest.release_asset?.repository !== RELEASE_REPOSITORY
    || manifest.release_asset?.tag !== tag
    || manifest.release_asset?.name !== assetName
  ) {
    fail(
      'MNEMOSYNE_RUNTIME_ASSET_MANIFEST_INVALID',
      'The runtime Release asset binding is invalid.',
    );
  }
  const expected = new Set();
  for (const record of manifest.files) {
    assertRelativePath(record.path);
    if (
      expected.has(record.path)
      || !Number.isSafeInteger(record.bytes)
      || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '')
    ) {
      fail(
        'MNEMOSYNE_RUNTIME_ASSET_MANIFEST_INVALID',
        'The runtime Release asset manifest is invalid.',
      );
    }
    expected.add(record.path);
  }
  return Object.freeze({ assetName, tag });
}

function installedRuntimeMatches(manifest, runtimeRoot) {
  if (!existsSync(runtimeRoot)) return false;
  const actualPaths = [];
  const pending = [''];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const absoluteDirectory = path.join(runtimeRoot, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory, {
      withFileTypes: true,
    })) {
      const relativePath = path.posix.join(
        relativeDirectory.replaceAll(path.sep, '/'),
        entry.name,
      );
      if (entry.isDirectory()) {
        pending.push(relativePath);
      } else if (entry.isFile()) {
        actualPaths.push(relativePath);
      } else {
        return false;
      }
    }
  }
  const expectedPaths = new Set(manifest.files.map(record => record.path));
  if (
    actualPaths.length !== expectedPaths.size
    || actualPaths.some(relativePath => !expectedPaths.has(relativePath))
  ) {
    return false;
  }
  for (const record of manifest.files ?? []) {
    assertRelativePath(record.path);
    const target = path.resolve(runtimeRoot, record.path);
    const content = inside(runtimeRoot, target) && existsSync(target)
      ? readFileSync(target)
      : null;
    if (
      !content
      || content.length !== record.bytes
      || sha256(content) !== record.sha256
    ) {
      return false;
    }
  }
  return true;
}

export async function installRuntimeReleaseAsset({
  manifest,
  runtimeRoot,
  fetchImpl = globalThis.fetch,
  randomUUIDImpl = randomUUID,
}) {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const { assetName, tag } = validateRuntimeManifest(manifest);
  if (installedRuntimeMatches(manifest, resolvedRuntimeRoot)) {
    return Object.freeze({ reused: true, runtimeRoot: resolvedRuntimeRoot });
  }
  if (existsSync(resolvedRuntimeRoot)) {
    fail(
      'MNEMOSYNE_BOOTSTRAP_RUNTIME_FILE_MISMATCH',
      'An existing sealed runtime is incomplete or changed.',
    );
  }
  const assetUrl =
    `https://github.com/${RELEASE_REPOSITORY}/releases/download/`
    + `${tag}/${assetName}`;
  const response = await fetchImpl(assetUrl, {
    redirect: 'follow',
    headers: { accept: 'application/octet-stream' },
  });
  if (!response?.ok) {
    fail(
      'MNEMOSYNE_RUNTIME_ASSET_DOWNLOAD_FAILED',
      `The runtime Release asset could not be downloaded (${response?.status ?? 'unknown'}).`,
    );
  }
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAX_RUNTIME_ARCHIVE_BYTES
  ) {
    fail(
      'MNEMOSYNE_RUNTIME_ASSET_TOO_LARGE',
      'The runtime Release asset exceeds the size limit.',
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (
    archive.length !== manifest.archive_bytes
    || sha256(archive) !== manifest.archive_sha256
  ) {
    fail(
      'MNEMOSYNE_RUNTIME_ASSET_HASH_MISMATCH',
      'The runtime Release asset does not match its published manifest.',
    );
  }
  const files = unpackRuntimeTar(archive);
  validateRuntimeFiles(manifest, files);

  const parent = path.dirname(resolvedRuntimeRoot);
  const staging = path.join(
    parent,
    `.staged-${path.basename(resolvedRuntimeRoot)}-${randomUUIDImpl()}`,
  );
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  try {
    for (const [relativePath, content] of files) {
      const target = path.resolve(staging, relativePath);
      if (!inside(staging, target)) {
        fail(
          'MNEMOSYNE_BOOTSTRAP_PATH_UNSAFE',
          'A runtime Release asset path escapes the staging root.',
        );
      }
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
    }
    if (!installedRuntimeMatches(manifest, staging)) {
      fail(
        'MNEMOSYNE_RUNTIME_ASSET_FILE_MISMATCH',
        'The staged runtime Release asset failed verification.',
      );
    }
    renameSync(staging, resolvedRuntimeRoot);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({ reused: false, runtimeRoot: resolvedRuntimeRoot });
}

function readJson(filePath, description) {
  let value;
  try {
    value = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    fail(
      'MNEMOSYNE_BOOTSTRAP_JSON_INVALID',
      `${description} is not valid JSON.`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'MNEMOSYNE_BOOTSTRAP_JSON_INVALID',
      `${description} must be a JSON object.`,
    );
  }
  return value;
}

function assertDefaultConfigPath() {
  const argumentsAfterScript = process.argv.slice(2);
  for (let index = 0; index < argumentsAfterScript.length; index += 1) {
    const argument = argumentsAfterScript[index];
    if (argument === '--configPath' || argument === '--config-path') {
      const configured = argumentsAfterScript[index + 1];
      if (
        configured
        && path.resolve(configured)
          !== path.join(sillyTavernRoot, 'config.yaml')
      ) {
        fail(
          'MNEMOSYNE_CUSTOM_CONFIG_PATH_UNSUPPORTED',
          'BrowserFolder provisioning only supports the standard config.yaml.',
        );
      }
    }
    if (
      argument.startsWith('--configPath=')
      || argument.startsWith('--config-path=')
    ) {
      const configured = argument.slice(argument.indexOf('=') + 1);
      if (
        path.resolve(configured)
          !== path.join(sillyTavernRoot, 'config.yaml')
      ) {
        fail(
          'MNEMOSYNE_CUSTOM_CONFIG_PATH_UNSUPPORTED',
          'BrowserFolder provisioning only supports the standard config.yaml.',
        );
      }
    }
  }
}

async function resolveBinding() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isSafeInteger(major) || major < 22) {
    fail(
      'MNEMOSYNE_NODE_VERSION_UNSUPPORTED',
      'Mnemosyne requires the SillyTavern process to use Node.js 22 or newer.',
    );
  }
  assertDefaultConfigPath();
  const binding = readJson(bindingPath, 'The Mnemosyne binding receipt');
  if (
    binding.schema !== BINDING_SCHEMA
    || !/^[A-Za-z0-9@._+-]{1,160}$/.test(
      binding.runtime_build_id ?? '',
    )
    || !/^[a-f0-9]{64}$/.test(binding.manifest_hash ?? '')
  ) {
    fail(
      'MNEMOSYNE_BOOTSTRAP_BINDING_INVALID',
      'The Mnemosyne binding receipt is invalid.',
    );
  }
  assertRelativePath(binding.relative_code_root);
  if (binding.relative_code_root !== EXPECTED_CODE_ROOT_RELATIVE) {
    fail(
      'MNEMOSYNE_BOOTSTRAP_CODE_ROOT_MISMATCH',
      'The Mnemosyne binding does not name the exact supported '
        + 'data/default-user Extension clone.',
    );
  }
  const resolvedDataRoot = realpathSync(dataRoot);
  const expectedCodeRoot = path.join(
    resolvedDataRoot,
    'default-user',
    'extensions',
    'tavern-mnemosyne',
  );
  const codeRoot = realpathSync(
    path.resolve(sillyTavernRoot, binding.relative_code_root),
  );
  if (codeRoot !== expectedCodeRoot) {
    fail(
      'MNEMOSYNE_BOOTSTRAP_CODE_ROOT_MISMATCH',
      'The exact Mnemosyne Extension path resolves to another code root.',
    );
  }
  if (!inside(resolvedDataRoot, codeRoot)) {
    fail(
      'MNEMOSYNE_BOOTSTRAP_CODE_ROOT_ESCAPE',
      'The bound Mnemosyne code root is outside the SillyTavern data root.',
    );
  }
  const rootManifest = readJson(
    path.join(codeRoot, 'manifest.json'),
    'The Mnemosyne code manifest',
  );
  if (rootManifest.version !== binding.extension_version) {
    fail(
      'MNEMOSYNE_BOOTSTRAP_EXTENSION_VERSION_MISMATCH',
      'The bound Mnemosyne extension version changed.',
    );
  }
  const nestedRoot = path.join(codeRoot, 'tavern-mnemosyne');
  const manifestPath = path.join(
    nestedRoot,
    'distribution',
    'runtime-bundle',
    'manifest.json',
  );
  const manifestSource = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestSource);
  if (
    sha256(manifestSource) !== binding.manifest_hash
    || manifest.runtime_build_id !== binding.runtime_build_id
  ) {
    fail(
      'MNEMOSYNE_BOOTSTRAP_RUNTIME_MANIFEST_MISMATCH',
      'The bound Mnemosyne runtime manifest changed.',
    );
  }
  const stateRoot = path.join(dataRoot, '_mnemosyne');
  const runtimeRoot = path.join(
    stateRoot,
    'runtime',
    binding.runtime_build_id,
  );
  await installRuntimeReleaseAsset({ manifest, runtimeRoot });
  for (const record of manifest.files ?? []) {
    assertRelativePath(record.path);
    const runtimeFile = path.resolve(runtimeRoot, record.path);
    if (
      !inside(runtimeRoot, runtimeFile)
      || !existsSync(runtimeFile)
      || sha256(readFileSync(runtimeFile)) !== record.sha256
    ) {
      fail(
        'MNEMOSYNE_BOOTSTRAP_RUNTIME_FILE_MISMATCH',
        `The sealed runtime file ${record.path} is unavailable.`,
      );
    }
  }
  const serverEntry = path.join(
    runtimeRoot,
    'distribution',
    'server-plugin',
    'index.mjs',
  );
  if (!existsSync(serverEntry)) {
    fail(
      'MNEMOSYNE_BOOTSTRAP_SERVER_ENTRY_MISSING',
      'The bound Mnemosyne server entry is unavailable.',
    );
  }
  return Object.freeze({
    codeRoot: nestedRoot,
    runtimeRoot,
    runtimeBuildId: binding.runtime_build_id,
    stateRoot,
    serverEntry,
  });
}

let loadedPlugin = null;

async function plugin() {
  if (loadedPlugin) return loadedPlugin;
  const resolved = await resolveBinding();
  process.env.MNEMOSYNE_CODE_ROOT = resolved.codeRoot;
  process.env.MNEMOSYNE_RUNTIME_ROOT = resolved.runtimeRoot;
  process.env.MNEMOSYNE_RUNTIME_BUILD_ID =
    resolved.runtimeBuildId;
  process.env.MNEMOSYNE_STATE_ROOT = resolved.stateRoot;
  process.env.MNEMOSYNE_CONFIG_PATH = path.join(
    resolved.stateRoot,
    'config',
    'runtime.json',
  );
  loadedPlugin = await import(pathToFileURL(resolved.serverEntry));
  return loadedPlugin;
}

export async function init(router) {
  const loaded = await plugin();
  return loaded.init(router);
}

export async function exit() {
  if (!loadedPlugin) return;
  return loadedPlugin.exit?.();
}
