function assertChatId(chatId) {
  if (typeof chatId !== 'string' || chatId.length === 0) {
    throw new TypeError('Chat Write Coordinator requires a non-empty chat ID.');
  }
}

function assertOperation(operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('Chat Write Coordinator requires an operation.');
  }
}

export function createChatWriteCoordinator() {
  const tails = new Map();

  return Object.freeze({
    async run(chatId, operation) {
      assertChatId(chatId);
      assertOperation(operation);

      const previous = tails.get(chatId) ?? Promise.resolve();
      let release;
      const gate = new Promise(resolve => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      tails.set(chatId, tail);

      await previous;
      try {
        return await operation();
      } finally {
        release();
        if (tails.get(chatId) === tail) {
          tails.delete(chatId);
        }
      }
    },
  });
}
