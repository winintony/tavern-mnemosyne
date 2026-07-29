function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function intentKey(intent) {
  return JSON.stringify(canonicalValue(intent));
}

export function createSendCoordinator({
  preflight,
  dispatch,
} = {}) {
  if (
    typeof preflight !== 'function'
    || typeof dispatch !== 'function'
  ) {
    throw new TypeError('Send coordinator dependencies are invalid.');
  }

  let inFlight = null;
  let activePermitKey = null;

  function coordinate(intent) {
    const capturedIntent = Object.freeze(
      structuredClone(intent),
    );
    const capturedIntentKey = intentKey(capturedIntent);
    if (inFlight?.intentKey === capturedIntentKey) {
      return inFlight.promise;
    }
    if (inFlight !== null) {
      return Promise.resolve(Object.freeze({
        status: 'blocked',
        reasonCode: 'send_coordinator_busy',
      }));
    }
    const promise = (async () => {
      try {
        let verdict;
        try {
          verdict = await preflight(capturedIntent);
        } catch (error) {
          return Object.freeze({
            status: 'blocked',
            reasonCode:
              error?.reasonCode
              ?? 'generation_preflight_indeterminate',
          });
        }
        if (verdict?.status !== 'allow') {
          return Object.freeze({
            status: 'blocked',
            reasonCode:
              verdict?.reasonCode
              ?? 'generation_preflight_indeterminate',
          });
        }
        activePermitKey = capturedIntentKey;
        try {
          try {
            await dispatch(capturedIntent);
          } catch (error) {
            return Object.freeze({
              status: 'blocked',
              reasonCode:
                error?.reasonCode
                ?? 'generation_dispatch_indeterminate',
            });
          }
        } finally {
          if (activePermitKey === capturedIntentKey) {
            activePermitKey = null;
          }
        }
        return Object.freeze({
          status: 'dispatched',
          reasonCode: null,
        });
      } finally {
        if (inFlight?.promise === promise) {
          inFlight = null;
        }
      }
    })();
    inFlight = Object.freeze({
      intentKey: capturedIntentKey,
      promise,
    });
    return promise;
  }

  function consumePermit(intent) {
    if (
      activePermitKey === null
      || activePermitKey !== intentKey(intent)
    ) {
      return false;
    }
    activePermitKey = null;
    return true;
  }

  return Object.freeze({
    coordinate,
    consumePermit,
  });
}

export function installInteractiveSendAdapter({
  coordinator,
  sendButton,
  textarea,
  captureIntent,
  shouldSendOnEnter,
} = {}) {
  if (
    typeof coordinator?.coordinate !== 'function'
    || typeof sendButton?.addEventListener !== 'function'
    || typeof textarea?.addEventListener !== 'function'
    || typeof captureIntent !== 'function'
    || typeof shouldSendOnEnter !== 'function'
  ) {
    throw new TypeError('Interactive send adapter dependencies are invalid.');
  }

  function onSendButtonClick(event) {
    const intent = captureIntent({ source: 'send-button' });
    if (intent === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void coordinator.coordinate(intent);
  }

  function onTextareaKeydown(event) {
    const isEligibleEnter = (
      event.key === 'Enter'
      && event.isComposing !== true
      && event.shiftKey !== true
      && event.ctrlKey !== true
      && event.altKey !== true
      && shouldSendOnEnter()
    );
    if (!isEligibleEnter) return;
    const intent = captureIntent({ source: 'send-on-enter' });
    if (intent === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void coordinator.coordinate(intent);
  }

  sendButton.addEventListener(
    'click',
    onSendButtonClick,
    { capture: true },
  );
  textarea.addEventListener(
    'keydown',
    onTextareaKeydown,
    { capture: true },
  );

  return Object.freeze({
    dispose() {
      sendButton.removeEventListener(
        'click',
        onSendButtonClick,
        { capture: true },
      );
      textarea.removeEventListener(
        'keydown',
        onTextareaKeydown,
        { capture: true },
      );
    },
  });
}
