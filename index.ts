import { startWorker } from "./src/worker.js";
import logger from "./src/logger.js";

const controller = new AbortController();

const shutdown = (signal: string) => {
  logger.info(`Received ${signal}, shutting down...`);
  controller.abort();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

startWorker(controller.signal).catch((err) => {
  logger.error(`Worker fatal error: ${err}`);
  process.exit(1);
});
