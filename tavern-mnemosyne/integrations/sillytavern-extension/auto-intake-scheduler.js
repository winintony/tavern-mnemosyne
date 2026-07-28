const COMPLETE_OUTCOMES = new Set([
  'complete',
  'waiting_for_approval',
]);

export function createAutoIntakeScheduler({
  isEnabled,
  run,
}) {
  if (
    typeof isEnabled !== 'function'
    || typeof run !== 'function'
  ) {
    throw new TypeError('Auto intake scheduler dependencies are invalid.');
  }

  let inFlightChatId = null;
  let completedChatId = null;

  async function schedule(chatId, {
    force = false,
  } = {}) {
    if (!isEnabled() || !chatId) {
      return Object.freeze({ status: 'disabled' });
    }
    if (inFlightChatId !== null) {
      return Object.freeze({ status: 'in_flight' });
    }
    if (!force && completedChatId === chatId) {
      return Object.freeze({ status: 'already_complete' });
    }

    inFlightChatId = chatId;
    try {
      const status = await run();
      if (COMPLETE_OUTCOMES.has(status)) {
        completedChatId = chatId;
      }
      return Object.freeze({ status });
    } finally {
      if (inFlightChatId === chatId) {
        inFlightChatId = null;
      }
    }
  }

  function reset(chatId = null) {
    if (chatId === null || completedChatId === chatId) {
      completedChatId = null;
    }
  }

  return Object.freeze({
    schedule,
    reset,
  });
}
