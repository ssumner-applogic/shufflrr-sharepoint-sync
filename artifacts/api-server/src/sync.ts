import { logger } from "./lib/logger";
import { runScheduledSync } from "./lib/sync-runner";

try {
  const result = await runScheduledSync();
  if (result.skipped) {
    logger.info({ event: "sync_worker_skipped" }, "No enabled sync configuration was found or another worker holds the lock.");
  } else {
    logger.info({
      event: "sync_worker_complete",
      status: result.status,
      ...result.summary,
    }, "Scheduled sync run completed.");
  }
} catch (error) {
  const code = error instanceof Error ? error.name : "unknown";
  logger.error({ event: "sync_worker_failed", code }, "Scheduled sync run failed.");
  process.exitCode = 1;
} finally {
  const { pool } = await import("@workspace/db").catch(() => ({ pool: undefined }));
  await pool?.end().catch(() => {});
}
