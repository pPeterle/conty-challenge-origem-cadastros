import { createApp } from "../../src/app.ts";
import { DAY, FixedClock } from "../../src/clock.ts";
import { openDb } from "../../src/db.ts";
import { DEFAULT_FIRST_OPEN_LIMITS } from "../../src/config.ts";

export const START = "2026-03-01T12:00:00.000Z";

export function setup(opts: { windowMs?: number } = {}) {
  const db = openDb(":memory:");
  const clock = new FixedClock(START);
  let n = 0;
  const app = createApp({
    db,
    clock,
    config: { windowMs: opts.windowMs ?? 7 * DAY, appLinkBase: "https://conty.app/abrir", firstOpen: DEFAULT_FIRST_OPEN_LIMITS },
    newClickId: () => `clk_test${String(++n).padStart(4, "0")}`,
  });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (path: string) => app.request(path);
  return { app, db, clock, post, get };
}

export const campaignLink = (cid: string, cmp = "cmp_123") =>
  `https://conty.app/abrir?src=campanha&cmp=${cmp}&ch=instagram&cid=${cid}`;
export const referralLink = (cid: string, ref = "MARIA2026") => `https://conty.app/abrir?src=indicacao&ref=${ref}&cid=${cid}`;
export const communityLink = (cid: string, com = "grupo_ugc") => `https://conty.app/abrir?src=comunidade&com=${com}&cid=${cid}`;
