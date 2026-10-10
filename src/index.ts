import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createLogger, flushOnShutdown } from "./logger.ts";

const logger = createLogger();
const port = Number(process.env.PORT ?? 3000);
const db = openDb(process.env.DB_PATH ?? "origem.db");
const app = createApp({ db, clock: systemClock, config: loadConfig(), logger });

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, `API de atribuição ouvindo em http://localhost:${info.port}`);
});
flushOnShutdown(logger, () => server.close());
