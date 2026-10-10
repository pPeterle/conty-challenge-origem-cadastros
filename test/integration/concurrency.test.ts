import { describe, expect, it } from "vitest";
import { HOUR } from "../../src/clock.ts";
import { campaignLink, referralLink, setup } from "./helpers.ts";

describe("concorrência e idempotência", () => {
  it("50 envios concorrentes do mesmo clique geram um toque só", async () => {
    const { post, db } = setup();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => post("/touches", { install_id: "inst_1", url: campaignLink("clk_aaaa0001") })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
    expect(db.prepare("SELECT COUNT(*) AS n FROM touches").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM installs").get()).toEqual({ n: 1 });
  });

  it("cadastros duplicados concorrentes gravam uma origem só, igual em todas as respostas", async () => {
    const { post, db, clock } = setup();
    await post("/touches", { install_id: "inst_1", url: campaignLink("clk_camp0001") });
    clock.advance(HOUR);
    await post("/touches", { install_id: "inst_1", url: referralLink("clk_ref00001") });

    const results = await Promise.all(
      Array.from({ length: 30 }, () => post("/signups", { user_id: "u_1", install_id: "inst_1" })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const origins = new Set(
      await Promise.all(results.map(async (r) => JSON.stringify(((await r.json()) as { origem: unknown }).origem))),
    );
    expect(origins.size).toBe(1);
    expect(JSON.parse([...origins][0]!)).toMatchObject({ tipo: "indicacao", click_id: "clk_ref00001" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM signups").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM signup_touches").get()).toEqual({ n: 2 });
  });

  it("toques e cadastros misturados em vários installs: um toque por clique, uma origem por cadastro", async () => {
    const { post, db } = setup();
    const installs = Array.from({ length: 10 }, (_, i) => `inst_${i}`);
    await Promise.all(
      installs.flatMap((inst, i) =>
        Array.from({ length: 5 }, () => post("/touches", { install_id: inst, url: campaignLink(`clk_${String(i).padStart(8, "0")}`) })),
      ),
    );
    await Promise.all(installs.flatMap((inst) => [1, 2, 3].map(() => post("/signups", { user_id: `u_${inst}`, install_id: inst }))));
    expect(db.prepare("SELECT COUNT(*) AS n FROM touches").get()).toEqual({ n: 10 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM signups WHERE origin = 'campanha'").get()).toEqual({ n: 10 });
    expect(db.prepare("SELECT COUNT(DISTINCT winning_touch_id) AS n FROM signups").get()).toEqual({ n: 10 });
  });
});
