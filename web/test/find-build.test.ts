// ABOUTME: Tests findBuild: the three modes (cheapest, cheapest + fill, most attributes) with true-OR tags,
// ABOUTME: verified orders, dropping, the no-tag and zero-capacity edges, and the per-constellation delta.
import { test, expect, describe } from "bun:test";
import { buildCoverTable, buildReachCons, selectionSummary, type ReachCon } from "../src/core/reachability";
import { findBuild, selectionDelta, type FindPlan } from "../src/core/findBuild";
import { findSupport, taggedStars, verifiedOrder } from "../src/core/supportFinder";
import { verifyBuildOrder } from "../src/core/orderLegality";
import { buildModel } from "../src/core/model";
import type { DevotionModel, StarId } from "../src/core/types";
import { mulberry32, randModel } from "./support/reach-oracle";
import { modelOf } from "./support/synthModel";
import doc from "../../data/devotions.json";

const model = buildModel(doc as any);
const cons = buildReachCons(model);
const table = buildCoverTable(cons);
const whole = (m: DevotionModel, ...ids: string[]) => new Set(ids.flatMap((id) => m.constellations.get(id)!.starIds));
const plan = (r: ReturnType<typeof findBuild>): FindPlan => {
  expect(r.kind).toBe("found");
  return r as FindPlan;
};
const legal = (m: DevotionModel, rc: ReachCon[], p: FindPlan, cap: number) =>
  expect(verifyBuildOrder(rc, selectionSummary(m, p.stars).built, p.order, cap)).toBeNull();
// The user's OR example: physical resistance, all damage, armor absorption.
const OR_TAGS = ["defensivePhysical", "offensiveTotalDamageModifier", "defensiveAbsorptionModifier"];

describe("findBuild on the real map", () => {
  test("cheapest mode equals findSupport", () => {
    const core = whole(model, "oleron");
    const p = plan(findBuild(model, cons, table, core, 55, OR_TAGS, "cheapest"));
    const s = findSupport(model, cons, table, core, 55, OR_TAGS);
    expect(s.kind).toBe("found");
    if (s.kind === "found") expect([...p.stars].sort()).toEqual([...s.stars].sort());
    expect(p.mode).toBe("cheapest");
    legal(model, cons, p, 55);
  });

  test("fill spends leftover points on OR-tagged stars and stays legal", () => {
    const core = whole(model, "oleron");
    const cheap = plan(findBuild(model, cons, table, core, 55, OR_TAGS, "cheapest"));
    const fill = plan(findBuild(model, cons, table, core, 55, OR_TAGS, "fill"));
    expect(fill.mode).toBe("fill");
    expect(fill.tagged).toBeGreaterThan(cheap.tagged);
    for (const s of cheap.stars) expect(fill.stars.has(s)).toBe(true);
    expect(fill.stars.size).toBeLessThanOrEqual(55);
    legal(model, cons, fill, 55);
  });

  test("true OR: a star carrying two tags counts once, one carrying one tag counts once", () => {
    const t = taggedStars(model, OR_TAGS);
    const p = plan(findBuild(model, cons, table, whole(model, "oleron"), 55, OR_TAGS, "fill"));
    expect(p.tagged).toBe([...p.stars].filter((s) => !p.core.has(s) && t.has(s)).length);
  });

  test("attributes mode scores at least as well as fill mode", () => {
    for (const id of ["oleron", "light_of_empyrion", "crab"]) {
      const core = whole(model, id);
      const fill = plan(findBuild(model, cons, table, core, 55, OR_TAGS, "fill"));
      const attr = plan(findBuild(model, cons, table, core, 55, OR_TAGS, "attributes"));
      expect(attr.tagged).toBeGreaterThanOrEqual(fill.tagged);
      legal(model, cons, attr, 55);
    }
  }, 60_000);

  test("no scoring tags: fill and attributes return the cheapest result", () => {
    const core = whole(model, "oleron");
    const cheap = plan(findBuild(model, cons, table, core, 55, [], "cheapest"));
    for (const tags of [[], ["aff:grant:chaos"]])
      for (const mode of ["fill", "attributes"] as const) {
        const p = plan(findBuild(model, cons, table, core, 55, tags, mode));
        expect([...p.stars].sort()).toEqual([...cheap.stars].sort());
        expect(p.mode).toBe("cheapest");
      }
  });

  test("cap equal to the cheapest build's size: fill adds nothing and does not fail", () => {
    const core = whole(model, "oleron");
    const cheap = plan(findBuild(model, cons, table, core, 55, OR_TAGS, "cheapest"));
    const cap = Math.max(cheap.stars.size, cheap.peak);
    const p = plan(findBuild(model, cons, table, core, cap, OR_TAGS, "fill"));
    expect(p.stars.size).toBeLessThanOrEqual(cap);
    legal(model, cons, p, cap);
  });

  test("a complete core in cheapest mode returns the core itself", () => {
    const core = plan(findBuild(model, cons, table, whole(model, "oleron"), 55, [], "cheapest")).stars;
    const p = plan(findBuild(model, cons, table, core, 55, [], "cheapest"));
    expect(p.addedStars).toBe(0);
    expect([...p.stars].sort()).toEqual([...core].sort());
  });

  test("an uncapped request returns none instead of searching", () => {
    expect(findBuild(model, cons, table, whole(model, "oleron"), Infinity, [], "cheapest").kind).toBe("none");
  });

  test("deterministic for a permuted core", () => {
    const core = whole(model, "oleron", "hammer");
    const a = plan(findBuild(model, cons, table, core, 55, OR_TAGS, "attributes"));
    const b = plan(findBuild(model, cons, table, new Set([...core].reverse()), 55, OR_TAGS, "attributes"));
    expect([...b.stars].sort()).toEqual([...a.stars].sort());
    expect(b.order).toEqual(a.order);
  }, 30_000);
});

