import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createMnemosyneSillyTavernBridge,
} from '../../src/control/sillytavern-bridge.js';
import {
  requireSillyTavernBridgeSession,
} from '../../src/control/sillytavern-bridge-auth.js';

export const info = Object.freeze({
  id: 'tavern-mnemosyne',
  name: 'Tavern Mnemosyne Companion',
  description: 'Runs the local-first governed story-memory Companion.',
});

const companionRoot = path.resolve(
  process.env.MNEMOSYNE_CODE_ROOT
  || path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  ),
);
const stateRoot = path.resolve(
  process.env.MNEMOSYNE_STATE_ROOT
  || path.join(process.cwd(), 'data', '_mnemosyne'),
);
const runtimeRoot = path.resolve(
  process.env.MNEMOSYNE_RUNTIME_ROOT
  || companionRoot,
);
const launcherPath = path.join(
  runtimeRoot,
  ...(runtimeRoot === companionRoot ? ['distribution'] : []),
  'companion-launcher.mjs',
);
const configPath = path.join(
  stateRoot,
  'config',
  'runtime.json',
);
const secretsRoot = path.join(stateRoot, 'secrets');
const controlTokenPath = path.join(secretsRoot, 'control-token');

let companionProcess = null;
let lastExit = null;
let startupError = null;

function serverHeldControlToken() {
  const configured = process.env.MNEMOSYNE_CONTEXT_ACCESS_TOKEN;
  if (configured) return configured;
  mkdirSync(secretsRoot, { recursive: true, mode: 0o700 });
  if (existsSync(controlTokenPath)) {
    const existing = readFileSync(controlTokenPath, 'utf8').trim();
    if (existing) return existing;
    throw new Error('The Mnemosyne control-token file is empty.');
  }
  const generated = randomBytes(32).toString('base64url');
  writeFileSync(controlTokenPath, `${generated}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return generated;
}

async function startCompanion(contextAccessToken) {
  if (process.env.MNEMOSYNE_EXTERNAL_RUNTIME === 'true') {
    return;
  }
  if (!existsSync(launcherPath)) {
    throw new Error(
      'The sealed Mnemosyne runtime bundle is unavailable.',
    );
  }

  companionProcess = spawn(process.execPath, [launcherPath], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      MNEMOSYNE_CONTEXT_ACCESS_TOKEN: contextAccessToken,
      MNEMOSYNE_STATE_ROOT: stateRoot,
      MNEMOSYNE_CONFIG_PATH: configPath,
    },
    stdio: 'inherit',
    shell: false,
  });
  companionProcess.once('error', error => {
    startupError = error.message;
    companionProcess = null;
  });
  companionProcess.once('exit', (code, signal) => {
    lastExit = { code, signal };
    companionProcess = null;
  });
}

export async function init(router) {
  const contextAccessToken = serverHeldControlToken();
  router.use(requireSillyTavernBridgeSession);
  const bridge = createMnemosyneSillyTavernBridge({
    runtimeBaseUrl:
      process.env.MNEMOSYNE_RUNTIME_URL
      || 'http://127.0.0.1:18991',
    contextAccessToken,
    bridgeVersion: '1',
    enableEvaluationRoutes:
      process.env.MNEMOSYNE_ENABLE_EVALUATION_BRIDGE === 'true',
  });
  bridge.register(router);

  try {
    await startCompanion(contextAccessToken);
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    console.error(
      '[Tavern Mnemosyne] Companion failed to start.',
      error,
    );
  }
}

export async function exit() {
  if (!companionProcess) return;
  const child = companionProcess;
  companionProcess = null;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
