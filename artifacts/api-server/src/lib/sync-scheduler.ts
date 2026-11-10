import { logger } from "./logger";
import { runScheduledSync } from "./sync-runner";

export function syncSchedulerDelay(nextCheckMs: number): number {
  return Math.max(1, Math.min(1000, nextCheckMs));
}

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
      // Check the durable enable flag within one second, even during a long polling interval.
      // These checks touch PostgreSQL only; they do not poll either content provider.
      timer = setTimeout(() => { current = tick(); }, syncSchedulerDelay(nextCheckMs));
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
