import {
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function credential({
  environment,
  environmentName,
  secretName,
  secretRoot,
  readSecret,
}) {
  const configured = environment[environmentName];
  if (typeof configured === 'string' && configured) return configured;
  try {
    const value = readSecret(
      path.join(secretRoot, secretName),
      'utf8',
    ).trim();
    if (value) return value;
  } catch {
    // The common failure below avoids exposing secret paths or contents.
  }
  throw new Error('SillyTavern health credentials are unavailable.');
}

export async function runCombinedHealth({
  fetchImpl = globalThis.fetch,
  environment = process.env,
  secretRoot = '/run/secrets',
  readSecret = readFileSync,
} = {}) {
  const username = credential({
    environment,
    environmentName: 'SILLYTAVERN_BASICAUTHUSER_USERNAME',
    secretName: 'st_basic_auth_username',
    secretRoot,
    readSecret,
  });
  const password = credential({
    environment,
    environmentName: 'SILLYTAVERN_BASICAUTHUSER_PASSWORD',
    secretName: 'st_basic_auth_password',
    secretRoot,
    readSecret,
  });
  const authorization = `Basic ${Buffer.from(
    `${username}:${password}`,
  ).toString('base64')}`;

  const [runtime, bridge] = await Promise.all([
    fetchImpl('http://127.0.0.1:18991/health', {
      signal: AbortSignal.timeout(2_000),
    }),
    fetchImpl(
      'http://127.0.0.1:8000/api/plugins/tavern-mnemosyne/v1/capabilities',
      {
      headers: {
        accept: 'application/json',
        authorization,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(2_000),
      },
    ),
  ]);
  if (!runtime.ok || !bridge.ok) {
    throw new Error('The combined cloud profile is unhealthy.');
  }
  const [runtimeBody, bridgeBody] = await Promise.all([
    runtime.json(),
    bridge.json(),
  ]);
  if (
    runtimeBody.status !== 'ok'
    || runtimeBody.storage_status !== 'ready'
    || bridgeBody.schema !== 'mnemosyne.bridge-capabilities.v1'
    || bridgeBody.negotiated_protocol === null
    || bridgeBody.registry_compatible !== true
    || bridgeBody.runtime_instance_id
      !== runtimeBody.runtime_instance_id
    || bridgeBody.storage_status !== 'ready'
    || bridgeBody.upstream_status !== 'configured'
  ) {
    throw new Error(
      'The Mnemosyne runtime and same-origin bridge are not ready.',
    );
  }
  return Object.freeze({
    schema: 'mnemosyne.combined-cloud-health.v1',
    status: 'ready',
  });
}

function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1])
      === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  try {
    await runCombinedHealth();
  } catch {
    process.exitCode = 1;
  }
}
