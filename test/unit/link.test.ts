import { describe, expect, it } from "vitest";
import { buildAppLink, parseAppLink, queryToObject } from "../../src/link.ts";
import { linkQuerySchema } from "../../src/schemas.ts";

const BASE = "https://conty.app/abrir";
const q = (s: string) => linkQuerySchema.safeParse(queryToObject(new URLSearchParams(s)));

describe("contrato do link", () => {
  it("aceita link de campanha e guarda só os parâmetros da fonte", () => {
    const r = q("src=campanha&cmp=cmp_123&ch=instagram&utm_x=lixo&ref=OUTRO");
    expect(r.success && r.data).toEqual({ source: "campanha", params: { cmp: "cmp_123", ch: "instagram" } });
  });

  it("aceita link de indicação com ref", () => {
    const r = q("src=indicacao&ref=MARIA2026");
    expect(r.success && r.data).toEqual({ source: "indicacao", params: { ref: "MARIA2026" } });
  });

  it("rejeita fonte desconhecida, parâmetro obrigatório ausente, valor inválido e chave repetida", () => {
    expect(q("src=google").success).toBe(false);
    expect(q("src=indicacao").success).toBe(false);
    expect(q("src=comunidade&com=a b").success).toBe(false);
    expect(q("src=campanha&cmp=x&src=indicacao").success).toBe(false);
  });

  it("parâmetro obrigatório ausente explica o campo", () => {
    const r = q("src=indicacao");
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]).toMatchObject({ path: ["ref"], message: "obrigatório em link de indicacao" });
  });

  it("link do app ida e volta: build + parse preserva fonte, parâmetros e cid", () => {
    const url = buildAppLink(BASE, { source: "comunidade", params: { com: "grupo_ugc" } }, "clk_abc12345");
    expect(url).toBe("https://conty.app/abrir?src=comunidade&com=grupo_ugc&cid=clk_abc12345");
    expect(parseAppLink(url, BASE)).toEqual({
      ok: true,
      value: { source: "comunidade", params: { com: "grupo_ugc" }, clickId: "clk_abc12345" },
    });
  });

  it("link do app sem cid é rejeitado", () => {
    expect(parseAppLink("https://conty.app/abrir?src=campanha&cmp=x", BASE)).toMatchObject({ ok: false });
  });

  it("link de outro host ou caminho é rejeitado", () => {
    expect(parseAppLink("https://evil.example/abrir?src=campanha&cmp=x&cid=clk_eeee0001", BASE)).toMatchObject({ ok: false });
    expect(parseAppLink("https://conty.app/outro?src=campanha&cmp=x&cid=clk_eeee0001", BASE)).toMatchObject({ ok: false });
    expect(parseAppLink("http://conty.app/abrir?src=campanha&cmp=x&cid=clk_eeee0001", BASE)).toMatchObject({ ok: false });
  });
});
