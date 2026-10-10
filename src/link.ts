// Contrato do link. Tudo que importa para a atribuição viaja na query string,
// porque o webview de Instagram/WhatsApp costuma não mandar referrer.

export const SOURCES = ["campanha", "indicacao", "comunidade"] as const;
export type Source = (typeof SOURCES)[number];

/** Parâmetros aceitos por fonte. O primeiro de cada lista é obrigatório. */
const PARAMS_BY_SOURCE: Record<Source, { required: string; optional: string[] }> = {
  campanha: { required: "cmp", optional: ["ch"] },
  indicacao: { required: "ref", optional: [] },
  comunidade: { required: "com", optional: ["ch"] },
};

const VALUE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const CLICK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface LinkParams {
  source: Source;
  params: Record<string, string>;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function isSource(v: string | undefined): v is Source {
  return v !== undefined && (SOURCES as readonly string[]).includes(v);
}

/** Valida src + parâmetros da fonte. Parâmetros desconhecidos são descartados. */
export function parseLinkParams(query: URLSearchParams): ParseResult<LinkParams> {
  const src = query.get("src") ?? undefined;
  if (!isSource(src)) {
    return { ok: false, message: `src precisa ser um de: ${SOURCES.join(", ")}` };
  }
  const spec = PARAMS_BY_SOURCE[src];
  const params: Record<string, string> = {};
  for (const key of [spec.required, ...spec.optional]) {
    const value = query.get(key);
    if (value === null) continue;
    if (!VALUE_RE.test(value)) {
      return { ok: false, message: `parâmetro ${key} inválido` };
    }
    params[key] = value;
  }
  if (params[spec.required] === undefined) {
    return { ok: false, message: `link de ${src} precisa do parâmetro ${spec.required}` };
  }
  return { ok: true, value: { source: src, params } };
}

export interface AppLink extends LinkParams {
  clickId: string;
}

/** Lê o link que o app abriu (o que chega depois do redirecionador, já com cid). */
export function parseAppLink(url: string): ParseResult<AppLink> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: "url inválida" };
  }
  const base = parseLinkParams(parsed.searchParams);
  if (!base.ok) return base;
  const cid = parsed.searchParams.get("cid");
  if (cid === null || !CLICK_ID_RE.test(cid)) {
    return { ok: false, message: "link sem cid válido (8 a 64 caracteres, letras, números, _ ou -)" };
  }
  return { ok: true, value: { ...base.value, clickId: cid } };
}

/** Monta o link que abre o app, com o click id gerado no redirecionador. */
export function buildAppLink(appLinkBase: string, link: LinkParams, clickId: string): string {
  const url = new URL(appLinkBase);
  url.searchParams.set("src", link.source);
  for (const [k, v] of Object.entries(link.params)) url.searchParams.set(k, v);
  url.searchParams.set("cid", clickId);
  return url.toString();
}
