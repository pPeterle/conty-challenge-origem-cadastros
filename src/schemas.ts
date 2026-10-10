import { z } from "zod";

// Todos os dados que chegam de fora passam por aqui. Objetos usam o padrão do zod
// (strip): campos desconhecidos são ignorados, nunca gravados.

export const SOURCES = ["campanha", "indicacao", "comunidade"] as const;
export type Source = (typeof SOURCES)[number];

const ID_RE = /^[A-Za-z0-9_-]+$/;
const VALUE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const CLICK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_URL_LENGTH = 2048;

/** Parâmetros aceitos por fonte. `required` é obrigatório; o resto é descartado. */
export const PARAMS_BY_SOURCE: Record<Source, { required: string; optional: string[] }> = {
  campanha: { required: "cmp", optional: ["ch"] },
  indicacao: { required: "ref", optional: [] },
  comunidade: { required: "com", optional: ["ch"] },
};

const TYPE_NAMES: Record<string, string> = {
  string: "texto",
  number: "número",
  boolean: "booleano",
  object: "objeto",
  array: "lista",
  null: "null",
  undefined: "nada",
};

/** Mensagens do zod em português, para os casos que os schemas não nomeiam. */
const ptErrorMap: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_type) {
    if (issue.received === "undefined") return { message: "obrigatório" };
    if (issue.expected === "string" && issue.received === "array") return { message: "informado mais de uma vez" };
    return { message: `esperado ${TYPE_NAMES[issue.expected] ?? issue.expected}, veio ${TYPE_NAMES[issue.received] ?? issue.received}` };
  }
  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    return { message: `precisa ser um de: ${issue.options.join(", ")}` };
  }
  return { message: ctx.defaultError };
};
z.setErrorMap(ptErrorMap);

export const idSchema = z
  .string()
  .trim()
  .min(1, "não pode ser vazio")
  .max(128, "até 128 caracteres")
  .regex(ID_RE, "use só letras, números, _ ou -");

export const isoDateTimeSchema = z
  .string()
  .trim()
  .datetime({ offset: true, message: "data ISO 8601 com fuso, ex. 2026-03-01T12:00:00.000Z" });

const linkValue = z.string().trim().regex(VALUE_RE, "até 64 caracteres: letras, números, _, . ou -");

const linkShape = {
  src: z.enum(SOURCES),
  cmp: linkValue.optional(),
  ch: linkValue.optional(),
  ref: linkValue.optional(),
  com: linkValue.optional(),
};

type RawLink = { src: Source; cmp?: string; ch?: string; ref?: string; com?: string };

function requireSourceParam(q: RawLink, ctx: z.RefinementCtx) {
  const required = PARAMS_BY_SOURCE[q.src].required as keyof RawLink;
  if (q[required] === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [required], message: `obrigatório em link de ${q.src}` });
  }
}

function toLinkParams(q: RawLink) {
  const spec = PARAMS_BY_SOURCE[q.src];
  const params: Record<string, string> = {};
  for (const key of [spec.required, ...spec.optional]) {
    const value = q[key as keyof RawLink];
    if (value !== undefined) params[key] = value;
  }
  return { source: q.src, params };
}

/** Query do link público (`GET /l`), ainda sem click id. */
export const linkQuerySchema = z.object(linkShape).superRefine(requireSourceParam).transform(toLinkParams);
export type LinkParams = z.infer<typeof linkQuerySchema>;

/** Query do link que abriu o app: a mesma coisa, mais o `cid` do redirecionador. */
export const appLinkQuerySchema = z
  .object({ ...linkShape, cid: z.string().trim().regex(CLICK_ID_RE, "8 a 64 caracteres: letras, números, _ ou -") })
  .superRefine(requireSourceParam)
  .transform((q) => ({ ...toLinkParams(q), clickId: q.cid }));
export type AppLink = z.infer<typeof appLinkQuerySchema>;

export const installBodySchema = z.object({
  install_id: idSchema,
  /** Horário da primeira abertura segundo o aparelho (pode ter sido offline). */
  first_open_at: isoDateTimeSchema.optional(),
});

export const touchBodySchema = z.object({
  install_id: idSchema,
  url: z.string().trim().min(1, "não pode ser vazia").max(MAX_URL_LENGTH, `até ${MAX_URL_LENGTH} caracteres`),
  opened_at: isoDateTimeSchema.nullish(),
});

export const signupBodySchema = z.object({
  user_id: idSchema,
  install_id: idSchema,
});

export const userParamSchema = z.object({ userId: idSchema });

export interface IssueDetail {
  campo: string;
  motivo: string;
}

export function issueDetails(error: z.ZodError): IssueDetail[] {
  return error.issues.map((i) => ({ campo: i.path.length ? i.path.join(".") : "(corpo)", motivo: i.message }));
}
