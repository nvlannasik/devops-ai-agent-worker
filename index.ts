import { startWorker } from "./src/worker.js";
import logger from "./src/logger.js";
import { activeTracing } from "./src/tracing/handle.js";

const controller = new AbortController();

const shutdown = (signal: string) => {
  logger.info(`Received ${signal}, shutting down...`);
  controller.abort();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

startWorker(controller.signal)
  // graceful drain finished; flush the spans the preload's SDK still holds (no-op when tracing is off)
  .then(async () => { await activeTracing()?.shutdown(); process.exit(0); })
  .catch((err) => {
    logger.error(`Worker fatal error: ${err}`);
    process.exit(1);
  });
