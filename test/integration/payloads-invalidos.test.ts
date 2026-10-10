import pino from "pino";
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../../src/app.ts";
import { campaignLink, setup } from "./helpers.ts";

const VALID_URL = campaignLink("clk_aaaa0001");

type Case = [nome: string, corpo: string | undefined, contentType?: string];

// Corpos que não são um objeto JSON: valem para qualquer rota de escrita.
const malformed: Case[] = [
  ["JSON malformado", "{install_id: inst_1"],
  ["corpo vazio", ""],
  ["sem corpo", undefined],
  ["null", "null"],
  ["array", JSON.stringify([{ install_id: "inst_1" }])],
  ["string solta", JSON.stringify("inst_1")],
  ["número solto", "42"],
  ["NaN literal", '{"install_id":"inst_1","n":NaN}'],
  ["Infinity literal", '{"install_id":"inst_1","n":Infinity}'],
];

const badIds: [string, unknown][] = [
  ["ausente", undefined],
  ["número", 123],
  ["objeto", { id: "inst_1" }],
  ["array", ["inst_1"]],
  ["string vazia", ""],
  ["só espaços", "   "],
  ["com espaço", "inst 1"],
  ["unicode", "inst_ção"],
  ["emoji", "inst_🚀"],
  ["129 caracteres", "a".repeat(129)],
  ["injeção SQL", "x'; DROP TABLE touches;--"],
  ["booleano", true],
  ["null", null],
];

// Recusados pelo schema do corpo: nada é gravado.
const badTouchFields: [string, Record<string, unknown>][] = [
  ["url ausente", { install_id: "inst_1" }],
  ["url número", { install_id: "inst_1", url: 1 }],
  ["url vazia", { install_id: "inst_1", url: "" }],
  ["url gigante", { install_id: "inst_1", url: `${VALID_URL}&x=${"a".repeat(2100)}` }],
  ["opened_at inválido", { install_id: "inst_1", url: VALID_URL, opened_at: "ontem" }],
  ["opened_at sem fuso", { install_id: "inst_1", url: VALID_URL, opened_at: "2026-03-01T12:00:00" }],
  ["opened_at só data", { install_id: "inst_1", url: VALID_URL, opened_at: "2026-03-01" }],
  ["opened_at mês 13", { install_id: "inst_1", url: VALID_URL, opened_at: "2026-13-01T12:00:00Z" }],
  ["opened_at \"1\"", { install_id: "inst_1", url: VALID_URL, opened_at: "1" }],
  ["opened_at \"March 1\"", { install_id: "inst_1", url: VALID_URL, opened_at: "March 1" }],
  ["opened_at RFC 2822", { install_id: "inst_1", url: VALID_URL, opened_at: "Tue, 01 Mar 2026 12:00:00 GMT" }],
  ["opened_at número", { install_id: "inst_1", url: VALID_URL, opened_at: 1772366400000 }],
  ["opened_at objeto", { install_id: "inst_1", url: VALID_URL, opened_at: { at: "2026-03-01T12:00:00Z" } }],
];

// Passam no datetime({ offset: true }) do zod, mas não são um instante de verdade.
const impossibleDates = [
  "2026-03-01T12:00:00+24:00",
  "2026-03-01T12:00:00+99:00",
  "2026-03-01T12:00:00+23:60",
  "2026-03-01T12:00:00-15:00",
];

// Corpo válido, link recusado: só a abertura recusada fica registrada, para auditoria.
const badTouchLinks: [string, Record<string, unknown>][] = [
  ["url sem protocolo", { install_id: "inst_1", url: "conty.app/abrir?src=campanha&cmp=x&cid=clk_aaaa0001" }],
  ["url javascript:", { install_id: "inst_1", url: "javascript:alert(1)//?src=campanha&cmp=x&cid=clk_aaaa0001" }],
  ["src desconhecido", { install_id: "inst_1", url: "https://conty.app/abrir?src=google&cid=clk_aaaa0001" }],
  ["src repetido", { install_id: "inst_1", url: `${VALID_URL}&src=indicacao` }],
  ["cid repetido", { install_id: "inst_1", url: `${VALID_URL}&cid=clk_bbbb0002` }],
  ["cid curto", { install_id: "inst_1", url: campaignLink("clk") }],
  ["cid com espaço", { install_id: "inst_1", url: "https://conty.app/abrir?src=campanha&cmp=x&cid=clk%20aaaa0001" }],
  ["parâmetro obrigatório ausente", { install_id: "inst_1", url: "https://conty.app/abrir?src=indicacao&cid=clk_aaaa0001" }],
  ["valor com caractere proibido", { install_id: "inst_1", url: "https://conty.app/abrir?src=campanha&cmp=%3Cscript%3E&cid=clk_aaaa0001" }],
  ["url de outro host", { install_id: "inst_1", url: "https://evil.example/abrir?src=campanha&cmp=x&cid=clk_eeee0001" }],
  ["url de outro caminho", { install_id: "inst_1", url: "https://conty.app/qualquer?src=campanha&cmp=x&cid=clk_eeee0001" }],
];

