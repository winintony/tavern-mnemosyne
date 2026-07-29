export function createRuntimeOperationTracker() {
  let activeOperationCount = 0;

  function begin(response) {
    if (typeof response?.once !== 'function') {
      throw new TypeError(
        'Runtime operation tracking requires a response emitter.',
      );
    }
    activeOperationCount += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeOperationCount -= 1;
      response.off?.('finish', release);
      response.off?.('close', release);
    };
    response.once('finish', release);
    response.once('close', release);
    return release;
  }

  function snapshot() {
    return Object.freeze({
      active_operation_count: activeOperationCount,
      busy: activeOperationCount > 0,
    });
  }

  return Object.freeze({
    begin,
    snapshot,
  });
}
