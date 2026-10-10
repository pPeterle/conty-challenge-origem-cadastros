import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";

const port = Number(process.env.PORT ?? 3000);
const db = openDb(process.env.DB_PATH ?? "origem.db");
const app = createApp({ db, clock: systemClock, config: loadConfig() });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API de atribuição ouvindo em http://localhost:${info.port}`);
});
