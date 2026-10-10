import { describe, expect, it } from "vitest";
import { DAY, HOUR, MINUTE } from "../../src/clock.ts";
import { decideAttribution, type DecisionInput, type TouchInput } from "../../src/attribution.ts";

const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const base = (touches: TouchInput[], over: Partial<DecisionInput> = {}): DecisionInput => ({
  firstOpenAt: T0,
  signupAt: T0 + 2 * DAY,
  windowMs: 7 * DAY,
  touches,
  ...over,
});
const touch = (id: number, source: TouchInput["source"], at: number, clickId = `clk_${id}`): TouchInput => ({
  id,
  clickId,
  source,
  touchedAt: at,
});

describe("decideAttribution", () => {
  it("dois links diferentes antes do cadastro: vence o mais recente", () => {
    const d = decideAttribution(
      base([touch(1, "campanha", T0 + HOUR), touch(2, "indicacao", T0 + 3 * HOUR)]),
    );
    expect(d.origin).toBe("indicacao");
    expect(d.winnerTouchId).toBe(2);
    expect(d.reason).toBe("toque_mais_recente_na_janela");
    expect(d.verdicts).toEqual([
      { touchId: 1, result: "perdeu", reason: "perdeu_para_toque_mais_recente" },
      { touchId: 2, result: "venceu", reason: "toque_mais_recente_na_janela" },
    ]);
  });

  it("empate de horário entre fontes diferentes: campanha > indicacao > comunidade", () => {
    const at = T0 + HOUR;
    const d = decideAttribution(
      base([touch(1, "comunidade", at), touch(2, "indicacao", at), touch(3, "campanha", at)]),
    );
    expect(d.origin).toBe("campanha");
    expect(d.reason).toBe("venceu_empate_por_prioridade");
    expect(d.verdicts.map((v) => [v.touchId, v.reason])).toEqual([
      [1, "empate_desfeito_por_prioridade"],
      [2, "empate_desfeito_por_prioridade"],
      [3, "venceu_empate_por_prioridade"],
    ]);
  });

  it("empate de horário e de fonte: menor click_id vence, para ser determinístico", () => {
    const at = T0 + HOUR;
    const a = decideAttribution(base([touch(1, "campanha", at, "clk_b"), touch(2, "campanha", at, "clk_a")]));
    const b = decideAttribution(base([touch(2, "campanha", at, "clk_a"), touch(1, "campanha", at, "clk_b")]));
    expect(a.winnerTouchId).toBe(2);
    expect(b.winnerTouchId).toBe(2);
    expect(a.reason).toBe("venceu_empate_por_click_id");
    expect(a.verdicts.find((v) => v.touchId === 1)?.reason).toBe("empate_desfeito_por_click_id");
  });

  it("prioridade só desempata horário igual: toque mais recente de comunidade vence campanha antiga", () => {
    const d = decideAttribution(base([touch(1, "campanha", T0 + HOUR), touch(2, "comunidade", T0 + HOUR + 1)]));
    expect(d.origin).toBe("comunidade");
  });

  it("toque fora da janela não vence, mesmo sendo o mais recente", () => {
    const d = decideAttribution(
      base([touch(1, "campanha", T0 + HOUR), touch(2, "indicacao", T0 + 8 * DAY)], { signupAt: T0 + 9 * DAY }),
    );
    expect(d.origin).toBe("campanha");
    expect(d.verdicts[1]).toEqual({ touchId: 2, result: "perdeu", reason: "fora_da_janela" });
  });

  it("janela é medida do first_open_at e o limite é inclusivo", () => {
    const end = T0 + 7 * DAY;
    const inside = decideAttribution(base([touch(1, "campanha", end)], { signupAt: end + MINUTE }));
    const outside = decideAttribution(base([touch(1, "campanha", end + 1)], { signupAt: end + MINUTE }));
    expect(inside.origin).toBe("campanha");
    expect(inside.windowStart).toBe(T0);
    expect(inside.windowEnd).toBe(end);
    expect(outside.origin).toBe("organico");
    expect(outside.reason).toBe("nenhum_toque_valido");
  });

  it("toque posterior ao cadastro não vence", () => {
    const d = decideAttribution(base([touch(1, "comunidade", T0 + HOUR), touch(2, "campanha", T0 + 3 * DAY)]));
    expect(d.origin).toBe("comunidade");
    expect(d.verdicts[1]?.reason).toBe("posterior_ao_cadastro");
  });

  it("toque no mesmo milissegundo do cadastro ainda conta", () => {
    const signupAt = T0 + DAY;
    expect(decideAttribution(base([touch(1, "indicacao", signupAt)], { signupAt })).origin).toBe("indicacao");
  });

  it("toque que já foi origem de outro cadastro não vence de novo", () => {
    const d = decideAttribution(
      base([{ ...touch(1, "campanha", T0 + 2 * HOUR), usedBySignup: "u_1" }, touch(2, "indicacao", T0 + HOUR)]),
    );
    expect(d.origin).toBe("indicacao");
    expect(d.verdicts[0]?.reason).toBe("ja_usado_em_outro_cadastro");
  });

  it("sem toques: orgânico com motivo sem_toques", () => {
    const d = decideAttribution(base([]));
    expect(d).toMatchObject({ origin: "organico", winnerTouchId: null, reason: "sem_toques", verdicts: [] });
  });

  it("install desconhecido: orgânico com motivo install_desconhecido", () => {
    const d = decideAttribution(base([], { firstOpenAt: null }));
    expect(d).toMatchObject({ origin: "organico", reason: "install_desconhecido", windowStart: null });
  });

  it("toque anterior à primeira abertura não vence (defensivo)", () => {
    const d = decideAttribution(base([touch(1, "campanha", T0 - 1)]));
    expect(d.verdicts[0]?.reason).toBe("anterior_a_primeira_abertura");
    expect(d.origin).toBe("organico");
  });

  it("resultado não depende da ordem de entrada", () => {
    const ts = [touch(1, "campanha", T0 + HOUR), touch(2, "indicacao", T0 + HOUR), touch(3, "comunidade", T0)];
    const a = decideAttribution(base(ts));
    const b = decideAttribution(base([...ts].reverse()));
    expect(a.winnerTouchId).toBe(b.winnerTouchId);
    expect(a.reason).toBe(b.reason);
  });
});
