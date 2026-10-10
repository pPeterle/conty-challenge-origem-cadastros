import { randomUUID } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { zValidator } from "@hono/zod-validator";
import type { ZodSchema } from "zod";
import type { Clock } from "./clock.ts";
import type { AttributionConfig } from "./config.ts";
import { RULE_VERSION, TIE_PRIORITY, chooseSignupAt, decideAttribution } from "./attribution.ts";
import { buildAppLink, describe, parseAppLink } from "./link.ts";
import { silentLogger, type Logger } from "./logger.ts";
import {
  installBodySchema,
  issueDetails,
  linkQuerySchema,
  signupBodySchema,
  touchBodySchema,
  userParamSchema,
  type IssueDetail,
} from "./schemas.ts";
import {
  auditForSignup,
  ensureInstall,
  getClick,
  getInstall,
  insertClick,
  getSignup,
  insertSignup,
  insertRejected,
  insertTouch,
  lastRejectedId,
  rejectedForSignup,
  touchesAfterSignup,
  touchesForInstall,
  transaction,
  type Db,
  type RejectionReason,
  type SignupRow,
  type TouchRow,
} from "./db.ts";

export interface AppDeps {
  db: Db;
  clock: Clock;
  config: AttributionConfig;
  newClickId?: () => string;
  /** Padrão: logger silencioso (testes). O servidor passa o de `createLogger`. */
  logger?: Logger;
}

// Os corpos desta API têm poucas centenas de bytes; 16 KB já é folga de sobra.
export const MAX_BODY_BYTES = 16 * 1024;

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function fail(c: Context, status: ContentfulStatusCode, code: string, message: string, details?: IssueDetail[]) {
  return c.json({ error: { code, message, ...(details ? { details } : {}) } }, status);
}

/** Validação com zod e um formato de erro só: 400 com o caminho e o motivo de cada campo. */
function validate<T extends ZodSchema>(target: "json" | "query" | "param", schema: T, code = "validacao") {
  const prefix = code === "link_invalido" ? "link inválido" : "payload inválido";
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const details = issueDetails(result.error);
      return fail(c, 400, code, `${prefix}: ${describe(details)}`, details);
    }
  });
}

/** Sem isso, o validador do Hono trata corpo com outro content-type como `{}`. */
const requireJson: MiddlewareHandler = async (c, next) => {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/([a-z0-9.+-]*\+)?json(\s*;|$)/i.test(type)) {
    return fail(c, 400, "content_type_invalido", "envie o corpo como JSON com content-type: application/json");
  }
  await next();
};

function cidFromUrl(url: string): string | null {
  try {
    const cid = new URL(url).searchParams.get("cid");
    return cid && cid.length <= 64 ? cid : null;
  } catch {
    return null;
  }
}

function touchView(t: TouchRow) {
  return {
    click_id: t.click_id,
    source: t.source,
    params: JSON.parse(t.params) as Record<string, string>,
    clicked_at: iso(t.clicked_at),
    touched_at: iso(t.touched_at),
    client_opened_at: t.client_opened_at,
    vezes_recebido: t.times_received,
  };
}

function attributionView(db: Db, s: SignupRow) {
  const audit = auditForSignup(db, s.user_id);
  const winner = audit.find((t) => t.result === "venceu");
  return {
    user_id: s.user_id,
    install_id: s.install_id,
    signup_at: iso(s.signup_at),
    signup_at_fonte: s.signup_at_source,
    signup_recebido_em: iso(s.server_signup_at),
    signed_up_at_backend: iso(s.backend_signed_up_at),
    origem: {
      tipo: s.origin,
      motivo: s.reason,
      click_id: winner?.click_id ?? null,
      params: winner ? JSON.parse(winner.params) : null,
    },
    regra: {
      nome: "last_touch",
      versao: s.rule_version,
      janela_horas: s.window_ms / 3_600_000,
      janela_inicio: iso(s.first_open_at),
      janela_inicio_fonte: s.first_open_source,
      janela_fim: s.first_open_at === null ? null : iso(s.first_open_at + s.window_ms),
      desempate: [...TIE_PRIORITY, "click_id"],
    },
    toques_considerados: audit.map((t) => ({ ...touchView(t), resultado: t.result, motivo: t.reason })),
    // Aberturas por link recusadas antes do cadastro (url inválida, cid desconhecido ou forjado).
    toques_rejeitados: rejectedForSignup(db, s).map((r) => ({
      click_id: r.click_id,
      url: r.url,
      received_at: iso(r.received_at),
      client_opened_at: r.client_opened_at,
      resultado: "rejeitado",
      motivo: r.reason,
    })),
    // Registrados depois da decisão: ficam visíveis, mas a origem não muda.
    toques_apos_cadastro: touchesAfterSignup(db, s.user_id, s.install_id).map((t) => ({
      ...touchView(t),
      resultado: "perdeu",
      motivo: "posterior_ao_cadastro",
      // O aparelho diz que abriu antes do cadastro, mas o toque só chegou depois (fila offline
      // ou relógio errado). Fica sinalizado para análise; a origem não muda.
      relogio_diverge: t.client_opened_at !== null && Date.parse(t.client_opened_at) <= s.signup_at,
    })),
  };
}

function installView(i: NonNullable<ReturnType<typeof getInstall>>) {
  return {
    install_id: i.install_id,
    first_open_at: iso(i.first_open_at),
    first_open_source: i.first_open_source,
    server_first_open_at: iso(i.server_first_open_at),
    device_first_open_at: iso(i.device_first_open_at),
  };
}

