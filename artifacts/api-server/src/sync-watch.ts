import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { logger as baseLogger } from "./lib/logger";
import { WorkerSupervisor } from "./lib/worker-supervisor";

const logger = baseLogger.child({ service: "worker-supervisor", environment: process.env.NODE_ENV ?? "unspecified" });

// Preserve Railway's existing sync-watch.mjs start command. The supervisor has
// no database/provider clients; each child owns and closes its own resources.
const workers = [
  { name: "file-sync-worker", args: ["--enable-source-maps", fileURLToPath(new URL("./file-sync-watch.mjs", import.meta.url))] },
  { name: "metadata-worker", args: ["--enable-source-maps", fileURLToPath(new URL("./metadata-watch.mjs", import.meta.url))] },
];

try {
  if (process.argv.length > 2) throw new Error("The worker supervisor does not accept arguments.");
  // Missing build outputs are a release error, not a reason to silently omit a worker.
  await Promise.all(workers.map(worker => access(worker.args[1]!)));
  const supervisor = new WorkerSupervisor({ workers, logger });
  const stop = (signal: NodeJS.Signals) => { void supervisor.stop(signal); };
  const fail = () => {
    process.exitCode = 1;
    logger.error({ event: "worker_supervisor_failed" }, "Worker supervisor failed; stopping child processes.");
    void supervisor.stop();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.once("uncaughtException", fail);
  process.once("unhandledRejection", fail);
  logger.info({ event: "worker_supervisor_started", workers: workers.map(worker => worker.name) }, "Starting supervised file and metadata workers.");
  supervisor.start();
  const result = await supervisor.done;
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  process.removeListener("uncaughtException", fail);
  process.removeListener("unhandledRejection", fail);
  if (result.forced) process.exitCode = 1;
  logger.info({ event: "worker_supervisor_stopped", forced: result.forced }, "Both worker processes stopped.");
} catch {
  logger.error({ event: "worker_supervisor_start_failed" }, "Worker supervisor could not start. Build both worker entry points before starting this service.");
  process.exitCode = 1;
}
