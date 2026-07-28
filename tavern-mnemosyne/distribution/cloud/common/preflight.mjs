import {
  closeSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertSqliteWalRuntimeSafe,
  probeSqliteWalRuntime,
} from '../../../src/storage/sqlite-wal-runtime-safety.js';

const REQUIRED_ENVIRONMENT = Object.freeze([
  'MNEMOSYNE_CONTEXT_ACCESS_TOKEN',
  'MNEMOSYNE_UPSTREAM_BASE_URL',
  'MNEMOSYNE_UPSTREAM_MODEL',
  'MNEMOSYNE_PROVIDER_CONTEXT_TOKENS',
  'MNEMOSYNE_PROVIDER_OUTPUT_RESERVE_TOKENS',
]);

export function runCloudPreflight({
  stateRoot = process.env.MNEMOSYNE_STATE_ROOT,
} = {}) {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isSafeInteger(major) || major < 22) {
    throw new Error('Mnemosyne requires Node.js 22 or newer.');
  }
  for (const name of REQUIRED_ENVIRONMENT) {
    if (!String(process.env[name] ?? '').trim()) {
      throw new Error(`${name} is required.`);
    }
  }
  if (
    (process.env.MNEMOSYNE_UPSTREAM_AUTH_MODE ?? 'passthrough')
      !== 'passthrough'
  ) {
    throw new Error(
      'The cloud profiles require passthrough upstream authentication.',
    );
  }
  if (!stateRoot) {
    throw new Error('MNEMOSYNE_STATE_ROOT is required.');
  }
  const resolvedStateRoot = path.resolve(stateRoot);
  mkdirSync(resolvedStateRoot, { recursive: true, mode: 0o700 });
  const probePath = path.join(
    resolvedStateRoot,
    `.preflight-${process.pid}`,
  );
  const descriptor = openSync(probePath, 'wx', 0o600);
  closeSync(descriptor);
  unlinkSync(probePath);
  assertSqliteWalRuntimeSafe();
  const sqlite = probeSqliteWalRuntime();
  return Object.freeze({
    schema: 'mnemosyne.cloud-preflight.v1',
    status: 'ready',
    node_major: major,
    sqlite_version: sqlite.sqlite_version,
    wal_mode: sqlite.wal_mode,
    state_root: resolvedStateRoot,
  });
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.stdout.write(`${JSON.stringify(runCloudPreflight())}\n`);
}
