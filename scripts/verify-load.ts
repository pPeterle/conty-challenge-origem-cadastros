// Confere as invariantes no banco depois da carga. Sai com 1 se alguma quebrou.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decideAttribution } from "../src/attribution.ts";
import type { Source } from "../src/link.ts";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("uso: verify-load.ts <arquivo.db>");
const cfg = JSON.parse(readFileSync(new URL("../load/scenario.json", import.meta.url), "utf8")) as { installs: number };
const db = new DatabaseSync(dbPath, { readOnly: true });
const errors: string[] = [];
const count = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const pad = (i: number) => String(i).padStart(6, "0");

const clicksPerClass = [0, 1, 2, 2];
let expectedTouches = 0;
for (let i = 0; i < cfg.installs; i++) expectedTouches += clicksPerClass[i % 4]!;

const touches = count("SELECT COUNT(*) AS n FROM touches");
const distinctClicks = count("SELECT COUNT(DISTINCT click_id) AS n FROM touches");
if (touches !== expectedTouches) errors.push(`toques: esperado ${expectedTouches}, banco tem ${touches}`);
if (distinctClicks !== touches) errors.push(`click_id repetido: ${touches} toques para ${distinctClicks} cliques`);

const installs = count("SELECT COUNT(*) AS n FROM installs");
if (installs !== cfg.installs) errors.push(`installs: esperado ${cfg.installs}, banco tem ${installs} (payload inválido gravou algo?)`);

const signups = count("SELECT COUNT(*) AS n FROM signups");
if (signups !== cfg.installs) errors.push(`cadastros: esperado ${cfg.installs}, banco tem ${signups}`);
const winners = count("SELECT COUNT(*) AS n FROM signups WHERE winning_touch_id IS NOT NULL");
const distinctWinners = count("SELECT COUNT(DISTINCT winning_touch_id) AS n FROM signups");
if (winners !== distinctWinners) errors.push("o mesmo toque virou origem de mais de um cadastro");

const expected = (i: number): { origin: string; click: string | null } => {
  switch (i % 4) {
    case 0: return { origin: "organico", click: null };
    case 1: return { origin: "campanha", click: `clk_${pad(i)}_a` };
    case 2: return { origin: "campanha", click: `clk_${pad(i)}_b` };
    default: return { origin: "indicacao", click: `clk_${pad(i)}_a` };
  }
};

const signupStmt = db.prepare(
  `SELECT s.*, t.click_id AS winning_click FROM signups s LEFT JOIN touches t ON t.id = s.winning_touch_id WHERE s.user_id = ?`,
);
const snapshotStmt = db.prepare(
  `SELECT t.id, t.click_id, t.source, t.touched_at, st.result, st.reason
     FROM signup_touches st JOIN touches t ON t.id = st.touch_id WHERE st.user_id = ? ORDER BY t.id`,
);
let recomputed = 0;
for (let i = 0; i < cfg.installs; i++) {
  const user = `u_${pad(i)}`;
  const s = signupStmt.get(user) as
    | { origin: string; reason: string; winning_click: string | null; signup_at: number; first_open_at: number; window_ms: number }
    | undefined;
  if (!s) { errors.push(`${user}: sem cadastro`); continue; }
  const exp = expected(i);
  if (s.origin !== exp.origin || s.winning_click !== exp.click) {
    errors.push(`${user}: origem ${s.origin}/${s.winning_click}, esperado ${exp.origin}/${exp.click}`);
  }
  // A auditoria gravada precisa ser reproduzível pela função pura.
  const snap = snapshotStmt.all(user) as { id: number; click_id: string; source: Source; touched_at: number; result: string; reason: string }[];
  const d = decideAttribution({
    firstOpenAt: s.first_open_at,
    signupAt: s.signup_at,
    windowMs: s.window_ms,
    touches: snap.map((t) => ({ id: t.id, clickId: t.click_id, source: t.source, touchedAt: t.touched_at })),
  });
  const same = d.origin === s.origin && d.reason === s.reason &&
    d.verdicts.every((v, k) => v.result === snap[k]!.result && v.reason === snap[k]!.reason);
  if (!same) errors.push(`${user}: auditoria gravada não bate com a regra`);
  else recomputed++;
  if (i % 4 === 3) {
    const late = count(
      `SELECT COUNT(*) AS n FROM touches t WHERE t.click_id = ? AND NOT EXISTS
         (SELECT 1 FROM signup_touches st WHERE st.touch_id = t.id AND st.user_id = ?)`,
      `clk_${pad(i)}_b`, user,
    );
    if (late !== 1) errors.push(`${user}: toque posterior ao cadastro não ficou fora da decisão`);
  }
}

console.log(`toques: ${touches} (esperado ${expectedTouches}), cliques distintos: ${distinctClicks}`);
console.log(`installs: ${installs} (esperado ${cfg.installs})`);
console.log(`cadastros: ${signups} (esperado ${cfg.installs}), origens conferidas e auditorias recalculadas: ${recomputed}`);
if (errors.length) {
  console.error(`FALHOU (${errors.length} problemas):\n` + errors.slice(0, 20).join("\n"));
  process.exit(1);
}
console.log("OK: um toque por click_id, uma origem por cadastro, todas iguais à esperada.");
