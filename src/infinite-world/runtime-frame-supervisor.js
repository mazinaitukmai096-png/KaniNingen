function normalizeFault(error) {
  return Object.freeze({
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
  });
}

export function createRuntimeFrameSupervisor({
  requestAnimationFrame,
  cancelAnimationFrame = () => {},
  onFrame,
  onFault,
} = {}) {
  if (typeof requestAnimationFrame !== 'function') {
    throw new TypeError('requestAnimationFrame is required');
  }
  if (typeof cancelAnimationFrame !== 'function') {
    throw new TypeError('cancelAnimationFrame must be a function');
  }
  if (typeof onFrame !== 'function' || typeof onFault !== 'function') {
    throw new TypeError('onFrame and onFault are required');
  }

  let running = false;
  let faulted = false;
  let pendingFrameId = null;
  let dispatchCount = 0;
  let completedFrameCount = 0;
  let fault = null;
  let faultHandlerError = null;

  const schedule = () => {
    if (!running || pendingFrameId !== null) return;
    pendingFrameId = requestAnimationFrame(dispatch);
  };

  function dispatch(now) {
    pendingFrameId = null;
    if (!running) return;
    dispatchCount += 1;
    try {
      if (!faulted) {
        onFrame(now);
        completedFrameCount += 1;
      }
    } catch (error) {
      faulted = true;
      fault = normalizeFault(error);
      try {
        onFault(error);
      } catch (handlerError) {
        faultHandlerError = normalizeFault(handlerError);
      }
    } finally {
      schedule();
    }
  }

  return Object.freeze({
    start() {
      if (running) return false;
      running = true;
      schedule();
      return true;
    },
    stop() {
      if (!running) return false;
      running = false;
      if (pendingFrameId !== null) cancelAnimationFrame(pendingFrameId);
      pendingFrameId = null;
      return true;
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: 'runtime-frame-supervisor-1',
        running,
        faulted,
        pending: pendingFrameId !== null,
        dispatchCount,
        completedFrameCount,
        fault,
        faultHandlerError,
      });
    },
  });
}