const routes = [
  { path: "/installs", valid: { install_id: "inst_1" }, idFields: ["install_id"] },
  { path: "/touches", valid: { install_id: "inst_1", url: VALID_URL }, idFields: ["install_id"] },
  { path: "/signups", valid: { install_id: "inst_1", user_id: "u_1" }, idFields: ["install_id", "user_id"] },
] as const;

function raw(app: ReturnType<typeof setup>["app"], path: string, body: string | undefined, contentType = "application/json") {
  return app.request(path, { method: "POST", headers: { "content-type": contentType }, body });
}

function tableCounts(db: ReturnType<typeof setup>["db"]) {
  return ["installs", "touches", "signups", "signup_touches", "rejected_touches"].map(
    (t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
  );
}

async function expectError(res: Response, status: number) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(typeof body.error.code).toBe("string");
  expect(typeof body.error.message).toBe("string");
  expect(JSON.stringify(body)).not.toMatch(/at .*\.ts|stack|Error:/);
}

describe.each(routes)("payloads inválidos em POST $path", ({ path, valid, idFields }) => {
  it.each(malformed)("%s devolve 400 e não grava nada", async (_nome, corpo) => {
    const { click, app, db } = setup();
    await expectError(await raw(app, path, corpo), 400);
    expect(tableCounts(db)).toEqual([0, 0, 0, 0, 0]);
  });

  for (const field of idFields) {
    it.each(badIds)(`${field} %s devolve 400 e não grava nada`, async (_nome, value) => {
      const { click, post, db } = setup();
      await expectError(await post(path, { ...valid, [field]: value }), 400);
      expect(tableCounts(db)).toEqual([0, 0, 0, 0, 0]);
    });
  }

  it("corpo acima do limite devolve 413 e não grava nada", async () => {
    const { click, app, db } = setup();
    const big = JSON.stringify({ ...valid, lixo: "x".repeat(MAX_BODY_BYTES) });
    const res = await raw(app, path, big);
    await expectError(res, 413);
    expect(tableCounts(db)).toEqual([0, 0, 0, 0, 0]);
  });

  it("campos extras desconhecidos são ignorados", async () => {
    const { click, post } = setup();
    click(VALID_URL);
    const res = await post(path, { ...valid, extra: { a: [1, 2] }, __proto__x: 1 });
    expect(res.status).toBe(201);
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", ""])(
    "content-type %j devolve 400 content_type_invalido e não grava nada",
    async (type) => {
      const { click, app, db } = setup();
      const res = await raw(app, path, JSON.stringify(valid), type);
      await expectError(res, 400);
      expect(((await app.request(path, { method: "POST", body: JSON.stringify(valid) })).status)).toBe(400);
      expect(tableCounts(db)).toEqual([0, 0, 0, 0, 0]);
    },
  );

  it("content-type application/json com charset é aceito", async () => {
    const { click, app } = setup();
    click(VALID_URL);
    expect((await raw(app, path, JSON.stringify(valid), "application/json; charset=utf-8")).status).toBe(201);
  });

  it("erro de validação traz details com campo e motivo", async () => {
    const { click, post } = setup();
    const res = await post(path, { ...valid, install_id: 42 });
    expect(await res.json()).toMatchObject({
      error: { code: "validacao", details: [{ campo: "install_id", motivo: "esperado texto, veio número" }] },
    });
  });
});

describe("datas com fuso impossível", () => {
  it.each(impossibleDates)("first_open_at %s em POST /installs devolve 400, não 500", async (value) => {
    const { post, db } = setup();
    const res = await post("/installs", { install_id: "inst_1", first_open_at: value });
    await expectError(res.clone(), 400);
    expect(((await res.json()) as { error: { details: { campo: string }[] } }).error.details[0]?.campo).toBe("first_open_at");
    expect(tableCounts(db)).toEqual([0, 0, 0, 0, 0]);
  });

  it.each([...impossibleDates, "2026-03-01", "ontem", "2026-03-01T12:00:00"])(
    "signed_up_at %s em POST /signups devolve 400",
    async (value) => {
      const { post, db } = setup();
      await expectError(await post("/signups", { user_id: "u_1", install_id: "inst_1", signed_up_at: value }), 400);
      expect(tableCounts(db)).toEqual([0, 0, 0, 0, 0]);
    },
  );

  it.each(impossibleDates)("opened_at %s em POST /touches devolve 400, não 500", async (value) => {
    const { post, db, click } = setup();
    const res = await post("/touches", { install_id: "inst_1", url: click(VALID_URL), opened_at: value });
    await expectError(res, 400);
    expect(tableCounts(db)).toEqual([0, 0, 0, 0, 0]);
  });

  it.each(["2026-03-01T12:00:00+14:00", "2026-03-01T12:00:00-12:00", "2026-03-01T12:00:00+05:45", "2026-03-01T12:00:00.123456Z"])(
    "fuso real %s continua aceito",
    async (value) => {
      const { post, click } = setup();
      const res = await post("/touches", { install_id: "inst_1", url: click(VALID_URL), opened_at: value });
      expect(res.status).toBe(201);
    },
  );
});

describe("payloads inválidos em POST /touches", () => {
  it.each(badTouchLinks)("%s devolve 400 link_invalido e só registra a abertura recusada", async (_nome, body) => {
    const { post, db } = setup();
    const res = await post("/touches", body);
    await expectError(res.clone(), 400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("link_invalido");
    expect(tableCounts(db)).toEqual([0, 0, 0, 0, 1]);
  });

  it.each(badTouchFields)("%s devolve 400 e não grava nada", async (_nome, body) => {
    const { click, post, db } = setup();
    await expectError(await post("/touches", body), 400);
    expect(tableCounts(db)).toEqual([0, 0, 0, 0, 0]);
  });

  it("opened_at com fuso diferente de Z é aceito e normalizado para UTC", async () => {
    const { click, post } = setup();
    click(VALID_URL);
    const res = await post("/touches", { install_id: "inst_1", url: VALID_URL, opened_at: "2026-03-01T09:00:00-03:00" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { client_opened_at: string }).client_opened_at).toBe("2026-03-01T12:00:00.000Z");
  });
});

describe("rotas, métodos e ids inexistentes", () => {
  it.each([
    ["GET", "/nao-existe"],
    ["DELETE", "/signups/u_1/attribution"],
    ["PUT", "/touches"],
    ["GET", "/touches"],
    ["GET", "/signups/u_nao_existe/attribution"],
  ])("%s %s devolve 404 JSON", async (method, path) => {
    const { click, app } = setup();
    const res = await app.request(path, { method });
    await expectError(res, 404);
  });

  it.each([
    ["emoji", "/signups/%F0%9F%9A%80/attribution"],
    ["5000 caracteres", `/signups/${"a".repeat(5000)}/attribution`],
    ["espaço", "/signups/u%201/attribution"],
  ])("user_id inválido na rota (%s) devolve 400", async (_nome, path) => {
    const { click, get } = setup();
    await expectError(await get(path), 400);
  });

  it.each([
    "/l",
    "/l?src=campanha",
    "/l?src=campanha&cmp=x&src=indicacao",
    "/l?src=campanha&cmp=%00",
    `/l?src=campanha&cmp=${"a".repeat(65)}`,
  ])("GET %s inválido devolve 400", async (path) => {
    const { click, get } = setup();
    await expectError(await get(path), 400);
  });

  it("erro inesperado vira 500 JSON genérico, sem stack trace, e o erro vai para o logger", async () => {
    const lines: string[] = [];
    const { db, app } = setup({ logger: pino({ level: "info" }, { write: (line: string) => void lines.push(line) }) });
    db.close(); // força o sqlite a lançar dentro do handler
    const res = await app.request("/installs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ install_id: "inst_1" }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "erro_interno", message: "erro inesperado" } });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 50, msg: "erro inesperado", method: "POST", path: "/installs", err: { type: "Error" } });
  });

});
