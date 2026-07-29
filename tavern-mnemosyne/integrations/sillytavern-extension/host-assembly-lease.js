import { censusMark } from './gate-census.js';

function invalidLease(message) {
  const error = new Error(message);
  error.reasonCode = 'host_prompt_budget_invalid';
  return error;
}

function assertPromptManager(promptManager) {
  if (
    !promptManager
    || typeof promptManager !== 'object'
    || !promptManager.serviceSettings
    || typeof promptManager.serviceSettings !== 'object'
    || Array.isArray(promptManager.serviceSettings)
  ) {
    throw invalidLease(
      'Host assembly leases require PromptManager service settings.',
    );
  }
}

function assertFrameId(frameId) {
  if (typeof frameId !== 'string' || !frameId.trim()) {
    throw invalidLease('Host assembly frame id is invalid.');
  }
}

function assertContextTokens(contextTokens) {
  if (!Number.isSafeInteger(contextTokens) || contextTokens <= 0) {
    throw invalidLease('Host assembly context budget is invalid.');
  }
}

function settingsConflict(frame) {
  censusMark('HOST_ASSEMBLY_PROVENANCE', 'blocked', {
    reasonCode: 'host_prompt_budget_service_settings_changed',
    runId: null,
  });
  return {
    status: 'conflict',
    frame_id: frame.frame_id,
    reason_code: 'host_prompt_budget_service_settings_changed',
  };
}

const CRITICAL_SERVICE_SETTING_KEYS = Object.freeze([
  'openai_max_context',
  'openai_max_tokens',
]);

function shallowOwnKeys(value) {
  return Reflect.ownKeys(value);
}

function captureShallowSettings(value) {
  const keys = shallowOwnKeys(value);
  for (const key of CRITICAL_SERVICE_SETTING_KEYS) {
    if (!keys.includes(key)) keys.push(key);
  }
  const overlayBase = { ...value };
  for (const key of CRITICAL_SERVICE_SETTING_KEYS) {
    overlayBase[key] = value[key];
  }
  return {
    keys: Object.freeze([...keys]),
    values: new Map(keys.map(key => [key, value[key]])),
    overlayBase: Object.freeze(overlayBase),
  };
}

function matchesShallowSettings(value, snapshot) {
  const keys = shallowOwnKeys(value);
  for (const key of CRITICAL_SERVICE_SETTING_KEYS) {
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length !== snapshot.keys.length) return false;
  return keys.every(
    key =>
      snapshot.values.has(key)
      && Object.is(value[key], snapshot.values.get(key)),
  );
}

function inspectActiveSettings(active, promptManager) {
  const expectedSettings = active.overlay ?? active.original;
  if (promptManager.serviceSettings !== expectedSettings) {
    return 'foreign_current_settings';
  }
  if (
    active.overlay !== null
    && !matchesShallowSettings(
      active.overlay,
      active.overlaySnapshot,
    )
  ) {
    return 'overlay_changed';
  }
  if (!matchesShallowSettings(
    active.original,
    active.originalSnapshot,
  )) {
    return 'original_changed';
  }
  return 'owned';
}

/**
 * Owns the short-lived PromptManager budget overlay for one generation frame.
 *
 * Callers must settle the returned frame on both success and failure. A stale
 * result means the callback no longer owns runtime state and must stop without
 * mutating it. A conflict result means serviceSettings or either lease-owned
 * settings object changed; the caller must fail closed. Settlement restores a
 * clean owned overlay to the original object, but never erases a conflicting
 * current object or an in-place change to the original object.
 */
export function createHostAssemblyLeaseManager({ promptManager } = {}) {
  assertPromptManager(promptManager);
  let active = null;

  return Object.freeze({
    beginFrame(frameId) {
      assertFrameId(frameId);
      if (active !== null) {
        throw invalidLease('A host assembly frame is already active.');
      }
      const original = promptManager.serviceSettings;
      assertContextTokens(original.openai_max_context);
      const originalSnapshot = captureShallowSettings(original);
      const frame = Object.freeze({
        schema: 'mnemosyne.host-assembly-frame.v1',
        frame_id: frameId,
      });
      active = {
        frame,
        original,
        originalSnapshot,
        overlay: null,
        overlaySnapshot: null,
      };
      return frame;
    },

    inspectFrame(frame) {
      if (active?.frame !== frame) {
        return { status: 'stale' };
      }
      if (inspectActiveSettings(active, promptManager) !== 'owned') {
        return settingsConflict(frame);
      }
      return {
        status: 'owned',
        frame_id: frame.frame_id,
      };
    },

    installOverlay(frame, hostContextTokens) {
      if (active?.frame !== frame) {
        return { status: 'stale' };
      }
      if (inspectActiveSettings(active, promptManager) !== 'owned') {
        return settingsConflict(frame);
      }
      assertContextTokens(hostContextTokens);
      const configuredContextTokens =
        active.originalSnapshot.values.get('openai_max_context');
      if (hostContextTokens < configuredContextTokens) {
        throw invalidLease(
          'Host assembly context cannot shrink the configured context.',
        );
      }
      const overlay = {
        ...active.originalSnapshot.overlayBase,
        openai_max_context: hostContextTokens,
      };
      promptManager.serviceSettings = overlay;
      active.overlay = overlay;
      active.overlaySnapshot = captureShallowSettings(overlay);
      return {
        status: 'installed',
        frame_id: frame.frame_id,
        configured_context_tokens: configuredContextTokens,
        host_context_tokens: hostContextTokens,
      };
    },

    settleFrame(frame) {
      if (active?.frame !== frame) {
        return { status: 'stale' };
      }
      const ownership = inspectActiveSettings(active, promptManager);
      if (
        ownership === 'foreign_current_settings'
        || ownership === 'overlay_changed'
      ) {
        active = null;
        return settingsConflict(frame);
      }
      if (ownership === 'original_changed') {
        promptManager.serviceSettings = active.original;
        active = null;
        return settingsConflict(frame);
      }
      promptManager.serviceSettings = active.original;
      active = null;
      return {
        status: 'restored',
        frame_id: frame.frame_id,
      };
    },
  });
}
