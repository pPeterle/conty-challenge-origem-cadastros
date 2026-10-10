import { DatabaseSync } from "node:sqlite";
import type { Source } from "./link.ts";
import {
  chooseFirstOpen,
  type Decision,
  type FirstOpenLimits,
  type FirstOpenSource,
  type Origin,
  type OriginReason,
  type SignupAtSource,
  type TouchReason,
} from "./attribution.ts";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS installs (
  install_id           TEXT PRIMARY KEY,
  first_open_at        INTEGER NOT NULL,   -- início da janela (o horário escolhido)
  first_open_source    TEXT NOT NULL CHECK (first_open_source IN ('aparelho','servidor')),
  server_first_open_at INTEGER NOT NULL,   -- quando o servidor soube do install
  device_first_open_at INTEGER             -- o que o aparelho informou, aceito ou não
);

-- Gravado pelo redirecionador antes do 302. A fonte e os parâmetros que valem são estes,
-- não os que voltam na URL do app.
CREATE TABLE IF NOT EXISTS clicks (
  click_id   TEXT PRIMARY KEY,
  source     TEXT NOT NULL CHECK (source IN ('campanha','indicacao','comunidade')),
  params     TEXT NOT NULL,
  clicked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS touches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  click_id         TEXT NOT NULL UNIQUE REFERENCES clicks(click_id),
  install_id       TEXT NOT NULL REFERENCES installs(install_id),
  source           TEXT NOT NULL CHECK (source IN ('campanha','indicacao','comunidade')),
  params           TEXT NOT NULL,
  touched_at       INTEGER NOT NULL,
  client_opened_at TEXT,
  times_received   INTEGER NOT NULL DEFAULT 1  -- reenvios do mesmo clique pelo mesmo install
);
CREATE INDEX IF NOT EXISTS touches_by_install ON touches(install_id);

-- Aberturas por link que não viraram toque. Ficam para auditoria e nunca vencem.
CREATE TABLE IF NOT EXISTS rejected_touches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id       TEXT NOT NULL,
  click_id         TEXT,
  url              TEXT NOT NULL,
  reason           TEXT NOT NULL CHECK (reason IN ('link_invalido','click_desconhecido','click_divergente','click_de_outro_install')),
  received_at      INTEGER NOT NULL,
  client_opened_at TEXT,
  UNIQUE (install_id, url, reason)
);

CREATE TABLE IF NOT EXISTS signups (
  user_id          TEXT PRIMARY KEY,
  install_id       TEXT NOT NULL,
  signup_at        INTEGER NOT NULL,   -- instante usado na regra
  signup_at_source TEXT NOT NULL CHECK (signup_at_source IN ('backend','servidor')),
  server_signup_at INTEGER NOT NULL,   -- quando a chamada chegou aqui
  backend_signed_up_at INTEGER,        -- o que o backend informou, aceito ou não
  first_open_at    INTEGER,
  first_open_source TEXT,
  window_ms        INTEGER NOT NULL,
  rule_version     TEXT NOT NULL,
  origin           TEXT NOT NULL CHECK (origin IN ('campanha','indicacao','comunidade','organico')),
  reason           TEXT NOT NULL,
  winning_touch_id INTEGER UNIQUE REFERENCES touches(id),
  last_rejected_id INTEGER NOT NULL DEFAULT 0  -- toques rejeitados considerados: id <= este
);
CREATE INDEX IF NOT EXISTS signups_by_install ON signups(install_id);

