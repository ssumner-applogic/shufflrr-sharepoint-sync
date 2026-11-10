import { logger } from "./lib/logger";
import { runScheduledSync } from "./lib/sync-runner";

let stopping = false;
let timer: NodeJS.Timeout | undefined;
let wakeTimer: (() => void) | undefined;

async function waitUntilNextMinute(waitMs: number): Promise<void> {
  await new Promise<void>(resolve => {
    timer = setTimeout(resolve, waitMs);
    wakeTimer = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
  });
  timer = undefined;
  wakeTimer = undefined;
}

async function runLoop(): Promise<void> {
  logger.info({ event: "sync_worker_started", intervalSeconds: 60 }, "Continuous sync worker started.");
  while (!stopping) {
    const startedAt = Date.now();
    try {
      const result = await runScheduledSync();
      if (!result.skipped) {
        logger.info({
          event: "sync_worker_complete",
          status: result.status,
          ...result.summary,
        }, "Scheduled sync run completed.");
      }
    } catch (error) {
      const code = error instanceof Error ? error.name : "unknown";
      logger.error({ event: "sync_worker_failed", code }, "Scheduled sync run failed.");
    }
    if (!stopping) await waitUntilNextMinute(Math.max(0, 60_000 - (Date.now() - startedAt)));
  }
  logger.info({ event: "sync_worker_stopped" }, "Continuous sync worker stopped.");
}

const loop = runLoop();
const shutdown = (signal: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  logger.info({ event: "sync_worker_shutdown_requested", signal }, "Sync worker shutdown requested.");
  wakeTimer?.();
  void loop.then(async () => {
    try {
      const { pool } = await import("@workspace/db");
      await pool.end();
    } catch {
      logger.warn({ event: "database_cleanup_failed" }, "Database connection cleanup failed during worker shutdown.");
    }
  });
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
