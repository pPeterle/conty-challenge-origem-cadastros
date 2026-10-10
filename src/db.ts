import { DatabaseSync } from "node:sqlite";
import type { Source } from "./link.ts";
import type { Decision, Origin, OriginReason, TouchReason } from "./attribution.ts";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS installs (
  install_id    TEXT PRIMARY KEY,
  first_open_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS touches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  click_id         TEXT NOT NULL UNIQUE,
  install_id       TEXT NOT NULL REFERENCES installs(install_id),
  source           TEXT NOT NULL CHECK (source IN ('campanha','indicacao','comunidade')),
  params           TEXT NOT NULL,
  touched_at       INTEGER NOT NULL,
  client_opened_at TEXT
);
CREATE INDEX IF NOT EXISTS touches_by_install ON touches(install_id);

CREATE TABLE IF NOT EXISTS signups (
  user_id          TEXT PRIMARY KEY,
  install_id       TEXT NOT NULL,
  signup_at        INTEGER NOT NULL,
  first_open_at    INTEGER,
  window_ms        INTEGER NOT NULL,
  origin           TEXT NOT NULL CHECK (origin IN ('campanha','indicacao','comunidade','organico')),
  reason           TEXT NOT NULL,
  winning_touch_id INTEGER UNIQUE REFERENCES touches(id)
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
}

export interface TouchRow {
  id: number;
  click_id: string;
  install_id: string;
  source: Source;
  params: string;
  touched_at: number;
  client_opened_at: string | null;
}

export interface SignupRow {
  user_id: string;
  install_id: string;
  signup_at: number;
  first_open_at: number | null;
  window_ms: number;
  origin: Origin;
  reason: OriginReason;
  winning_touch_id: number | null;
}

export interface AuditRow extends TouchRow {
  result: "venceu" | "perdeu";
  reason: TouchReason;
}

/** Registra a primeira abertura. Se já existe, mantém o first_open_at original. */
export function ensureInstall(db: Db, installId: string, at: number): { install: InstallRow; created: boolean } {
  const res = db
    .prepare("INSERT INTO installs (install_id, first_open_at) VALUES (?, ?) ON CONFLICT(install_id) DO NOTHING")
    .run(installId, at);
  return { install: getInstall(db, installId)!, created: res.changes === 1 };
}

export function getInstall(db: Db, installId: string): InstallRow | undefined {
  return db.prepare("SELECT * FROM installs WHERE install_id = ?").get(installId) as InstallRow | undefined;
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
  const touch = db.prepare("SELECT * FROM touches WHERE click_id = ?").get(t.clickId) as unknown as TouchRow;
  return { touch, created: res.changes === 1 };
}

/** Toques do install com o cadastro que já usou cada um como origem, se houver. */
export function touchesForInstall(db: Db, installId: string): (TouchRow & { used_by: string | null })[] {
  return db
    .prepare(
      `SELECT t.*, s.user_id AS used_by
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
  s: { userId: string; installId: string; signupAt: number; firstOpenAt: number | null; windowMs: number },
  decision: Decision,
): void {
  db.prepare(
    `INSERT INTO signups (user_id, install_id, signup_at, first_open_at, window_ms, origin, reason, winning_touch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(s.userId, s.installId, s.signupAt, s.firstOpenAt, s.windowMs, decision.origin, decision.reason, decision.winnerTouchId);
  const stmt = db.prepare("INSERT INTO signup_touches (user_id, touch_id, result, reason) VALUES (?, ?, ?, ?)");
  for (const v of decision.verdicts) stmt.run(s.userId, v.touchId, v.result, v.reason);
}

/** Toques que foram considerados quando o cadastro foi decidido. */
export function auditForSignup(db: Db, userId: string): AuditRow[] {
  return db
    .prepare(
      `SELECT t.*, st.result, st.reason
         FROM signup_touches st JOIN touches t ON t.id = st.touch_id
        WHERE st.user_id = ? ORDER BY t.touched_at, t.id`,
    )
    .all(userId) as unknown as AuditRow[];
}

/** Toques do install que chegaram depois da decisão (não estavam no retrato do cadastro). */
export function touchesAfterSignup(db: Db, userId: string, installId: string): TouchRow[] {
  return db
    .prepare(
      `SELECT t.* FROM touches t
        WHERE t.install_id = ?
          AND NOT EXISTS (SELECT 1 FROM signup_touches st WHERE st.user_id = ? AND st.touch_id = t.id)
        ORDER BY t.touched_at, t.id`,
    )
    .all(installId, userId) as unknown as TouchRow[];
}