CREATE TABLE IF NOT EXISTS signup_touches (
  user_id  TEXT NOT NULL REFERENCES signups(user_id),
  touch_id INTEGER NOT NULL REFERENCES touches(id),
  result   TEXT NOT NULL CHECK (result IN ('venceu','perdeu')),
  reason   TEXT NOT NULL,
  PRIMARY KEY (user_id, touch_id)
);
`;

export function openDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface InstallRow {
  install_id: string;
  first_open_at: number;
  first_open_source: FirstOpenSource;
  server_first_open_at: number;
  device_first_open_at: number | null;
}

export interface ClickRow {
  click_id: string;
  source: Source;
  params: string;
  clicked_at: number;
}

export interface TouchRow {
  id: number;
  click_id: string;
  install_id: string;
  source: Source;
  params: string;
  touched_at: number;
  client_opened_at: string | null;
  times_received: number;
  clicked_at: number | null;
}

export interface SignupRow {
  user_id: string;
  install_id: string;
  signup_at: number;
  signup_at_source: SignupAtSource;
  server_signup_at: number;
  backend_signed_up_at: number | null;
  first_open_at: number | null;
  first_open_source: FirstOpenSource | null;
  window_ms: number;
  rule_version: string;
  origin: Origin;
  reason: OriginReason;
  winning_touch_id: number | null;
  last_rejected_id: number;
}

export type RejectionReason = "link_invalido" | "click_desconhecido" | "click_divergente" | "click_de_outro_install";

export interface RejectedRow {
  id: number;
  install_id: string;
  click_id: string | null;
  url: string;
  reason: RejectionReason;
  received_at: number;
  client_opened_at: string | null;
}

export interface AuditRow extends TouchRow {
  result: "venceu" | "perdeu";
  reason: TouchReason;
}

/**
 * Registra a primeira abertura. Se o install já existe, o first_open_at só muda num caso:
 * ele veio do horário do servidor (o toque chegou antes do POST /installs) e o aparelho
 * agora informa uma primeira abertura plausível e anterior. Isso acontece uma vez só.
 */
export function ensureInstall(
  db: Db,
  installId: string,
  serverAt: number,
  deviceAt: number | null,
  limits: FirstOpenLimits,
): { install: InstallRow; created: boolean } {
  const chosen = chooseFirstOpen(deviceAt, serverAt, limits);
  const res = db
    .prepare(
      `INSERT INTO installs (install_id, first_open_at, first_open_source, server_first_open_at, device_first_open_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(install_id) DO NOTHING`,
    )
    .run(installId, chosen.at, chosen.source, serverAt, deviceAt);
  if (res.changes === 0 && deviceAt !== null) {
    const existing = getInstall(db, installId)!;
    if (existing.device_first_open_at === null && existing.first_open_source === "servidor") {
      const useDevice = chosen.source === "aparelho" && chosen.at < existing.first_open_at;
      db.prepare(
        `UPDATE installs SET device_first_open_at = ?, first_open_at = ?, first_open_source = ? WHERE install_id = ?`,
      ).run(deviceAt, useDevice ? chosen.at : existing.first_open_at, useDevice ? "aparelho" : "servidor", installId);
    }
  }
  return { install: getInstall(db, installId)!, created: res.changes === 1 };
}

export function getInstall(db: Db, installId: string): InstallRow | undefined {
  return db.prepare("SELECT * FROM installs WHERE install_id = ?").get(installId) as InstallRow | undefined;
}

export function insertClick(db: Db, c: { clickId: string; source: Source; params: Record<string, string>; clickedAt: number }) {
  db.prepare("INSERT INTO clicks (click_id, source, params, clicked_at) VALUES (?, ?, ?, ?)").run(
    c.clickId,
    c.source,
    JSON.stringify(c.params),
    c.clickedAt,
  );
}

export function getClick(db: Db, clickId: string): ClickRow | undefined {
  return db.prepare("SELECT * FROM clicks WHERE click_id = ?").get(clickId) as ClickRow | undefined;
}

/** Reenviar a mesma abertura recusada não cria outra linha (UNIQUE install + url + motivo). */
export function insertRejected(
  db: Db,
  r: { installId: string; clickId: string | null; url: string; reason: RejectionReason; receivedAt: number; clientOpenedAt: string | null },
): void {
  db.prepare(
    `INSERT INTO rejected_touches (install_id, click_id, url, reason, received_at, client_opened_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).run(r.installId, r.clickId, r.url, r.reason, r.receivedAt, r.clientOpenedAt);
}

export function lastRejectedId(db: Db, installId: string): { last: number; count: number } {
  return db
    .prepare("SELECT COALESCE(MAX(id), 0) AS last, COUNT(*) AS count FROM rejected_touches WHERE install_id = ?")
    .get(installId) as { last: number; count: number };
}

export function rejectedForSignup(db: Db, s: SignupRow): RejectedRow[] {
  return db
    .prepare("SELECT * FROM rejected_touches WHERE install_id = ? AND id <= ? ORDER BY id")
    .all(s.install_id, s.last_rejected_id) as unknown as RejectedRow[];
}

export interface NewTouch {
  clickId: string;
  installId: string;
  source: Source;
  params: Record<string, string>;
  touchedAt: number;
  clientOpenedAt: string | null;
}

