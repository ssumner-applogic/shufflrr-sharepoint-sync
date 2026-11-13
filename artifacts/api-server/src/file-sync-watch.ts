import { logger as baseLogger } from "./lib/logger";
import { startSyncScheduler } from "./lib/sync-scheduler";

const logger = baseLogger.child({ service: "file-sync-worker", environment: process.env.NODE_ENV ?? "unspecified" });
logger.info({ event: "sync_worker_started" }, "Continuous sync worker started.");
const scheduler = startSyncScheduler();
let stopping = false;
async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  logger.info({ event: "sync_worker_shutdown_requested", signal }, "Sync worker shutdown requested.");
  const timeout = setTimeout(() => process.exit(1), 30_000);
  timeout.unref();
  try {
    await scheduler.stop();
    const { closeShufflrrSessions } = await import("./lib/shufflrr");
    await closeShufflrrSessions();
    const { pool } = await import("@workspace/db");
    await pool.end();
    logger.info({ event: "sync_worker_stopped" }, "Continuous sync worker stopped.");
  } catch {
    logger.error({ event: "sync_worker_shutdown_failed" }, "File worker shutdown did not complete cleanly.");
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}
process.once("SIGTERM", signal => { void shutdown(signal); });
process.once("SIGINT", signal => { void shutdown(signal); });
