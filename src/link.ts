// Contrato do link. Tudo que importa para a atribuição viaja na query string,
// porque o webview de Instagram/WhatsApp costuma não mandar referrer.
import { appLinkQuerySchema, issueDetails, type AppLink, type IssueDetail, type LinkParams } from "./schemas.ts";

export { SOURCES, type Source, type LinkParams, type AppLink } from "./schemas.ts";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string; details: IssueDetail[] };

/** Igual ao que o validador do Hono faz com a query: chave repetida vira lista (e é recusada). */
export function queryToObject(query: URLSearchParams): Record<string, string | string[]> {
  // Sem protótipo: uma chave "__proto__" na query vira só mais uma chave desconhecida.
  const out: Record<string, string | string[]> = Object.create(null);
  for (const key of new Set(query.keys())) {
    const all = query.getAll(key);
    out[key] = all.length === 1 ? all[0]! : all;
  }
  return out;
}

function sameAppLinkTarget(url: URL, base: URL): boolean {
  return url.protocol === base.protocol && url.host === base.host && url.pathname === base.pathname;
}

/** Lê o link que o app abriu (o que chega depois do redirecionador, já com cid). */
export function parseAppLink(url: string, appLinkBase: string): ParseResult<AppLink> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: "url inválida", details: [{ campo: "url", motivo: "não é uma URL" }] };
  }
  const base = new URL(appLinkBase);
  if (!sameAppLinkTarget(parsed, base)) {
    return {
      ok: false,
      message: `url precisa apontar para ${base.origin}${base.pathname}`,
      details: [{ campo: "url", motivo: "endereço diferente do link do app" }],
    };
  }
  const result = appLinkQuerySchema.safeParse(queryToObject(parsed.searchParams));
  if (!result.success) {
    const details = issueDetails(result.error);
    return { ok: false, message: describe(details), details };
  }
  return { ok: true, value: result.data };
}

export function describe(details: IssueDetail[]): string {
  return details.map((d) => `${d.campo}: ${d.motivo}`).join("; ");
}

/** Monta o link que abre o app, com o click id gerado no redirecionador. */
export function buildAppLink(appLinkBase: string, link: LinkParams, clickId: string): string {
  const url = new URL(appLinkBase);
  url.searchParams.set("src", link.source);
  for (const [k, v] of Object.entries(link.params)) url.searchParams.set(k, v);
  url.searchParams.set("cid", clickId);
  return url.toString();
}
