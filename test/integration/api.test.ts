import { describe, expect, it } from "vitest";
import { DAY, HOUR, MINUTE } from "../../src/clock.ts";
import { START, campaignLink, communityLink, referralLink, setup } from "./helpers.ts";

type Attribution = {
  origem: { tipo: string; motivo: string; click_id: string | null; params: Record<string, string> | null };
  regra: { nome: string; janela_horas: number; janela_inicio: string | null; janela_fim: string | null; desempate: string[] };
  toques_considerados: { click_id: string; source: string; resultado: string; motivo: string; touched_at: string }[];
  toques_apos_cadastro: { click_id: string; resultado: string; motivo: string }[];
};

describe("contrato do link (redirecionador)", () => {
  it("link de campanha redireciona para o app com cid novo a cada clique", async () => {
    const { get } = setup();
    const r1 = await get("/l?src=campanha&cmp=cmp_123&ch=instagram");
    const r2 = await get("/l?src=campanha&cmp=cmp_123&ch=instagram");
    expect(r1.status).toBe(302);
    expect(r1.headers.get("location")).toBe("https://conty.app/abrir?src=campanha&cmp=cmp_123&ch=instagram&cid=clk_test0001");
    expect(r2.headers.get("location")).toBe("https://conty.app/abrir?src=campanha&cmp=cmp_123&ch=instagram&cid=clk_test0002");
  });

  it("link de indicação redireciona com ref e cid", async () => {
    const { get } = setup();
    const r = await get("/l?src=indicacao&ref=MARIA2026");
    expect(r.headers.get("location")).toBe("https://conty.app/abrir?src=indicacao&ref=MARIA2026&cid=clk_test0001");
  });

  it("link inválido devolve 400 com erro em JSON", async () => {
    const { get } = setup();
    const r = await get("/l?src=indicacao");
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({
      error: {
        code: "link_invalido",
        message: "link inválido: ref: obrigatório em link de indicacao",
        details: [{ campo: "ref", motivo: "obrigatório em link de indicacao" }],
      },
    });
  });
});

describe("primeira abertura", () => {
  it("repetir o registro de primeira abertura não muda first_open_at", async () => {
    const { post, clock } = setup();
    const a = await post("/installs", { install_id: "inst_1" });
    clock.advance(HOUR);
    const b = await post("/installs", { install_id: "inst_1" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({
      install_id: "inst_1",
      first_open_at: START,
      first_open_source: "servidor",
      server_first_open_at: START,
      device_first_open_at: null,
      novo: false,
    });
  });

  it("app que abriu offline: a janela conta do first_open_at informado pelo aparelho", async () => {
    const { post, clock } = setup();
    clock.advance(5 * DAY); // abriu em START sem rede; o POST /installs só chega 5 dias depois
    const inst = await post("/installs", { install_id: "inst_1", first_open_at: START });
    expect(await inst.json()).toMatchObject({
      first_open_at: START,
      first_open_source: "aparelho",
      server_first_open_at: "2026-03-06T12:00:00.000Z",
      device_first_open_at: START,
    });
    clock.advance(3 * DAY); // dia 8 contado do aparelho: fora da janela de 7 dias
    await post("/touches", { install_id: "inst_1", url: campaignLink("clk_aaaa0001") });
    const body = (await (await post("/signups", { user_id: "u_1", install_id: "inst_1" })).json()) as Attribution;
    expect(body.regra).toMatchObject({ janela_inicio: START, janela_inicio_fonte: "aparelho" });
    expect(body.origem).toMatchObject({ tipo: "organico", motivo: "cadastro_apos_janela" });
  });

  it.each([
    ["no futuro além da tolerância de 5 min", "2026-03-01T12:06:00.000Z"],
    ["mais antigo que 30 dias", "2026-01-29T12:00:00.000Z"],
  ])("first_open_at do aparelho %s é ignorado e vale o horário do servidor", async (_nome, deviceAt) => {
    const { post } = setup();
    const r = await post("/installs", { install_id: "inst_1", first_open_at: deviceAt });
    expect(await r.json()).toMatchObject({
      first_open_at: START,
      first_open_source: "servidor",
      device_first_open_at: deviceAt,
    });
  });

  it("toque que chegou antes do POST /installs: o first_open_at do aparelho ainda corrige o início, uma vez só", async () => {
    const { post, clock } = setup();
    clock.advance(HOUR);
    await post("/touches", { install_id: "inst_1", url: campaignLink("clk_aaaa0001") });
    const r = await post("/installs", { install_id: "inst_1", first_open_at: START });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ first_open_at: START, first_open_source: "aparelho" });
    const again = await post("/installs", { install_id: "inst_1", first_open_at: "2026-02-27T12:00:00.000Z" });
    expect(await again.json()).toMatchObject({ first_open_at: START, device_first_open_at: START });
  });

  it("toque que chega antes do registro de primeira abertura registra o install com o horário dele", async () => {
    const { post, get } = setup();
    await post("/touches", { install_id: "inst_1", url: campaignLink("clk_aaaa0001") });
    await post("/signups", { user_id: "u_1", install_id: "inst_1" });
    const body = (await (await get("/signups/u_1/attribution")).json()) as Attribution;
    expect(body.regra.janela_inicio).toBe(START);
  });
});