/** Insere o toque; o UNIQUE(click_id) garante um registro por clique. */
export function insertTouch(db: Db, t: NewTouch): { touch: TouchRow; created: boolean } {
  const res = db
    .prepare(
      `INSERT INTO touches (click_id, install_id, source, params, touched_at, client_opened_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(click_id) DO NOTHING`,
    )
    .run(t.clickId, t.installId, t.source, JSON.stringify(t.params), t.touchedAt, t.clientOpenedAt);
  if (res.changes === 0) {
    // Reenvio: conta, mas não muda horário nem fonte. Clique de outro install não conta aqui.
    db.prepare("UPDATE touches SET times_received = times_received + 1 WHERE click_id = ? AND install_id = ?").run(
      t.clickId,
      t.installId,
    );
  }
  const touch = db.prepare(`SELECT t.*, (SELECT clicked_at FROM clicks c WHERE c.click_id = t.click_id) AS clicked_at FROM touches t WHERE t.click_id = ?`).get(t.clickId) as unknown as TouchRow;
  return { touch, created: res.changes === 1 };
}

/** Toques do install com o cadastro que já usou cada um como origem, se houver. */
export function touchesForInstall(db: Db, installId: string): (TouchRow & { used_by: string | null })[] {
  return db
    .prepare(
      `SELECT t.*, s.user_id AS used_by, (SELECT clicked_at FROM clicks c WHERE c.click_id = t.click_id) AS clicked_at
         FROM touches t LEFT JOIN signups s ON s.winning_touch_id = t.id
        WHERE t.install_id = ? ORDER BY t.id`,
    )
    .all(installId) as unknown as (TouchRow & { used_by: string | null })[];
}

export function getSignup(db: Db, userId: string): SignupRow | undefined {
  return db.prepare("SELECT * FROM signups WHERE user_id = ?").get(userId) as SignupRow | undefined;
}

export function insertSignup(
  db: Db,
  s: {
    userId: string;
    installId: string;
    signupAt: number;
    signupAtSource: SignupAtSource;
    serverSignupAt: number;
    backendSignedUpAt: number | null;
    firstOpenAt: number | null;
    firstOpenSource: FirstOpenSource | null;
    windowMs: number;
    ruleVersion: string;
    lastRejectedId: number;
  },
  decision: Decision,
): void {
  db.prepare(
    `INSERT INTO signups (user_id, install_id, signup_at, signup_at_source, server_signup_at, backend_signed_up_at,
                          first_open_at, first_open_source, window_ms, rule_version,
                          last_rejected_id, origin, reason, winning_touch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(s.userId, s.installId, s.signupAt, s.signupAtSource, s.serverSignupAt, s.backendSignedUpAt, s.firstOpenAt, s.firstOpenSource, s.windowMs, s.ruleVersion, s.lastRejectedId, decision.origin, decision.reason, decision.winnerTouchId);
  const stmt = db.prepare("INSERT INTO signup_touches (user_id, touch_id, result, reason) VALUES (?, ?, ?, ?)");
  for (const v of decision.verdicts) stmt.run(s.userId, v.touchId, v.result, v.reason);
}

/** Toques que foram considerados quando o cadastro foi decidido. */
export function auditForSignup(db: Db, userId: string): AuditRow[] {
  return db
    .prepare(
      `SELECT t.*, st.result, st.reason, (SELECT clicked_at FROM clicks c WHERE c.click_id = t.click_id) AS clicked_at
         FROM signup_touches st JOIN touches t ON t.id = st.touch_id
        WHERE st.user_id = ? ORDER BY t.touched_at, t.id`,
    )
    .all(userId) as unknown as AuditRow[];
}

/** Toques do install que chegaram depois da decisão (não estavam no retrato do cadastro). */
export function touchesAfterSignup(db: Db, userId: string, installId: string): TouchRow[] {
  return db
    .prepare(
      `SELECT t.*, (SELECT clicked_at FROM clicks c WHERE c.click_id = t.click_id) AS clicked_at FROM touches t
        WHERE t.install_id = ?
          AND NOT EXISTS (SELECT 1 FROM signup_touches st WHERE st.user_id = ? AND st.touch_id = t.id)
        ORDER BY t.touched_at, t.id`,
    )
    .all(installId, userId) as unknown as TouchRow[];
}
