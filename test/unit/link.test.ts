import { describe, expect, it } from "vitest";
import { buildAppLink, parseAppLink, parseLinkParams } from "../../src/link.ts";

const q = (s: string) => new URLSearchParams(s);

describe("contrato do link", () => {
  it("aceita link de campanha e guarda só os parâmetros conhecidos", () => {
    const r = parseLinkParams(q("src=campanha&cmp=cmp_123&ch=instagram&utm_x=lixo"));
    expect(r).toEqual({ ok: true, value: { source: "campanha", params: { cmp: "cmp_123", ch: "instagram" } } });
  });

  it("aceita link de indicação com ref", () => {
    expect(parseLinkParams(q("src=indicacao&ref=MARIA2026"))).toEqual({
      ok: true,
      value: { source: "indicacao", params: { ref: "MARIA2026" } },
    });
  });

  it("rejeita fonte desconhecida e parâmetro obrigatório ausente", () => {
    expect(parseLinkParams(q("src=google")).ok).toBe(false);
    expect(parseLinkParams(q("src=indicacao")).ok).toBe(false);
    expect(parseLinkParams(q("src=comunidade&com=a b")).ok).toBe(false);
  });

  it("link do app ida e volta: build + parse preserva fonte, parâmetros e cid", () => {
    const url = buildAppLink("https://conty.app/abrir", { source: "comunidade", params: { com: "grupo_ugc" } }, "clk_abc12345");
    expect(url).toBe("https://conty.app/abrir?src=comunidade&com=grupo_ugc&cid=clk_abc12345");
    expect(parseAppLink(url)).toEqual({
      ok: true,
      value: { source: "comunidade", params: { com: "grupo_ugc" }, clickId: "clk_abc12345" },
    });
  });

  it("link do app sem cid é rejeitado", () => {
    expect(parseAppLink("https://conty.app/abrir?src=campanha&cmp=x")).toMatchObject({ ok: false });
  });
});
