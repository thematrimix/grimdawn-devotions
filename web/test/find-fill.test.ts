// ABOUTME: Tests fillTagged: the exact max-tagged (true OR) predecessor-closed fill under a capacity,
// ABOUTME: restricted to constellations the base already covers, against brute force and hand cases.
import { test, expect } from "bun:test";
import { buildModel } from "../src/core/model";
import { buildReachCons, covers, selectionSummary, type ReachCon } from "../src/core/reachability";
import { fillTagged } from "../src/core/findFill";
import type { DevotionModel, StarId } from "../src/core/types";
import { mulberry32, randModel } from "./support/reach-oracle";
import { modelOf } from "./support/synthModel";
import doc from "../../data/devotions.json";

const z = [0, 0, 0, 0, 0] as ReachCon["req"];
const T = (m: DevotionModel) => new Set([...m.stars.values()].filter((s) => "t" in s.bonuses).map((s) => s.id));

test("takes the tagged stars that fit, predecessors included", () => {
  const rc: ReachCon[] = [
    { id: "base", size: 1, req: z, grant: [3, 0, 0, 0, 0] },
    { id: "a", size: 3, req: [1, 0, 0, 0, 0], grant: z }, // chain a0 -> a1 -> a2, tagged
    { id: "b", size: 2, req: [9, 0, 0, 0, 0], grant: z }, // tagged but not covered by the base: ineligible
  ];
  const m = modelOf(rc, new Set(["a", "b"]));
  const base = new Set<StarId>(["base:0"]);
  const r = fillTagged(m, rc, base, 2, T(m));
  expect([...r.stars].sort()).toEqual(["a:0", "a:1", "base:0"]);
  expect(r).toMatchObject({ added: 2, tagged: 2 });
});

test("branching predecessors: a deep tagged star pays only its own branch", () => {
  // c: 0 is the root, 1 and 2 hang off 0, 3 hangs off 2. Only star 3 carries the tag.
  const rc: ReachCon[] = [
    { id: "base", size: 1, req: z, grant: [3, 0, 0, 0, 0] },
    { id: "c", size: 4, req: [1, 0, 0, 0, 0], grant: z },
  ];
  const m = modelOf(rc, new Set(), { c: [[], [0], [0], [2]] });
  m.stars.get("c:3" as StarId)!.bonuses = { t: 1 };
  const r = fillTagged(m, rc, new Set<StarId>(["base:0"]), 3, T(m));
  expect([...r.stars].sort()).toEqual(["base:0", "c:0", "c:2", "c:3"]);
  expect(r.tagged).toBe(1);
});

test("extends a partly-taken base constellation with closed stars only", () => {
  const rc: ReachCon[] = [
    { id: "base", size: 1, req: z, grant: [3, 0, 0, 0, 0] },
    { id: "a", size: 3, req: [1, 0, 0, 0, 0], grant: z },
  ];
  const m = modelOf(rc, new Set(["a"]));
  const r = fillTagged(m, rc, new Set<StarId>(["base:0", "a:0"]), 5, T(m));
  expect([...r.stars].sort()).toEqual(["a:0", "a:1", "a:2", "base:0"]);
  expect(r).toMatchObject({ added: 2, tagged: 2 });
});

test("zero capacity, no tags, or nothing eligible returns the base unchanged", () => {
  const rc: ReachCon[] = [
    { id: "base", size: 1, req: z, grant: [3, 0, 0, 0, 0] },
    { id: "a", size: 2, req: [1, 0, 0, 0, 0], grant: z },
  ];
  const m = modelOf(rc, new Set(["a"]));
  const base = new Set<StarId>(["base:0"]);
  for (const r of [fillTagged(m, rc, base, 0, T(m)), fillTagged(m, rc, base, 5, new Set())]) {
    expect([...r.stars]).toEqual(["base:0"]);
    expect(r).toMatchObject({ added: 0, tagged: 0 });
  }
});

/** Brute force: every combination of predecessor-closed subsets over eligible constellations. */
function bruteFill(m: DevotionModel, rc: ReachCon[], base: Set<StarId>, cap: number, t: Set<StarId>) {
  const supply = selectionSummary(m, base).supply;
  const opts: { cost: number; tagged: number }[][] = [];
  for (const c of rc) {
    const con = m.constellations.get(c.id)!;
    const free = con.starIds.filter((s) => !base.has(s));
    if (!free.length || !covers(supply, c.req)) continue;
    const list = [{ cost: 0, tagged: 0 }];
    for (let mask = 1; mask < 1 << free.length; mask++) {
      const pick = new Set(free.filter((_, i) => mask & (1 << i)));
      const closed = [...pick].every((s) => m.stars.get(s)!.predecessors.every((p) => base.has(p) || pick.has(p)));
      if (closed) list.push({ cost: pick.size, tagged: [...pick].filter((s) => t.has(s)).length });
    }
    opts.push(list);
  }
  let best = { tagged: 0, cost: 0 };
  const rec = (i: number, cost: number, tagged: number) => {
    if (cost > cap) return;
    if (i === opts.length) {
      if (tagged > best.tagged || (tagged === best.tagged && cost < best.cost)) best = { tagged, cost };
      return;
    }
    for (const o of opts[i]!) rec(i + 1, cost + o.cost, tagged + o.tagged);
  };
  rec(0, 0, 0);
  return best;
}

test("brute force: max tagged, then fewest stars, on random small models", () => {
  const rng = mulberry32(20261009);
  let checked = 0;
  for (let trial = 0; trial < 150; trial++) {
    const { cons: rc } = randModel(rng);
    const tagged = new Set(rc.filter(() => rng() < 0.4).map((c) => c.id));
    const m = modelOf(rc, tagged);
    const pick = rc.filter(() => rng() < 0.4);
    const base = new Set(pick.flatMap((c) => m.constellations.get(c.id)!.starIds));
    const cap = 1 + Math.floor(rng() * 7);
    const truth = bruteFill(m, rc, base, cap, T(m));
    const r = fillTagged(m, rc, base, cap, T(m));
    expect(r.tagged).toBe(truth.tagged);
    expect(r.added).toBe(truth.cost);
    for (const s of base) expect(r.stars.has(s)).toBe(true);
    checked++;
  }
  expect(checked).toBe(150);
});

test("real map: every filled star's predecessors are in the result", () => {
  const model = buildModel(doc as any);
  const cons = buildReachCons(model);
  const base = new Set<StarId>([
    ...model.constellations.get("crossroads_eldritch")!.starIds,
    ...model.constellations.get("akeron_s_scorpion")!.starIds,
  ]);
  const t = new Set([...model.stars.values()].filter((s) => "offensivePhysicalModifier" in s.bonuses).map((s) => s.id));
  const r = fillTagged(model, cons, base, 12, t);
  for (const s of r.stars) for (const p of model.stars.get(s)!.predecessors) expect(r.stars.has(p)).toBe(true);
  expect(r.added).toBeLessThanOrEqual(12);
});
