const HASH_PATTERN = /^[a-f0-9]{64}$/;

class CompanionSupervisorError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'CompanionSupervisorError';
    this.reasonCode = reasonCode;
  }
}

function frozenResult(value) {
  return Object.freeze({ ...value });
}

function failureReason(error, fallback) {
  return typeof error?.reasonCode === 'string'
    && error.reasonCode
    ? error.reasonCode
    : fallback;
}

function verifiedTarget(value, expectedProfileHash) {
  if (
    !value
    || value.active_profile_hash !== expectedProfileHash
    || typeof value.runtime_instance_id !== 'string'
    || !value.runtime_instance_id
  ) {
    return null;
  }
  let runtimeUrl;
  try {
    runtimeUrl = new URL(value.runtime_base_url);
  } catch {
    return null;
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
    return null;
  }
  return Object.freeze({
    runtime_base_url: runtimeUrl.href.replace(/\/$/, ''),
    runtime_instance_id: value.runtime_instance_id,
    active_profile_hash: expectedProfileHash,
  });
}

function readyResult(target, reused) {
  return frozenResult({
    status: 'ready',
    active_profile_hash: target.active_profile_hash,
    runtime_instance_id: target.runtime_instance_id,
    reused,
  });
}

function blockedResult({
  activeProfileHash = null,
  reasonCode,
  rolledBack,
}) {
  const result = {
    status: 'blocked',
    active_profile_hash: activeProfileHash,
    reasonCode,
  };
  if (rolledBack !== undefined) {
    result.rolled_back = rolledBack;
  }
  return frozenResult(result);
}

export function createCompanionSupervisor({
  initialTarget = null,
  snapshotConfiguration,
  stageProfile,
  restoreConfiguration,
  stopRuntime,
  startRuntime,
  verifyRuntime,
  isRuntimeBusy,
  onState = () => {},
} = {}) {
  const dependencies = [
    snapshotConfiguration,
    stageProfile,
    restoreConfiguration,
    stopRuntime,
    startRuntime,
    verifyRuntime,
    isRuntimeBusy,
    onState,
  ];
  if (dependencies.some(value => typeof value !== 'function')) {
    throw new TypeError(
      'Companion supervisor dependencies are invalid.',
    );
  }

  let target = initialTarget === null
    ? null
    : verifiedTarget(
      initialTarget,
      initialTarget.active_profile_hash,
    );
  if (initialTarget !== null && target === null) {
    throw new TypeError(
      'Companion supervisor initial target is invalid.',
    );
  }
  let inFlight = null;
  let routingBlocked = false;

  function publish(state) {
    try {
      onState(frozenResult(state));
    } catch {
      // Rendering supervisor state never controls runtime ownership.
    }
  }

  function currentTarget() {
    return routingBlocked ? null : target;
  }

  async function rollback({
    candidate,
    previousTarget,
    snapshot,
    transitionStarted,
  }) {
    try {
      if (transitionStarted) {
        await stopRuntime(candidate);
      }
      if (snapshot !== undefined) {
        await restoreConfiguration(snapshot);
      }
      if (!transitionStarted) {
        target = previousTarget;
        return previousTarget;
      }
      if (previousTarget === null) {
        target = null;
        return null;
      }
      const restarted = await startRuntime();
      const verified = verifiedTarget(
        await verifyRuntime(
          restarted,
          previousTarget.active_profile_hash,
        ),
        previousTarget.active_profile_hash,
      );
      if (verified === null) {
        throw new CompanionSupervisorError(
          'runtime_profile_rollback_mismatch',
          'The prior runtime profile could not be verified.',
        );
      }
      target = verified;
      return verified;
    } catch {
      target = null;
      return undefined;
    }
  }

  function activate(profile) {
    const desiredHash = profile?.profile_hash;
    if (!HASH_PATTERN.test(desiredHash ?? '')) {
      return Promise.resolve(blockedResult({
        reasonCode: 'runtime_profile_invalid',
      }));
    }
    if (target?.active_profile_hash === desiredHash) {
      return Promise.resolve(readyResult(target, true));
    }
    if (inFlight?.profileHash === desiredHash) {
      return inFlight.promise;
    }
    if (inFlight !== null) {
      return Promise.resolve(blockedResult({
        reasonCode: 'runtime_profile_switch_busy',
      }));
    }

    routingBlocked = true;
    const promise = (async () => {
      const previousTarget = target;
      let snapshot;
      let candidate = null;
      let transitionStarted = false;
      try {
        if (await isRuntimeBusy(previousTarget)) {
          routingBlocked = false;
          const result = blockedResult({
            activeProfileHash:
              previousTarget?.active_profile_hash ?? null,
            reasonCode: 'runtime_profile_operation_busy',
          });
          publish(result);
          return result;
        }
        publish({
          status: 'switching',
          active_profile_hash:
            previousTarget?.active_profile_hash ?? null,
          desired_profile_hash: desiredHash,
        });
        snapshot = await snapshotConfiguration();
        await stageProfile(profile);
        transitionStarted = true;
        await stopRuntime(previousTarget);
        target = null;
        candidate = await startRuntime();
        const verified = verifiedTarget(
          await verifyRuntime(candidate, desiredHash),
          desiredHash,
        );
        if (verified === null) {
          const error = new CompanionSupervisorError(
            'runtime_profile_activation_mismatch',
            'The new runtime profile did not verify exactly.',
          );
          throw error;
        }
        target = verified;
        routingBlocked = false;
        const result = readyResult(verified, false);
        publish(result);
        return result;
      } catch (error) {
        const originalReason = failureReason(
          error,
          'runtime_profile_activation_failed',
        );
        const restored = await rollback({
          candidate,
          previousTarget,
          snapshot,
          transitionStarted,
        });
        if (restored === undefined) {
          routingBlocked = false;
          const result = blockedResult({
            reasonCode:
              'runtime_profile_activation_unavailable',
            rolledBack: false,
          });
          publish(result);
          return result;
        }
        routingBlocked = false;
        const result = blockedResult({
          activeProfileHash:
            restored?.active_profile_hash ?? null,
          reasonCode: originalReason,
          rolledBack: true,
        });
        publish(result);
        return result;
      }
    })();
    inFlight = Object.freeze({
      profileHash: desiredHash,
      promise,
    });
    promise.finally(() => {
      if (inFlight?.promise === promise) {
        inFlight = null;
      }
    });
    return promise;
  }

  return Object.freeze({
    activate,
    currentTarget,
  });
}
