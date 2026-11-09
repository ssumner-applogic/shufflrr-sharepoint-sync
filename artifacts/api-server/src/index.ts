import app from "./app";
import { logger } from "./lib/logger";
import { closeShufflrrSessions } from "./lib/shufflrr";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "Server listening");
});

const shutdown = (signal: NodeJS.Signals) => {
  logger.info({ signal }, "Server shutdown requested");
  const timeout = setTimeout(() => {
    logger.error({ signal }, "Graceful shutdown timed out");
    server.closeAllConnections();
    process.exit(1);
  }, 10_000);
  timeout.unref();

  server.close(async error => {
    try { await closeShufflrrSessions(); }
    catch { logger.warn({ event: "shufflrr_session_cleanup_failed" }, "Connection cleanup failed during shutdown."); }
    clearTimeout(timeout);
    if (error) {
      logger.error({ err: error, signal }, "Error during shutdown");
      process.exitCode = 1;
      return;
    }
    logger.info({ signal }, "Server stopped");
  });
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