describe("dropping", () => {
  test("an unbuildable core drops its smallest constellation and reports it", () => {
    const z = [0, 0, 0, 0, 0] as ReachCon["req"];
    const rc: ReachCon[] = [
      { id: "bad", size: 1, req: [9, 0, 0, 0, 0], grant: z }, // no source of 9 ascendant exists
      { id: "ok", size: 2, req: [1, 0, 0, 0, 0], grant: [2, 0, 0, 0, 0] },
      { id: "x0", size: 1, req: z, grant: [1, 0, 0, 0, 0] },
    ];
    const m = modelOf(rc);
    // "bad" has the fewest core stars, so it is dropped first; the remaining core {ok} is buildable.
    const p = plan(findBuild(m, rc, buildCoverTable(rc), whole(m, "bad", "ok"), 10, [], "cheapest"));
    expect(p.dropped).toEqual(["bad"]);
    expect(p.stars.has("bad:0" as StarId)).toBe(false);
    expect([...p.core].sort()).toEqual(["ok:0", "ok:1"]);
    legal(m, rc, p, 10);
  });
});

describe("attributes on synthetic models", () => {
  test("pays for support to reach a tagged constellation the cheapest build cannot", () => {
    const z = [0, 0, 0, 0, 0] as ReachCon["req"];
    const rc: ReachCon[] = [
      { id: "need", size: 1, req: [1, 0, 0, 0, 0], grant: z },
      { id: "tg", size: 2, req: [0, 0, 3, 0, 0], grant: z }, // tagged, needs 3 eldritch
      { id: "e", size: 2, req: [0, 0, 1, 0, 0], grant: [0, 0, 3, 0, 0] }, // the eldritch source
      ...[0, 1, 2, 3, 4].map((i) => ({
        id: `x${i}`,
        size: 1,
        req: z,
        grant: z.map((_, k) => (k === i ? 1 : 0)) as ReachCon["req"],
      })),
    ];
    const m = modelOf(rc, new Set(["tg"]));
    const t = buildCoverTable(rc);
    const core = whole(m, "need");
    const viaFill = plan(findBuild(m, rc, t, core, 10, ["t"], "fill"));
    expect(viaFill.tagged).toBe(0);
    const p = plan(findBuild(m, rc, t, core, 10, ["t"], "attributes"));
    expect(p.tagged).toBe(2);
    expect(p.stars.has("tg:1" as StarId)).toBe(true);
    expect(p.exhaustive).toBe(true); // both tagged stars taken: the trivial bound is met
    legal(m, rc, p, 10);
  });

  test("never worse than any whole-constellation build with a verified order", () => {
    const rng = mulberry32(20261010);
    for (let trial = 0; trial < 60; trial++) {
      const { cons: rc, budget } = randModel(rng);
      const tagIds = new Set(rc.filter(() => rng() < 0.4).map((c) => c.id));
      const m = modelOf(rc, tagIds);
      const t = buildCoverTable(rc);
      const pick = rc.filter((c) => !c.id.startsWith("x") && rng() < 0.35);
      if (!pick.length) continue;
      const core = whole(m, ...pick.map((c) => c.id));
      const r = findBuild(m, rc, t, core, budget, ["t"], "attributes");
      // Truth: the best tagged count over every whole-constellation superset of the core with a verified order.
      const others = rc.filter((c) => !pick.includes(c));
      let truth = -1;
      for (let mask = 0; mask < 1 << others.length; mask++) {
        const stars = new Set(core);
        for (let i = 0; i < others.length; i++)
          if (mask & (1 << i)) for (const s of m.constellations.get(others[i]!.id)!.starIds) stars.add(s);
        if (stars.size > budget) continue;
        if (!verifiedOrder(rc, t, selectionSummary(m, stars).built, budget)) continue;
        const tagged = [...stars].filter((s) => !core.has(s) && tagIds.has(m.stars.get(s)!.constellationId)).length;
        truth = Math.max(truth, tagged);
      }
      if (truth < 0) continue;
      const p = plan(r);
      const viaFill = plan(findBuild(m, rc, t, core, budget, ["t"], "fill"));
      expect(p.tagged).toBeGreaterThanOrEqual(viaFill.tagged);
      if (p.exhaustive) expect(p.tagged).toBeGreaterThanOrEqual(truth);
      legal(m, rc, p, budget);
    }
  }, 120_000);
});

test("selectionDelta lists per-constellation star count changes in model order", () => {
  const before = new Set<StarId>([...whole(model, "oleron"), ...whole(model, "crane")]);
  const after = new Set<StarId>([
    ...whole(model, "oleron"),
    ...model.constellations.get("hammer")!.starIds.slice(0, 2),
  ]);
  const d = selectionDelta(model, before, after);
  const crane = d.find((x) => x.conId === "crane")!;
  const hammer = d.find((x) => x.conId === "hammer")!;
  expect(crane).toMatchObject({ from: model.constellations.get("crane")!.starIds.length, to: 0 });
  expect(hammer).toMatchObject({ from: 0, to: 2, total: model.constellations.get("hammer")!.starIds.length });
  expect(d.find((x) => x.conId === "oleron")).toBeUndefined();
});
