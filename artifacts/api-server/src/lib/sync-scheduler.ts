import { logger } from "./logger";
import { runScheduledSync } from "./sync-runner";

/** Database due-times are authoritative; this loop only checks when work is due. */
export function startSyncScheduler() {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();
  const tick = async () => {
    let nextCheckMs = 5000;
    try {
      const result = await runScheduledSync();
      nextCheckMs = result.nextCheckMs ?? 1000;
      if (!result.skipped) logger.info({
        event: "sync_worker_complete", status: result.status, ...result.summary,
      }, "Scheduled sync run completed.");
    } catch {
      // The runner records a safe reason, phase, reference ID, and durable next-run time.
      logger.warn({ event: "sync_worker_failed" }, "Scheduled sync run did not complete.");
    }
    if (!stopped) {
      timer = setTimeout(() => { current = tick(); }, Math.max(1, nextCheckMs));
      // This scheduler also runs inside the Preview HTTP server.
      if (process.env.NODE_ENV === "development") timer.unref();
    }
  };
  current = tick();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
