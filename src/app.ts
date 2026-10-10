import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Clock } from "./clock.ts";
import type { AttributionConfig } from "./config.ts";
import { TIE_PRIORITY, decideAttribution } from "./attribution.ts";
import { buildAppLink, parseAppLink, parseLinkParams } from "./link.ts";
import {
  auditForSignup,
  ensureInstall,
  getInstall,
  getSignup,
  insertSignup,
  insertTouch,
  touchesAfterSignup,
  touchesForInstall,
  transaction,
  type Db,
  type SignupRow,
  type TouchRow,
} from "./db.ts";

export interface AppDeps {
  db: Db;
  clock: Clock;
  config: AttributionConfig;
  newClickId?: () => string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function fail(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function idField(body: Record<string, unknown>, name: string): string | null {
  const v = body[name];
  return typeof v === "string" && ID_RE.test(v) ? v : null;
}

function touchView(t: TouchRow) {
  return {
    click_id: t.click_id,
    source: t.source,
    params: JSON.parse(t.params) as Record<string, string>,
    touched_at: iso(t.touched_at),
    client_opened_at: t.client_opened_at,
  };
}

function attributionView(db: Db, s: SignupRow) {
  const audit = auditForSignup(db, s.user_id);
  const winner = audit.find((t) => t.result === "venceu");
  return {
    user_id: s.user_id,
    install_id: s.install_id,
    signup_at: iso(s.signup_at),
    origem: {
      tipo: s.origin,
      motivo: s.reason,
      click_id: winner?.click_id ?? null,
      params: winner ? JSON.parse(winner.params) : null,
    },
    regra: {
      nome: "last_touch",
      janela_horas: s.window_ms / 3_600_000,
      janela_inicio: iso(s.first_open_at),
      janela_fim: s.first_open_at === null ? null : iso(s.first_open_at + s.window_ms),
      desempate: [...TIE_PRIORITY, "click_id"],
    },
    toques_considerados: audit.map((t) => ({ ...touchView(t), resultado: t.result, motivo: t.reason })),
    // Registrados depois da decisão: ficam visíveis, mas a origem não muda.
    toques_apos_cadastro: touchesAfterSignup(db, s.user_id, s.install_id).map((t) => ({
      ...touchView(t),
      resultado: "perdeu",
      motivo: "posterior_ao_cadastro",
    })),
  };
}

export function createApp(deps: AppDeps) {
  const { db, clock, config } = deps;
  const newClickId = deps.newClickId ?? (() => `clk_${randomUUID().replaceAll("-", "")}`);
  const app = new Hono();

  app.onError((err, c) => {
    console.error(err);
    return fail(c, 500, "erro_interno", "erro inesperado");
  });
  app.notFound((c) => fail(c, 404, "rota_nao_encontrada", "rota não encontrada"));

  app.get("/health", (c) => c.json({ ok: true }));

  // Redirecionador: o link público não tem cid; aqui cada clique ganha o seu.
  app.get("/l", (c) => {
    const parsed = parseLinkParams(new URL(c.req.url).searchParams);
    if (!parsed.ok) return fail(c, 400, "link_invalido", parsed.message);
    return c.redirect(buildAppLink(config.appLinkBase, parsed.value, newClickId()), 302);
  });

  // Primeira abertura do app. Repetir não muda o first_open_at.
  app.post("/installs", async (c) => {
    const body = await readJson(c);
    const installId = body && idField(body, "install_id");
    if (!installId) return fail(c, 400, "validacao", "install_id obrigatório (1 a 128 caracteres, letras, números, _ ou -)");
    const { install, created } = ensureInstall(db, installId, clock.now().getTime());
    return c.json(
      { install_id: install.install_id, first_open_at: iso(install.first_open_at), novo: created },
      created ? 201 : 200,
    );
  });

  // Toque: o app abriu por um link. O horário que vale é o do servidor.
  app.post("/touches", async (c) => {
    const body = await readJson(c);
    const installId = body && idField(body, "install_id");
    if (!body || !installId) return fail(c, 400, "validacao", "install_id obrigatório (1 a 128 caracteres, letras, números, _ ou -)");
    if (typeof body.url !== "string") return fail(c, 400, "validacao", "url obrigatória: o link que abriu o app");
    const openedAt = body.opened_at;
    if (openedAt !== undefined && (typeof openedAt !== "string" || Number.isNaN(Date.parse(openedAt)))) {
      return fail(c, 400, "validacao", "opened_at precisa ser data ISO 8601");
    }
    const link = parseAppLink(body.url);
    if (!link.ok) return fail(c, 400, "link_invalido", link.message);

    const now = clock.now().getTime();
    const outcome = transaction(db, () => {
      // Se o toque chega antes do registro de primeira abertura, ele mesmo registra.
      ensureInstall(db, installId, now);
      return insertTouch(db, {
        clickId: link.value.clickId,
        installId,
        source: link.value.source,
        params: link.value.params,
        touchedAt: now,
        clientOpenedAt: (openedAt as string | undefined) ?? null,
      });
    });

    if (outcome.touch.install_id !== installId) {
      return fail(c, 409, "click_de_outro_install", "esse click_id já foi registrado por outro install");
    }
    return c.json(
      { install_id: installId, ...touchView(outcome.touch), duplicado: !outcome.created },
      outcome.created ? 201 : 200,
    );
  });

  app.post("/signups", async (c) => {
    const body = await readJson(c);
    const userId = body && idField(body, "user_id");
    const installId = body && idField(body, "install_id");
    if (!userId || !installId) {
      return fail(c, 400, "validacao", "user_id e install_id obrigatórios (1 a 128 caracteres, letras, números, _ ou -)");
    }

    const result = transaction(db, () => {
      const existing = getSignup(db, userId);
      if (existing) return { signup: existing, created: false };

      const signupAt = clock.now().getTime();
      const install = getInstall(db, installId);
      const touches = install ? touchesForInstall(db, installId) : [];
      const decision = decideAttribution({
        firstOpenAt: install?.first_open_at ?? null,
        signupAt,
        windowMs: config.windowMs,
        touches: touches.map((t) => ({
          id: t.id,
          clickId: t.click_id,
          source: t.source,
          touchedAt: t.touched_at,
          usedBySignup: t.used_by,
        })),
      });
      insertSignup(
        db,
        { userId, installId, signupAt, firstOpenAt: install?.first_open_at ?? null, windowMs: config.windowMs },
        decision,
      );
      return { signup: getSignup(db, userId)!, created: true };
    });

    if (result.signup.install_id !== installId) {
      return fail(c, 409, "cadastro_com_outro_install", "esse user_id já foi cadastrado a partir de outro install");
    }
    return c.json(attributionView(db, result.signup), result.created ? 201 : 200);
  });

  app.get("/signups/:userId/attribution", (c) => {
    const signup = getSignup(db, c.req.param("userId"));
    if (!signup) return fail(c, 404, "cadastro_nao_encontrado", "cadastro não encontrado");
    return c.json(attributionView(db, signup));
  });

  return app;
}
