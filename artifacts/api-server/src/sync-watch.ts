import { logger } from "./lib/logger";
import { startSyncScheduler } from "./lib/sync-scheduler";

logger.info({ event: "sync_worker_started" }, "Continuous sync worker started.");
const scheduler = startSyncScheduler();
let stopping = false;
async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  logger.info({ event: "sync_worker_shutdown_requested", signal }, "Sync worker shutdown requested.");
  const timeout = setTimeout(() => process.exit(1), 30_000);
  timeout.unref();
  await scheduler.stop();
  const { pool } = await import("@workspace/db");
  await pool.end();
  clearTimeout(timeout);
  logger.info({ event: "sync_worker_stopped" }, "Continuous sync worker stopped.");
}
process.once("SIGTERM", signal => { void shutdown(signal); });
process.once("SIGINT", signal => { void shutdown(signal); });