describe("toques e clique repetido", () => {
  it("o mesmo clique reenviado não cria segundo toque nem segunda origem", async () => {
    const { post, clock, db } = setup();
    await post("/installs", { install_id: "inst_1" });
    const first = await post("/touches", { install_id: "inst_1", url: campaignLink("clk_aaaa0001") });
    clock.advance(MINUTE);
    const again = await post("/touches", { install_id: "inst_1", url: campaignLink("clk_aaaa0001") });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ click_id: "clk_aaaa0001", duplicado: true, touched_at: START });
    expect(db.prepare("SELECT COUNT(*) AS n FROM touches").get()).toEqual({ n: 1 });

    const signup = (await (await post("/signups", { user_id: "u_1", install_id: "inst_1" })).json()) as Attribution;
    expect(signup.toques_considerados).toHaveLength(1);
    expect(signup.origem.tipo).toBe("campanha");
  });

  it("click_id de outro install devolve 409, mas a abertura do segundo install fica registrada", async () => {
    const { post, db } = setup();
    await post("/touches", { install_id: "inst_1", url: campaignLink("clk_aaaa0001") });
    const r = await post("/touches", { install_id: "inst_2", url: campaignLink("clk_aaaa0001") });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("click_de_outro_install");
    expect(db.prepare("SELECT install_id FROM installs ORDER BY install_id").all()).toEqual([
      { install_id: "inst_1" },
      { install_id: "inst_2" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM touches").get()).toEqual({ n: 1 });
  });

  it("toque sem cid ou com payload inválido devolve 400", async () => {
    const { post } = setup();
    expect((await post("/touches", { install_id: "inst_1", url: "https://conty.app/abrir?src=campanha&cmp=x" })).status).toBe(400);
    expect((await post("/touches", { install_id: "inst 1", url: campaignLink("clk_aaaa0001") })).status).toBe(400);
    expect(
      (await post("/touches", { install_id: "inst_1", url: campaignLink("clk_aaaa0001"), opened_at: "ontem" })).status,
    ).toBe(400);
  });
});

describe("cadastro e auditoria", () => {
  it("dois links diferentes antes do cadastro: vence o mais recente e o outro aparece como perdedor", async () => {
    const { post, get, clock } = setup();
    await post("/installs", { install_id: "inst_1" });
    clock.advance(HOUR);
    await post("/touches", { install_id: "inst_1", url: campaignLink("clk_camp0001") });
    clock.advance(2 * HOUR);
    await post("/touches", { install_id: "inst_1", url: referralLink("clk_ref00001") });
    clock.advance(HOUR);
    const created = await post("/signups", { user_id: "u_1", install_id: "inst_1" });
    expect(created.status).toBe(201);

    const body = (await (await get("/signups/u_1/attribution")).json()) as Attribution;
    expect(body.origem).toEqual({
      tipo: "indicacao",
      motivo: "toque_mais_recente_na_janela",
      click_id: "clk_ref00001",
      params: { ref: "MARIA2026" },
    });
    expect(body.toques_considerados.map((t) => [t.click_id, t.resultado, t.motivo])).toEqual([
      ["clk_camp0001", "perdeu", "perdeu_para_toque_mais_recente"],
      ["clk_ref00001", "venceu", "toque_mais_recente_na_janela"],
    ]);
  });

  it("empate de horário: campanha vence indicação e comunidade, com motivo de desempate", async () => {
    const { post } = setup();
    // Relógio parado: os três toques têm o mesmo milissegundo.
    await post("/touches", { install_id: "inst_1", url: communityLink("clk_com00001") });
    await post("/touches", { install_id: "inst_1", url: referralLink("clk_ref00001") });
    await post("/touches", { install_id: "inst_1", url: campaignLink("clk_camp0001") });
    const body = (await (await post("/signups", { user_id: "u_1", install_id: "inst_1" })).json()) as Attribution;
    expect(body.origem.tipo).toBe("campanha");
    expect(body.origem.motivo).toBe("venceu_empate_por_prioridade");
    expect(body.toques_considerados.filter((t) => t.resultado === "perdeu").map((t) => t.motivo)).toEqual([
      "empate_desfeito_por_prioridade",
      "empate_desfeito_por_prioridade",
    ]);
  });

  it.each([
    [["com", "ref", "camp"]],
    [["com", "camp", "ref"]],
    [["ref", "com", "camp"]],
    [["ref", "camp", "com"]],
    [["camp", "com", "ref"]],
    [["camp", "ref", "com"]],
  ])("ordem de chegada %j com o mesmo horário não muda a origem", async (order) => {
    const { post } = setup();
    const urls: Record<string, string> = {
      com: communityLink("clk_com00001"),
      ref: referralLink("clk_ref00001"),
      camp: campaignLink("clk_camp0001"),
    };
    for (const k of order) await post("/touches", { install_id: "inst_1", url: urls[k] });
    const body = (await (await post("/signups", { user_id: "u_1", install_id: "inst_1" })).json()) as Attribution;
    expect(body.origem).toMatchObject({ tipo: "campanha", click_id: "clk_camp0001", motivo: "venceu_empate_por_prioridade" });
  });

  it("toque fora da janela (medida do first_open_at) não vence: cadastro fora da janela vira orgânico", async () => {
    const { post, clock } = setup({ windowMs: 7 * DAY });
    await post("/installs", { install_id: "inst_1" });
    clock.advance(DAY);
    await post("/touches", { install_id: "inst_1", url: communityLink("clk_com00001") });
    clock.advance(7 * DAY); // first_open + 8 dias: fora da janela
    await post("/touches", { install_id: "inst_1", url: campaignLink("clk_camp0001") });
    const body = (await (await post("/signups", { user_id: "u_1", install_id: "inst_1" })).json()) as Attribution;
    expect(body.origem).toEqual({ tipo: "organico", motivo: "cadastro_apos_janela", click_id: null, params: null });
    expect(body.regra).toEqual({
      nome: "last_touch",
      versao: "last_touch_v1",
      janela_horas: 168,
      janela_inicio: START,
      janela_inicio_fonte: "servidor",
      janela_fim: "2026-03-08T12:00:00.000Z",
      desempate: ["campanha", "indicacao", "comunidade", "click_id"],
    });
    expect(body.toques_considerados.map((t) => [t.click_id, t.resultado, t.motivo])).toEqual([
      ["clk_com00001", "perdeu", "cadastro_apos_janela"],
      ["clk_camp0001", "perdeu", "cadastro_apos_janela"],
    ]);
  });

  it("cadastro após o fim da janela vira orgânico", async () => {
    const { post, clock } = setup({ windowMs: 7 * DAY });
    await post("/installs", { install_id: "inst_1" });
    clock.advance(DAY);
    await post("/touches", { install_id: "inst_1", url: campaignLink("clk_camp0001") });
    clock.advance(59 * DAY);
    const body = (await (await post("/signups", { user_id: "u_1", install_id: "inst_1" })).json()) as Attribution;
    expect(body.origem).toMatchObject({ tipo: "organico", motivo: "cadastro_apos_janela" });
  });

  it("toque e cadastro no último milissegundo da janela ainda contam", async () => {
    const { post, clock } = setup({ windowMs: 7 * DAY });
    await post("/installs", { install_id: "inst_1" });
    clock.advance(7 * DAY);
    await post("/touches", { install_id: "inst_1", url: campaignLink("clk_camp0001") });
    const body = (await (await post("/signups", { user_id: "u_1", install_id: "inst_1" })).json()) as Attribution;
    expect(body.origem).toMatchObject({ tipo: "campanha", click_id: "clk_camp0001" });
  });

  it("toque posterior ao cadastro é registrado, aparece na auditoria e não altera a origem", async () => {
    const { post, get, clock } = setup();
    await post("/touches", { install_id: "inst_1", url: communityLink("clk_com00001") });
    clock.advance(HOUR);
    await post("/signups", { user_id: "u_1", install_id: "inst_1" });
    clock.advance(HOUR);
    const late = await post("/touches", { install_id: "inst_1", url: campaignLink("clk_camp0001") });
    expect(late.status).toBe(201);

    const body = (await (await get("/signups/u_1/attribution")).json()) as Attribution;
    expect(body.origem.tipo).toBe("comunidade");
    expect(body.toques_considerados.map((t) => t.click_id)).toEqual(["clk_com00001"]);
    expect(body.toques_apos_cadastro).toMatchObject([
      { click_id: "clk_camp0001", resultado: "perdeu", motivo: "posterior_ao_cadastro", relogio_diverge: false },
    ]);
  });

  it("toque entregue depois do cadastro com opened_at anterior: relogio_diverge, sem mudar a origem", async () => {
    const { post, get, clock } = setup();
    await post("/installs", { install_id: "inst_1" });
    clock.advance(HOUR);
    await post("/signups", { user_id: "u_1", install_id: "inst_1" });
    clock.advance(MINUTE);
    await post("/touches", { install_id: "inst_1", url: referralLink("clk_ref00001"), opened_at: "2026-03-01T12:30:00.000Z" });
    const body = (await (await get("/signups/u_1/attribution")).json()) as Attribution;
    expect(body.origem.tipo).toBe("organico");
    expect(body.toques_apos_cadastro).toMatchObject([{ click_id: "clk_ref00001", relogio_diverge: true }]);
  });

  it("cada cadastro grava a versão da regra que o decidiu e a auditoria mostra", async () => {
    const { post, get, db } = setup();
    await post("/signups", { user_id: "u_1", install_id: "inst_1" });
    expect(db.prepare("SELECT rule_version FROM signups").get()).toEqual({ rule_version: "last_touch_v1" });
    const body = (await (await get("/signups/u_1/attribution")).json()) as { regra: { versao: string } };
    expect(body.regra.versao).toBe("last_touch_v1");
  });

  it("cadastro sem toque fica orgânico com motivo sem_toques gravado", async () => {
    const { post, db } = setup();
    await post("/installs", { install_id: "inst_1" });
    const body = (await (await post("/signups", { user_id: "u_1", install_id: "inst_1" })).json()) as Attribution;
    expect(body.origem).toEqual({ tipo: "organico", motivo: "sem_toques", click_id: null, params: null });
    expect(db.prepare("SELECT origin, reason FROM signups WHERE user_id = 'u_1'").get()).toEqual({
      origin: "organico",
      reason: "sem_toques",
    });
  });

  it("cadastro de install nunca visto fica orgânico com motivo install_desconhecido", async () => {
    const { post } = setup();
    const body = (await (await post("/signups", { user_id: "u_1", install_id: "inst_x" })).json()) as Attribution;
    expect(body.origem).toMatchObject({ tipo: "organico", motivo: "install_desconhecido" });
    expect(body.regra.janela_inicio).toBeNull();
  });

  it("cadastro repetido devolve a mesma decisão, mesmo com toque novo no meio", async () => {
    const { post, clock } = setup();
    await post("/touches", { install_id: "inst_1", url: communityLink("clk_com00001") });
    const first = await post("/signups", { user_id: "u_1", install_id: "inst_1" });
    clock.advance(MINUTE);
    await post("/touches", { install_id: "inst_1", url: campaignLink("clk_camp0001") });
    const again = await post("/signups", { user_id: "u_1", install_id: "inst_1" });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    const a = (await first.json()) as Attribution;
    const b = (await again.json()) as Attribution;
    expect(b.origem).toEqual(a.origem);
    expect(b.toques_considerados).toEqual(a.toques_considerados);
  });

  it("mesmo user_id vindo de outro install devolve 409", async () => {
    const { post } = setup();
    await post("/signups", { user_id: "u_1", install_id: "inst_1" });
    const r = await post("/signups", { user_id: "u_1", install_id: "inst_2" });
    expect(r.status).toBe(409);
  });

  it("segundo cadastro no mesmo aparelho não reaproveita o clique que já virou origem", async () => {
    const { post, clock } = setup();
    await post("/touches", { install_id: "inst_1", url: communityLink("clk_com00001") });
    clock.advance(HOUR);
    await post("/touches", { install_id: "inst_1", url: referralLink("clk_ref00001") });
    const a = (await (await post("/signups", { user_id: "u_1", install_id: "inst_1" })).json()) as Attribution;
    const b = (await (await post("/signups", { user_id: "u_2", install_id: "inst_1" })).json()) as Attribution;
    expect(a.origem.click_id).toBe("clk_ref00001");
    expect(b.origem.click_id).toBe("clk_com00001");
    expect(b.toques_considerados.find((t) => t.click_id === "clk_ref00001")?.motivo).toBe("ja_usado_em_outro_cadastro");
  });

  it("auditoria de cadastro inexistente devolve 404", async () => {
    const { get } = setup();
    const r = await get("/signups/nao_existe/attribution");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: { code: "cadastro_nao_encontrado", message: "cadastro não encontrado" } });
  });

  it("cadastro sem user_id devolve 400", async () => {
    const { post } = setup();
    expect((await post("/signups", { install_id: "inst_1" })).status).toBe(400);
  });
});
