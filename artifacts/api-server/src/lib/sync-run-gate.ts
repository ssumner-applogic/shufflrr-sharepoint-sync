/** A second in-process caller must not start a second job or inherit its result. */
export function createSyncRunGate<T>(execute: () => Promise<T>, busyResult: () => T) {
  let running = false;
  return async (): Promise<T> => {
    if (running) return busyResult();
    running = true;
    try {
      return await execute();
    } finally {
      running = false;
    }
  };
}
