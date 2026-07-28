import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalJson,
  sha256,
} from '../contracts/hash.js';

const BUNDLE_SCHEMA = 'mnemosyne.immutable-evidence-bundle.v1';
const POINTER_SCHEMA = 'mnemosyne.immutable-evidence-pointer.v1';
const CHANNEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertChannel(channel) {
  if (!CHANNEL_PATTERN.test(channel ?? '')) {
    throw new TypeError('Evidence channel must be a lowercase slug.');
  }
}

function assertFileName(fileName) {
  if (!FILE_NAME_PATTERN.test(fileName ?? '')) {
    throw new TypeError(
      'Evidence bundle file names must be safe base names.',
    );
  }
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeFiles(files) {
  if (!(files instanceof Map) || files.size === 0) {
    throw new TypeError('Evidence files must be a non-empty Map.');
  }
  return new Map(
    [...files.entries()]
      .map(([fileName, content]) => {
        assertFileName(fileName);
        return [
          fileName,
          Buffer.isBuffer(content)
            ? Buffer.from(content)
            : Buffer.from(String(content), 'utf8'),
        ];
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function syncDirectory(directoryPath) {
  const handle = await open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(filePath, content) {
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function bundleContract({ channel, files }) {
  const payload = {
    schema: BUNDLE_SCHEMA,
    channel,
    files: [...files.entries()].map(([fileName, content]) => ({
      name: fileName,
      byte_length: content.byteLength,
      sha256: digest(content),
    })),
  };
  const bundleId = sha256(canonicalJson(payload));
  const contractPayload = {
    ...payload,
    bundle_id: bundleId,
  };
  return {
    ...contractPayload,
    contract_hash: sha256(canonicalJson(contractPayload)),
  };
}

function pointerContract({ channel, bundleId, manifestHash }) {
  const payload = {
    schema: POINTER_SCHEMA,
    channel,
    bundle_id: bundleId,
    manifest_hash: manifestHash,
  };
  return {
    ...payload,
    contract_hash: sha256(canonicalJson(payload)),
  };
}

function verifyContract(document, schema) {
  const {
    contract_hash: contractHash,
    ...payload
  } = document ?? {};
  return (
    document?.schema === schema
    && /^[a-f0-9]{64}$/.test(contractHash ?? '')
    && contractHash === sha256(canonicalJson(payload))
  );
}

function invalidEvidence(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.reasonCode = 'immutable_evidence_invalid';
  return error;
}

async function verifyPrivatePath(filePath, kind, expectedType) {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink()) {
    throw invalidEvidence(`${kind} must not be a symbolic link.`);
  }
  if (
    (expectedType === 'directory' && !metadata.isDirectory())
    || (expectedType === 'file' && !metadata.isFile())
  ) {
    throw invalidEvidence(`${kind} has the wrong filesystem type.`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw invalidEvidence(`${kind} is not private.`);
  }
}

async function ensurePrivateDirectory(directoryPath, kind) {
  const missing = [];
  let cursor = directoryPath;
  while (true) {
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw invalidEvidence(
          `${kind} contains an unsafe filesystem path.`,
        );
      }
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw invalidEvidence(`${kind} has no existing parent directory.`);
      }
      cursor = parent;
    }
  }

  for (const pendingPath of missing.reverse()) {
    try {
      await mkdir(pendingPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(pendingPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw invalidEvidence(`${kind} raced with an unsafe path.`);
    }
    await chmod(pendingPath, 0o700);
    await syncDirectory(pendingPath);
    await syncDirectory(path.dirname(pendingPath));
  }

  await chmod(directoryPath, 0o700);
  await verifyPrivatePath(directoryPath, kind, 'directory');
  await syncDirectory(directoryPath);
  await syncDirectory(path.dirname(directoryPath));
}

async function readBundleAt({
  rootDir,
  channel,
  pointer,
}) {
  const bundlesRoot = path.join(
    rootDir,
    'immutable-evidence-bundles',
  );
  const channelDir = path.join(bundlesRoot, channel);
  await verifyPrivatePath(rootDir, 'Evidence root', 'directory');
  await verifyPrivatePath(
    bundlesRoot,
    'Evidence bundles directory',
    'directory',
  );
  await verifyPrivatePath(
    channelDir,
    'Evidence channel directory',
    'directory',
  );
  const bundleDir = path.join(
    channelDir,
    pointer.bundle_id,
  );
  await verifyPrivatePath(
    bundleDir,
    'Evidence bundle directory',
    'directory',
  );
  const manifestPath = path.join(bundleDir, 'manifest.json');
  await verifyPrivatePath(
    manifestPath,
    'Evidence bundle manifest',
    'file',
  );
  const manifestSource = await readFile(manifestPath);
  const manifest = JSON.parse(manifestSource.toString('utf8'));
  const expectedBundleId = sha256(canonicalJson({
    schema: manifest?.schema,
    channel: manifest?.channel,
    files: manifest?.files,
  }));
  if (
    !verifyContract(manifest, BUNDLE_SCHEMA)
    || manifest.channel !== channel
    || manifest.bundle_id !== pointer.bundle_id
    || manifest.bundle_id !== expectedBundleId
    || digest(manifestSource) !== pointer.manifest_hash
    || !Array.isArray(manifest.files)
    || manifest.files.length === 0
  ) {
    throw invalidEvidence(
      manifest?.bundle_id !== expectedBundleId
        ? 'Evidence bundle content address is invalid.'
        : 'Evidence bundle manifest is invalid.',
    );
  }

  const files = new Map();
  const seen = new Set();
  for (const entry of manifest.files) {
    assertFileName(entry?.name);
    if (
      seen.has(entry.name)
      || !Number.isSafeInteger(entry.byte_length)
      || entry.byte_length < 0
      || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')
    ) {
      throw invalidEvidence('Evidence bundle file contract is invalid.');
    }
    seen.add(entry.name);
    const filePath = path.join(bundleDir, entry.name);
    await verifyPrivatePath(filePath, 'Evidence bundle file', 'file');
    const content = await readFile(filePath);
    if (
      content.byteLength !== entry.byte_length
      || digest(content) !== entry.sha256
    ) {
      throw invalidEvidence(
        `Evidence bundle file ${entry.name} failed integrity validation.`,
      );
    }
    files.set(entry.name, content);
  }

  return {
    schema: manifest.schema,
    channel,
    bundle_id: manifest.bundle_id,
    contract_hash: manifest.contract_hash,
    manifest_hash: pointer.manifest_hash,
    files,
  };
}

export function createImmutableEvidenceStore({
  faultInjector = async () => {},
} = {}) {
  if (typeof faultInjector !== 'function') {
    throw new TypeError('faultInjector must be a function.');
  }

  return {
    async publishBundle({
      rootDir,
      channel,
      files: suppliedFiles,
    }) {
      assertChannel(channel);
      const files = normalizeFiles(suppliedFiles);
      if (typeof rootDir !== 'string' || rootDir.trim() === '') {
        throw new TypeError('Evidence rootDir must be a non-empty path.');
      }
      const rootPath = path.resolve(rootDir);
      if (rootPath === path.parse(rootPath).root) {
        throw new TypeError(
          'Evidence publication refuses a filesystem root directory.',
        );
      }
      const bundlesRoot = path.join(
        rootPath,
        'immutable-evidence-bundles',
      );
      const channelDir = path.join(bundlesRoot, channel);
      await ensurePrivateDirectory(rootPath, 'Evidence root');
      await ensurePrivateDirectory(
        bundlesRoot,
        'Evidence bundles directory',
      );
      await ensurePrivateDirectory(
        channelDir,
        'Evidence channel directory',
      );

      const manifest = bundleContract({ channel, files });
      const manifestSource = Buffer.from(
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );
      const finalBundleDir = path.join(
        channelDir,
        manifest.bundle_id,
      );
      const stagingDir = await mkdtemp(path.join(
        channelDir,
        '.pending-',
      ));
      await chmod(stagingDir, 0o700);
      let bundleSealed = false;
      try {
        for (const [fileName, content] of files) {
          await writePrivateFile(
            path.join(stagingDir, fileName),
            content,
          );
        }
        await writePrivateFile(
          path.join(stagingDir, 'manifest.json'),
          manifestSource,
        );
        await syncDirectory(stagingDir);
        try {
          await rename(stagingDir, finalBundleDir);
          bundleSealed = true;
          await syncDirectory(channelDir);
        } catch (error) {
          if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') {
            throw error;
          }
          await readBundleAt({
            rootDir: rootPath,
            channel,
            pointer: {
              bundle_id: manifest.bundle_id,
              manifest_hash: digest(manifestSource),
            },
          });
        }
      } finally {
        if (!bundleSealed) {
          await rm(stagingDir, { recursive: true, force: true });
        }
      }

      await faultInjector({
        point: 'after_bundle_sealed',
        channel,
        bundle_id: manifest.bundle_id,
      });

      const pointer = pointerContract({
        channel,
        bundleId: manifest.bundle_id,
        manifestHash: digest(manifestSource),
      });
      const pointerPath = path.join(
        rootPath,
        `${channel}-current.json`,
      );
      const temporaryPointerPath = path.join(
        rootPath,
        `.${channel}-current.tmp-${process.pid}-${randomUUID()}`,
      );
      try {
        await writePrivateFile(
          temporaryPointerPath,
          Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, 'utf8'),
        );
        await faultInjector({
          point: 'after_pointer_staged',
          channel,
          bundle_id: manifest.bundle_id,
        });
        await rename(temporaryPointerPath, pointerPath);
        await syncDirectory(rootPath);
      } finally {
        await rm(temporaryPointerPath, { force: true });
      }

      return {
        schema: manifest.schema,
        channel,
        bundle_id: manifest.bundle_id,
        contract_hash: manifest.contract_hash,
        manifest_hash: pointer.manifest_hash,
        pointer_path: pointerPath,
        bundle_path: finalBundleDir,
      };
    },

    async readCurrentBundle({
      rootDir,
      channel,
    }) {
      assertChannel(channel);
      const rootPath = path.resolve(rootDir);
      const pointerPath = path.join(
        rootPath,
        `${channel}-current.json`,
      );
      let pointerSource;
      try {
        await verifyPrivatePath(rootPath, 'Evidence root', 'directory');
        await verifyPrivatePath(
          pointerPath,
          'Evidence pointer',
          'file',
        );
        pointerSource = await readFile(pointerPath, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const missing = new Error(
          `No current evidence bundle exists for ${channel}.`,
          { cause: error },
        );
        missing.reasonCode = 'immutable_evidence_current_missing';
        throw missing;
      }
      let pointer;
      try {
        pointer = JSON.parse(pointerSource);
      } catch (error) {
        throw invalidEvidence('Evidence pointer is not valid JSON.', error);
      }
      if (
        !verifyContract(pointer, POINTER_SCHEMA)
        || pointer.channel !== channel
        || !/^[a-f0-9]{64}$/.test(pointer.bundle_id ?? '')
        || !/^[a-f0-9]{64}$/.test(pointer.manifest_hash ?? '')
      ) {
        throw invalidEvidence('Evidence pointer is invalid.');
      }
      try {
        return await readBundleAt({
          rootDir: rootPath,
          channel,
          pointer,
        });
      } catch (error) {
        if (error?.reasonCode === 'immutable_evidence_invalid') {
          throw error;
        }
        throw invalidEvidence('Evidence bundle cannot be read.', error);
      }
    },
  };
}
