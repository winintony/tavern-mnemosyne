import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { runCloudPreflight } from './preflight.mjs';

const APP_ROOT = '/home/node/app';
const MNEMOSYNE_ROOT = '/opt/tavern-mnemosyne/tavern-mnemosyne';
const processes = new Map();
let shuttingDown = false;

function loadSecret(environmentName, fileName) {
  if (process.env[environmentName]) return;
  const value = readFileSync(`/run/secrets/${fileName}`, 'utf8').trim();
  if (!value) throw new Error(`${fileName} secret is empty.`);
  process.env[environmentName] = value;
}

function spawnManaged(name, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  processes.set(name, child);
  child.once('error', error => {
    process.stderr.write(`[Mnemosyne supervisor] ${name}: ${error.message}\n`);
    void stopAll(1);
  });
  child.once('exit', (code, signal) => {
    processes.delete(name);
    if (!shuttingDown) {
      process.stderr.write(
        `[Mnemosyne supervisor] ${name} exited (${code ?? signal}).\n`,
      );
      void stopAll(code === 0 ? 1 : (code ?? 1));
    }
  });
  return child;
}

async function waitForRuntime() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:18991/health', {
        signal: AbortSignal.timeout(1_000),
      });
      const body = await response.json();
      if (
        response.ok
        && body.status === 'ok'
        && body.storage_status === 'ready'
      ) {
        return;
      }
    } catch {
      // The bounded startup loop is the readiness ordering contract.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Mnemosyne runtime did not become ready.');
}

async function stopAll(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes.values()) child.kill('SIGTERM');
  const deadline = setTimeout(() => {
    for (const child of processes.values()) child.kill('SIGKILL');
  }, 5_000);
  deadline.unref();
  await Promise.all([...processes.values()].map(child => (
    new Promise(resolve => child.once('exit', resolve))
  )));
  clearTimeout(deadline);
  process.exit(exitCode);
}

loadSecret(
  'MNEMOSYNE_CONTEXT_ACCESS_TOKEN',
  'mnemosyne_context_token',
);
loadSecret(
  'SILLYTAVERN_BASICAUTHUSER_USERNAME',
  'st_basic_auth_username',
);
loadSecret(
  'SILLYTAVERN_BASICAUTHUSER_PASSWORD',
  'st_basic_auth_password',
);
process.env.MNEMOSYNE_UPSTREAM_AUTH_MODE ||= 'passthrough';
process.env.MNEMOSYNE_CONTEXT_MODE ||= 'production';
process.env.MNEMOSYNE_HOST ||= '127.0.0.1';
process.env.MNEMOSYNE_PORT ||= '18991';
process.env.MNEMOSYNE_CHAT_SAVE_ROOT ||=
  `${process.env.MNEMOSYNE_STATE_ROOT}/chat-saves`;
process.env.MNEMOSYNE_EXTERNAL_RUNTIME = 'true';

runCloudPreflight();
spawnManaged(
  'runtime',
  process.execPath,
  [`${MNEMOSYNE_ROOT}/distribution/companion-launcher.mjs`],
  {
    cwd: MNEMOSYNE_ROOT,
    env: process.env,
  },
);
await waitForRuntime();
spawnManaged(
  'sillytavern',
  `${APP_ROOT}/docker-entrypoint.sh`,
  [],
  {
    cwd: APP_ROOT,
    env: process.env,
  },
);

process.once('SIGINT', () => { void stopAll(0); });
process.once('SIGTERM', () => { void stopAll(0); });
