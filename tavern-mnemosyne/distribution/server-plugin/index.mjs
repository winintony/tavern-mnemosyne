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
const COMPANION_START_TIMEOUT_MS = 30_000;

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
    return (
      process.env.MNEMOSYNE_RUNTIME_URL
      || 'http://127.0.0.1:18991'
    );
  }
  if (!existsSync(launcherPath)) {
    throw new Error(
      'The sealed Mnemosyne runtime bundle is unavailable.',
    );
  }

  const child = spawn(process.execPath, [launcherPath], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      MNEMOSYNE_CONTEXT_ACCESS_TOKEN: contextAccessToken,
      MNEMOSYNE_STATE_ROOT: stateRoot,
      MNEMOSYNE_CONFIG_PATH: configPath,
      MNEMOSYNE_PORT: '0',
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    shell: false,
  });
  companionProcess = child;
  child.once('error', error => {
    startupError = error.message;
    companionProcess = null;
  });
  child.once('exit', (code, signal) => {
    lastExit = { code, signal };
    companionProcess = null;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('The Mnemosyne runtime did not become ready in time.'));
    }, COMPANION_START_TIMEOUT_MS);
    timer.unref?.();
    const settleError = error => {
      clearTimeout(timer);
      reject(error);
    };
    child.once('error', settleError);
    child.once('exit', (code, signal) => settleError(new Error(
      `The Mnemosyne runtime exited before ready (${code ?? signal}).`,
    )));
    child.on('message', message => {
      if (message?.schema !== 'mnemosyne.runtime-ready.v1') return;
      let runtimeUrl;
      try {
        runtimeUrl = new URL(message.url);
      } catch {
        settleError(new Error(
          'The Mnemosyne runtime reported an invalid address.',
        ));
        return;
      }
      if (
        runtimeUrl.protocol !== 'http:'
        || runtimeUrl.hostname !== '127.0.0.1'
        || !runtimeUrl.port
        || runtimeUrl.username
        || runtimeUrl.password
        || runtimeUrl.pathname !== '/'
        || runtimeUrl.search
        || runtimeUrl.hash
      ) {
        settleError(new Error(
          'The Mnemosyne runtime reported an unsafe address.',
        ));
        return;
      }
      clearTimeout(timer);
      resolve(runtimeUrl.href.replace(/\/$/, ''));
    });
  });
}

export async function init(router) {
  const contextAccessToken = serverHeldControlToken();
  router.use(requireSillyTavernBridgeSession);
  let runtimeBaseUrl =
    process.env.MNEMOSYNE_RUNTIME_URL
    || 'http://127.0.0.1:0';
  try {
    runtimeBaseUrl = await startCompanion(contextAccessToken);
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    console.error(
      '[Tavern Mnemosyne] Companion failed to start.',
      error,
    );
  }
  const bridge = createMnemosyneSillyTavernBridge({
    runtimeBaseUrl,
    contextAccessToken,
    bridgeVersion: '1',
    enableEvaluationRoutes:
      process.env.MNEMOSYNE_ENABLE_EVALUATION_BRIDGE === 'true',
  });
  bridge.register(router);
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
