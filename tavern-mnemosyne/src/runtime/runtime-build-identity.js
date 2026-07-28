import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';

import { canonicalJson, sha256 } from '../contracts/hash.js';

const CONFIGURED_BUILD_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,255}$/;
const INCLUDED_ROOT_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
]);
const INCLUDED_TREES = Object.freeze([{
  relativePath: 'src',
  extensions: new Set(['.js', '.json']),
}, {
  relativePath: path.join(
    'integrations',
    'sillytavern-extension',
  ),
  extensions: new Set(['.js', '.json', '.css']),
}]);

function normalizedRelativePath(packageRoot, filePath) {
  return path.relative(packageRoot, filePath).split(path.sep).join('/');
}

function collectTreeFiles({
  packageRoot,
  directoryPath,
  extensions,
  files,
}) {
  if (!existsSync(directoryPath)) return;
  for (const entry of readdirSync(directoryPath, {
    withFileTypes: true,
  }).sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Runtime build manifest does not accept symlink ${entryPath}.`,
      );
    }
    if (entry.isDirectory()) {
      collectTreeFiles({
        packageRoot,
        directoryPath: entryPath,
        extensions,
        files,
      });
      continue;
    }
    if (
      entry.isFile()
      && extensions.has(path.extname(entry.name))
    ) {
      files.push(entryPath);
    }
  }
}

function sourceManifest(packageRoot) {
  if (
    typeof packageRoot !== 'string'
    || !path.isAbsolute(packageRoot)
    || !lstatSync(packageRoot).isDirectory()
  ) {
    throw new TypeError(
      'packageRoot must be an existing absolute directory.',
    );
  }
  const files = [];
  for (const relativePath of INCLUDED_ROOT_FILES) {
    const filePath = path.join(packageRoot, relativePath);
    if (existsSync(filePath)) files.push(filePath);
  }
  for (const tree of INCLUDED_TREES) {
    collectTreeFiles({
      packageRoot,
      directoryPath: path.join(packageRoot, tree.relativePath),
      extensions: tree.extensions,
      files,
    });
  }
  files.sort((left, right) => (
    normalizedRelativePath(packageRoot, left)
      .localeCompare(normalizedRelativePath(packageRoot, right))
  ));
  if (files.length === 0) {
    throw new Error('Runtime build manifest has no source files.');
  }
  return {
    schema: 'mnemosyne.runtime-source-manifest.v1',
    files: files.map(filePath => ({
      path: normalizedRelativePath(packageRoot, filePath),
      content_hash: sha256(
        readFileSync(filePath).toString('base64'),
      ),
    })),
  };
}

export function resolveRuntimeBuildIdentity({
  configuredBuildId = '',
  packageVersion,
  packageRoot,
} = {}) {
  const configured = String(configuredBuildId ?? '').trim();
  if (configured) {
    if (!CONFIGURED_BUILD_ID_PATTERN.test(configured)) {
      throw new TypeError(
        'Configured runtime build id is invalid.',
      );
    }
    return {
      runtimeBuildId: configured,
      runtimeBuildIdSource: 'configured',
    };
  }
  if (
    typeof packageVersion !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(packageVersion)
  ) {
    throw new TypeError('packageVersion is invalid.');
  }
  const manifestHash = sha256(canonicalJson(
    sourceManifest(packageRoot),
  ));
  return {
    runtimeBuildId:
      `tavern-mnemosyne@${packageVersion}+src.${manifestHash.slice(0, 16)}`,
    runtimeBuildIdSource: 'source_manifest',
  };
}
