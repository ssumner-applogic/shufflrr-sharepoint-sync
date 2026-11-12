import { logger } from "./lib/logger";
import { runMetadataCycle } from "./lib/metadata-worker";
import { closeShufflrrSessions } from "./lib/shufflrr";

const once = process.argv.includes("--once");
const validation = process.argv.includes("--first-ten");
if (process.argv.slice(2).some(argument => !["--once", "--first-ten"].includes(argument)) || (validation && !once))
  throw new Error("Use metadata:watch, or metadata:check for the first-ten read-only provider check.");
let stopping = false;
let wake: (() => void) | undefined;
const stop = () => { stopping = true; wake?.(); };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

try {
  logger.info({ event: "metadata_worker_started", once, validation }, "Independent metadata worker started.");
  do {
    try {
      const result = await runMetadataCycle({ force: once, ...(validation ? { limit: 10 } : {}), shouldStop: () => stopping });
      if (once && (result.skipped || !("status" in result) || result.status !== "success")) process.exitCode = 1;
    } catch {
      logger.error({ event: "metadata_worker_cycle_failed" }, "Metadata refresh failed. File sync is not affected.");
      if (once) process.exitCode = 1;
    }
    if (once || stopping) break;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { wake = undefined; resolve(); }, 5000);
      wake = () => { clearTimeout(timer); resolve(); };
    });
  } while (!stopping);
} finally {
  await closeShufflrrSessions();
  const { pool } = await import("@workspace/db");
  await pool.end();
  logger.info({ event: "metadata_worker_stopped" }, "Metadata worker stopped.");
}
