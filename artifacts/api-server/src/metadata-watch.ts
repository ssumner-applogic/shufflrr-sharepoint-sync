import { logger as baseLogger } from "./lib/logger";
import { runMetadataCycle } from "./lib/metadata-worker";
import { closeShufflrrSessions } from "./lib/shufflrr";
import { metadataIntervalSeconds } from "./lib/metadata-policy";

const logger = baseLogger.child({ service: "metadata-worker", environment: process.env.NODE_ENV ?? "unspecified" });
const required = ["DATABASE_URL", "MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET",
  "SHUFFLRR_API_BASE_URL", "SHUFFLRR_API_EMAIL", "SHUFFLRR_API_PASSWORD"] as const;
const missing = required.filter(key => !process.env[key]?.trim());
if (missing.length) {
  logger.error({ event: "metadata_configuration_missing", missing }, "Metadata worker configuration is incomplete.");
  throw new Error("Required metadata worker configuration is missing.");
}
metadataIntervalSeconds();
logger.info({ event: "metadata_configuration_validated", configuredKeys: required }, "Metadata worker configuration validated.");

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
