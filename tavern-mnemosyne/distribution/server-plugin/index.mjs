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
import {
  companionExtensionInstalled,
  completePendingCompanionRemoval,
  runCompanionTeardown,
} from '../../src/runtime/companion-teardown.js';
import {
  createCompanionSupervisor,
} from '../../src/runtime/companion-supervisor.js';
import {
  createMainRuntimeConfigurationStore,
} from '../../src/runtime/main-runtime-configuration-store.js';
import {
  createMainRuntimeProfileEndpoint,
} from '../../src/runtime/main-runtime-profile-endpoint.js';

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
let uninstallWatchTimer = null;
let currentRuntimeBaseUrl = null;
const COMPANION_START_TIMEOUT_MS = 30_000;
const UNINSTALL_POLL_MS = 5_000;
const sillyTavernRoot = path.resolve(
  process.env.MNEMOSYNE_SILLYTAVERN_ROOT || process.cwd(),
);

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
  startupError = null;
  if (process.env.MNEMOSYNE_EXTERNAL_RUNTIME === 'true') {
    currentRuntimeBaseUrl = (
      process.env.MNEMOSYNE_RUNTIME_URL
      || 'http://127.0.0.1:18991'
    );
    return currentRuntimeBaseUrl;
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
      currentRuntimeBaseUrl =
        runtimeUrl.href.replace(/\/$/, '');
      resolve(currentRuntimeBaseUrl);
    });
  });
}

async function stopCompanion() {
  currentRuntimeBaseUrl = null;
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

async function runtimeHealth(runtimeBaseUrl, contextAccessToken) {
  if (typeof runtimeBaseUrl !== 'string' || !runtimeBaseUrl) {
    throw new Error('The Mnemosyne runtime target is unavailable.');
  }
  const response = await fetch(`${runtimeBaseUrl}/health`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'x-mnemosyne-session-token': contextAccessToken,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(
      `The Mnemosyne runtime health check failed (${response.status}).`,
    );
  }
  const health = await response.json();
  if (
    health?.schema !== 'mnemosyne.health.v1'
    || health.status !== 'ok'
  ) {
    throw new Error('The Mnemosyne runtime health shape is invalid.');
  }
  return health;
}

async function verifiedRuntimeTarget(
  candidate,
  expectedProfileHash,
  contextAccessToken,
) {
  const health = await runtimeHealth(
    candidate?.runtime_base_url,
    contextAccessToken,
  );
  if (
    health.active_main_runtime_profile_hash
      !== expectedProfileHash
    || typeof health.runtime_instance_id !== 'string'
    || !health.runtime_instance_id
  ) {
    const error = new Error(
      'The Mnemosyne runtime did not activate the requested profile.',
    );
    error.reasonCode = 'runtime_profile_activation_mismatch';
    throw error;
  }
  return Object.freeze({
    runtime_base_url: candidate.runtime_base_url,
    runtime_instance_id: health.runtime_instance_id,
    active_profile_hash: expectedProfileHash,
  });
}

// SillyTavern deletes the extension folder from under us and tells nobody, so
// the plugin watches for that folder to disappear and cascades the removal
// itself. A card uninstall and a manual delete both look the same here.
function watchForExtensionUninstall() {
  if (uninstallWatchTimer) return;
  uninstallWatchTimer = setInterval(() => {
    if (companionExtensionInstalled({ rootDir: sillyTavernRoot })) return;
    clearInterval(uninstallWatchTimer);
    uninstallWatchTimer = null;
    runCompanionTeardown({
      rootDir: sillyTavernRoot,
      stopCompanion: exit,
    }).catch(error => {
      console.error('[Tavern Mnemosyne] Teardown failed.', error);
    });
  }, UNINSTALL_POLL_MS);
  uninstallWatchTimer.unref?.();
}

export async function init(router) {
  // A pending uninstall finishes before anything else starts: the plugin
  // directory could not delete itself while it was running.
  const pending = completePendingCompanionRemoval({
    rootDir: sillyTavernRoot,
  });
  if (pending.removed) {
    console.info('[Tavern Mnemosyne] Companion uninstall completed.');
    return;
  }
  const contextAccessToken = serverHeldControlToken();
  const configurationStore =
    createMainRuntimeConfigurationStore({ configPath });
  router.use(requireSillyTavernBridgeSession);
  let initialTarget = null;
  try {
    const runtimeBaseUrl =
      await startCompanion(contextAccessToken);
    const configuredProfile = configurationStore.readProfile();
    if (configuredProfile) {
      initialTarget = await verifiedRuntimeTarget(
        { runtime_base_url: runtimeBaseUrl },
        configuredProfile.profile_hash,
        contextAccessToken,
      );
    }
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    console.error(
      '[Tavern Mnemosyne] Companion failed to start.',
      error,
    );
  }
  const supervisor = createCompanionSupervisor({
    initialTarget,
    snapshotConfiguration:
      configurationStore.snapshotConfiguration,
    stageProfile: configurationStore.stageProfile,
    restoreConfiguration:
      configurationStore.restoreConfiguration,
    stopRuntime: stopCompanion,
    startRuntime: async () => ({
      runtime_base_url:
        await startCompanion(contextAccessToken),
    }),
    verifyRuntime: (
      candidate,
      expectedProfileHash,
    ) => verifiedRuntimeTarget(
      candidate,
      expectedProfileHash,
      contextAccessToken,
    ),
    isRuntimeBusy: async target => {
      const runtimeBaseUrl =
        target?.runtime_base_url ?? currentRuntimeBaseUrl;
      if (!runtimeBaseUrl) return false;
      try {
        const health = await runtimeHealth(
          runtimeBaseUrl,
          contextAccessToken,
        );
        return (
          !Number.isSafeInteger(
            health.active_operation_count,
          )
          || health.active_operation_count > 0
        );
      } catch {
        return true;
      }
    },
  });
  createMainRuntimeProfileEndpoint({
    supervisor,
  }).register(router);
  const bridge = createMnemosyneSillyTavernBridge({
    resolveRuntimeTarget: supervisor.currentTarget,
    contextAccessToken,
    bridgeVersion: '1',
    enableEvaluationRoutes:
      process.env.MNEMOSYNE_ENABLE_EVALUATION_BRIDGE === 'true',
  });
  bridge.register(router);
  watchForExtensionUninstall();
}

export async function exit() {
  if (uninstallWatchTimer) {
    clearInterval(uninstallWatchTimer);
    uninstallWatchTimer = null;
  }
  await stopCompanion();
}
