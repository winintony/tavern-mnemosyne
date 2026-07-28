function normalizedResult(outcome) {
  const status = outcome?.status ?? outcome;
  if (status === 'complete') {
    return Object.freeze({ status: 'ready', reasonCode: null });
  }
  if (status === 'waiting_for_approval') {
    return Object.freeze({
      status: 'blocked',
      reasonCode: 'static_lore_reconcile_approval_required',
    });
  }
  if (status === 'retryable') {
    return Object.freeze({
      status: 'blocked',
      reasonCode:
        outcome?.reasonCode
        ?? 'static_lore_initialization_incomplete',
    });
  }
  return Object.freeze({
    status: 'blocked',
    reasonCode: 'static_lore_initialization_busy',
  });
}

export function createChatSaveInitializationGate({
  isEnabled,
  initialize,
}) {
  if (
    typeof isEnabled !== 'function'
    || typeof initialize !== 'function'
  ) {
    throw new TypeError(
      'Chat-save initialization gate dependencies are invalid.',
    );
  }

  let inFlight = null;

  function ensureForSend(chatId) {
    if (!isEnabled()) {
      return Promise.resolve(Object.freeze({
        status: 'disabled',
        reasonCode: null,
      }));
    }
    if (!chatId) {
      return Promise.resolve(Object.freeze({
        status: 'blocked',
        reasonCode: 'chat_id_missing',
      }));
    }
    if (inFlight !== null) {
      if (inFlight.chatId === chatId) return inFlight.promise;
      return Promise.resolve(Object.freeze({
        status: 'blocked',
        reasonCode: 'static_lore_initialization_busy',
      }));
    }

    const promise = (async () => {
      try {
        return normalizedResult(await initialize(chatId));
      } catch (error) {
        return Object.freeze({
          status: 'blocked',
          reasonCode:
            error?.reasonCode
            ?? 'static_lore_initialization_incomplete',
        });
      } finally {
        if (inFlight?.chatId === chatId) {
          inFlight = null;
        }
      }
    })();
    inFlight = Object.freeze({ chatId, promise });
    return promise;
  }

  return Object.freeze({
    ensureForSend,
  });
}