export function createApp(deps: AppDeps) {
  const { db, clock, config } = deps;
  const newClickId = deps.newClickId ?? (() => `clk_${randomUUID().replaceAll("-", "")}`);
  const app = new Hono();
  const logger = deps.logger ?? silentLogger;

  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status === 400) {
      return fail(c, 400, "corpo_invalido", "corpo precisa ser JSON válido");
    }
    logger.error({ err, method: c.req.method, path: c.req.path }, "erro inesperado");
    return fail(c, 500, "erro_interno", "erro inesperado");
  });
  app.notFound((c) => fail(c, 404, "rota_nao_encontrada", "rota não encontrada"));

  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => fail(c, 413, "corpo_grande_demais", `corpo maior que ${MAX_BODY_BYTES} bytes`),
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  // Redirecionador: o link público não tem cid; aqui cada clique ganha o seu, e o clique
  // fica gravado. É esse registro que define a fonte, então editar a URL no caminho não adianta.
  app.get("/l", validate("query", linkQuerySchema, "link_invalido"), (c) => {
    const link = c.req.valid("query");
    const clickId = newClickId();
    insertClick(db, { clickId, source: link.source, params: link.params, clickedAt: clock.now().getTime() });
    return c.redirect(buildAppLink(config.appLinkBase, link, clickId), 302);
  });

  // Primeira abertura do app. Repetir não muda o first_open_at (ver ensureInstall).
  app.post("/installs", requireJson, validate("json", installBodySchema), (c) => {
    const body = c.req.valid("json");
    const deviceAt = body.first_open_at ? Date.parse(body.first_open_at) : null;
    const { install, created } = ensureInstall(db, body.install_id, clock.now().getTime(), deviceAt, config.firstOpen);
    return c.json({ ...installView(install), novo: created }, created ? 201 : 200);
  });

  // Toque: o app abriu por um link. O horário que vale é o do servidor.
  app.post("/touches", requireJson, validate("json", touchBodySchema), (c) => {
    const body = c.req.valid("json");
    const now = clock.now().getTime();
    const clientOpenedAt = body.opened_at ? new Date(body.opened_at).toISOString() : null;
    // A abertura recusada fica registrada para a auditoria do cadastro; nunca vira origem.
    const reject = (status: ContentfulStatusCode, reason: RejectionReason, message: string, clickId: string | null, details?: IssueDetail[]) => {
      insertRejected(db, { installId: body.install_id, clickId, url: body.url, reason, receivedAt: now, clientOpenedAt });
      return fail(c, status, reason, message, details);
    };

    const link = parseAppLink(body.url, config.appLinkBase);
    if (!link.ok) return reject(400, "link_invalido", link.message, cidFromUrl(body.url), link.details);

    const click = getClick(db, link.value.clickId);
    if (!click) {
      return reject(400, "click_desconhecido", "esse cid não foi emitido pelo redirecionador (GET /l)", link.value.clickId);
    }
    if (click.source !== link.value.source || click.params !== JSON.stringify(link.value.params)) {
      return reject(409, "click_divergente", "fonte ou parâmetros da url não batem com o clique gravado", link.value.clickId);
    }

    const outcome = transaction(db, () => {
      // Se o toque chega antes do registro de primeira abertura, ele mesmo registra.
      ensureInstall(db, body.install_id, now, null, config.firstOpen);
      return insertTouch(db, {
        clickId: link.value.clickId,
        installId: body.install_id,
        source: click.source,
        params: JSON.parse(click.params) as Record<string, string>,
        touchedAt: now,
        clientOpenedAt,
      });
    });

    if (outcome.touch.install_id !== body.install_id) {
      return reject(409, "click_de_outro_install", "esse click_id já foi registrado por outro install", link.value.clickId);
    }
    return c.json(
      { install_id: body.install_id, ...touchView(outcome.touch), duplicado: !outcome.created },
      outcome.created ? 201 : 200,
    );
  });

  app.post("/signups", requireJson, validate("json", signupBodySchema), (c) => {
    const { user_id: userId, install_id: installId, signed_up_at: signedUpAt } = c.req.valid("json");

    const result = transaction(db, () => {
      const existing = getSignup(db, userId);
      if (existing) return { signup: existing, created: false };

      const serverAt = clock.now().getTime();
      const install = getInstall(db, installId);
      const backendAt = signedUpAt ? Date.parse(signedUpAt) : null;
      const chosen = chooseSignupAt(backendAt, serverAt, install?.first_open_at ?? null, config.firstOpen);
      const signupAt = chosen.at;
      const touches = install ? touchesForInstall(db, installId) : [];
      const rejected = lastRejectedId(db, installId);
      const decision = decideAttribution({
        rejectedCount: rejected.count,
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
        {
          userId,
          installId,
          signupAt,
          signupAtSource: chosen.source,
          serverSignupAt: serverAt,
          backendSignedUpAt: backendAt,
          firstOpenAt: install?.first_open_at ?? null,
          firstOpenSource: install?.first_open_source ?? null,
          windowMs: config.windowMs,
          ruleVersion: RULE_VERSION,
          lastRejectedId: rejected.last,
        },
        decision,
      );
      return { signup: getSignup(db, userId)!, created: true };
    });

    if (result.signup.install_id !== installId) {
      return fail(c, 409, "cadastro_com_outro_install", "esse user_id já foi cadastrado a partir de outro install");
    }
    return c.json(attributionView(db, result.signup), result.created ? 201 : 200);
  });

  app.get("/signups/:userId/attribution", validate("param", userParamSchema), (c) => {
    const signup = getSignup(db, c.req.valid("param").userId);
    if (!signup) return fail(c, 404, "cadastro_nao_encontrado", "cadastro não encontrado");
    return c.json(attributionView(db, signup));
  });

  return app;
}
