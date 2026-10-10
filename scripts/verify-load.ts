// Confere as invariantes no banco depois da carga. Sai com 1 se alguma quebrou.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decideAttribution } from "../src/attribution.ts";
import type { Source } from "../src/link.ts";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("uso: verify-load.ts <arquivo.db>");
const cfg = JSON.parse(readFileSync(new URL("../load/scenario.json", import.meta.url), "utf8")) as { installs: number; touchDuplicates: number };
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

// O cid é gerado pelo servidor, então o esperado é descrito pela fonte do toque vencedor.
const expected = (i: number): { origin: string; winnerSource: string | null; touches: number } => {
  switch (i % 4) {
    case 0: return { origin: "organico", winnerSource: null, touches: 0 };
    case 1: return { origin: "campanha", winnerSource: "campanha", touches: 1 };
    case 2: return { origin: "campanha", winnerSource: "campanha", touches: 2 };
    default: return { origin: "indicacao", winnerSource: "indicacao", touches: 2 };
  }
};

const clicks = count("SELECT COUNT(*) AS n FROM clicks");
if (clicks < touches) errors.push(`há toque sem clique gravado: ${touches} toques, ${clicks} cliques`);
const mismatched = count(
  "SELECT COUNT(*) AS n FROM touches t JOIN clicks c ON c.click_id = t.click_id WHERE c.source <> t.source OR c.params <> t.params",
);
if (mismatched) errors.push(`${mismatched} toques com fonte/params diferentes do clique gravado`);
// Só os payloads inválidos de propósito (installs "lixo_*") podem gerar abertura recusada.
const unexpectedRejections = count("SELECT COUNT(*) AS n FROM rejected_touches WHERE install_id NOT LIKE 'lixo%'");
if (unexpectedRejections) errors.push(`${unexpectedRejections} aberturas legítimas foram recusadas`);
// Cada clique saiu touchDuplicates vezes; reenvio por falha de conexão pode somar mais, nunca menos.
const undercounted = count("SELECT COUNT(*) AS n FROM touches WHERE times_received < ?", cfg.touchDuplicates);
if (undercounted) errors.push(`${undercounted} toques com vezes_recebido menor que o número de reenvios`);
const touchesOfInstall = db.prepare("SELECT COUNT(*) AS n FROM touches WHERE install_id = ?");

const signupStmt = db.prepare(
  `SELECT s.*, t.source AS winning_source, t.install_id AS winning_install
     FROM signups s LEFT JOIN touches t ON t.id = s.winning_touch_id WHERE s.user_id = ?`,
);
const snapshotStmt = db.prepare(
  `SELECT t.id, t.click_id, t.source, t.touched_at, st.result, st.reason
     FROM signup_touches st JOIN touches t ON t.id = st.touch_id WHERE st.user_id = ? ORDER BY t.id`,
);
let recomputed = 0;
for (let i = 0; i < cfg.installs; i++) {
  const user = `u_${pad(i)}`;
  const s = signupStmt.get(user) as
    | {
        origin: string;
        reason: string;
        install_id: string;
        winning_source: string | null;
        winning_install: string | null;
        signup_at: number;
        first_open_at: number;
        window_ms: number;
      }
    | undefined;
  if (!s) { errors.push(`${user}: sem cadastro`); continue; }
  const exp = expected(i);
  if (s.origin !== exp.origin || s.winning_source !== exp.winnerSource) {
    errors.push(`${user}: origem ${s.origin}/${s.winning_source}, esperado ${exp.origin}/${exp.winnerSource}`);
  }
  if (s.winning_install !== null && s.winning_install !== s.install_id) errors.push(`${user}: venceu toque de outro install`);
  const n = (touchesOfInstall.get(s.install_id) as { n: number }).n;
  if (n !== exp.touches) errors.push(`${user}: ${n} toques no install, esperado ${exp.touches}`);
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
      `SELECT COUNT(*) AS n FROM touches t WHERE t.install_id = ? AND t.source = 'comunidade' AND NOT EXISTS
         (SELECT 1 FROM signup_touches st WHERE st.touch_id = t.id AND st.user_id = ?)`,
      s.install_id, user,
    );
    if (late !== 1) errors.push(`${user}: toque posterior ao cadastro não ficou fora da decisão`);
  }
}

console.log(`cliques gravados: ${clicks}`);
console.log(`toques: ${touches} (esperado ${expectedTouches}), cliques distintos: ${distinctClicks}`);
console.log(`installs: ${installs} (esperado ${cfg.installs})`);
console.log(`cadastros: ${signups} (esperado ${cfg.installs}), origens conferidas e auditorias recalculadas: ${recomputed}`);
if (errors.length) {
  console.error(`FALHOU (${errors.length} problemas):\n` + errors.slice(0, 20).join("\n"));
  process.exit(1);
}
console.log("OK: um toque por click_id, uma origem por cadastro, todas iguais à esperada.");
