import { createApp } from "../../src/app.ts";
import { DAY, FixedClock } from "../../src/clock.ts";
import { getClick, insertClick, openDb } from "../../src/db.ts";
import { parseAppLink } from "../../src/link.ts";
import { DEFAULT_FIRST_OPEN_LIMITS } from "../../src/config.ts";
import type { Logger } from "../../src/logger.ts";

export const START = "2026-03-01T12:00:00.000Z";

export function setup(opts: { windowMs?: number; logger?: Logger } = {}) {
  const db = openDb(":memory:");
  const clock = new FixedClock(START);
  let n = 0;
  const app = createApp({
    db,
    clock,
    config: { windowMs: opts.windowMs ?? 7 * DAY, appLinkBase: "https://conty.app/abrir", firstOpen: DEFAULT_FIRST_OPEN_LIMITS },
    newClickId: () => `clk_test${String(++n).padStart(4, "0")}`,
    logger: opts.logger,
  });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (path: string) => app.request(path);
  /** Grava o clique como o redirecionador faria e devolve a mesma url, para usar em POST /touches. */
  const click = (url: string, clickedAt = clock.now().getTime()) => {
    const link = parseAppLink(url, "https://conty.app/abrir");
    if (!link.ok) throw new Error(`url de teste inválida: ${link.message}`);
    if (getClick(db, link.value.clickId)) return url;
    insertClick(db, { clickId: link.value.clickId, source: link.value.source, params: link.value.params, clickedAt });
    return url;
  };
  return { app, db, clock, post, get, click };
}

export const campaignLink = (cid: string, cmp = "cmp_123") =>
  `https://conty.app/abrir?src=campanha&cmp=${cmp}&ch=instagram&cid=${cid}`;
export const referralLink = (cid: string, ref = "MARIA2026") => `https://conty.app/abrir?src=indicacao&ref=${ref}&cid=${cid}`;
export const communityLink = (cid: string, com = "grupo_ugc") => `https://conty.app/abrir?src=comunidade&com=${com}&cid=${cid}`;
