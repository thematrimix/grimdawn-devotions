// ABOUTME: Tests Find (core/supportFinder): fewest added stars, verified order, benefit tie-break,
// ABOUTME: determinism, partial finishes, brute-force optimality on synthetic models, and the real corpus.
import { test, expect, describe } from "bun:test";
import {
  buildCoverTable,
  buildOrderPath,
  buildReachCons,
  covers,
  selectionMinCost,
  selectionSummary,
  type ReachCon,
} from "../src/core/reachability";
import { findSupport, type FindFound } from "../src/core/supportFinder";
import { gateBuildOrder, verifyBuildOrder } from "../src/core/orderLegality";
import { buildModel } from "../src/core/model";
import type { DevotionModel, StarId } from "../src/core/types";
import { mulberry32, randModel } from "./support/reach-oracle";
import { modelOf } from "./support/synthModel";
import doc from "../../data/devotions.json";
import fixtureJson from "./fixtures/reachable-builds.json";

const SLOW = process.env.REACH_SLOW === "1";
const fixture = fixtureJson as unknown as { cases: { label: string; sel: Record<string, number> }[] };
const model = buildModel(doc as any);
const cons = buildReachCons(model);
const table = buildCoverTable(cons);

const whole = (m: DevotionModel, ...ids: string[]): Set<StarId> =>
  new Set(ids.flatMap((id) => m.constellations.get(id)!.starIds));
const found = (r: ReturnType<typeof findSupport>): FindFound => {
  expect(r.kind).toBe("found");
  return r as FindFound;
};
const membersOf = (m: DevotionModel, stars: Set<StarId>): ReachCon[] => selectionSummary(m, stars).built;

/** Ground truth on a small model: every subset of the other constellations (and of partial finishes,
 *  which here are whole constellations), kept only when it has an oracle-verified order at the cap.
 *  Returns the fewest added stars and the best tagged score at that cost. */
function bruteForce(
  m: DevotionModel,
  rcons: ReachCon[],
  sel: Set<StarId>,
  cap: number,
  tagged: Set<string>,
): { added: number; score: number } | null {
  const t = buildCoverTable(rcons);
  const started = selectionSummary(m, sel).startedIds;
  const others = rcons.filter(
    (c) => !started.has(c.id) || m.constellations.get(c.id)!.starIds.some((s) => !sel.has(s)),
  );
  let best: { added: number; score: number } | null = null;
  for (let mask = 0; mask < 1 << others.length; mask++) {
    const stars = new Set(sel);
    for (let i = 0; i < others.length; i++)
      if (mask & (1 << i)) for (const s of m.constellations.get(others[i]!.id)!.starIds) stars.add(s);
    const added = stars.size - sel.size;
    if (best && added > best.added) continue;
    const st = selectionSummary(m, stars);
    let req = [0, 0, 0, 0, 0] as ReachCon["req"];
    for (const b of st.built) req = req.map((v, k) => Math.max(v, b.req[k]!)) as ReachCon["req"];
    if (!covers(st.supply, req)) continue;
    const members = st.built;
    if (!gateBuildOrder(rcons, members, buildOrderPath(rcons, t, members, cap, 32), cap)) continue;
    let score = 0;
    for (const s of stars) if (!sel.has(s) && tagged.has(m.stars.get(s)!.constellationId)) score++;
    if (!best || added < best.added || score > best.score) best = { added, score };
  }
  return best;
}

describe("findSupport on the real map", () => {
  test("Oleron alone: +24 support, 31 total, proven cheapest", () => {
    const sel = whole(model, "oleron");
    const r = found(findSupport(model, cons, table, sel, 55, []));
    expect(r.addedStars).toBe(24);
    expect(r.costProven).toBe(true);
    expect(r.peak).toBeLessThanOrEqual(55);
  });

  test("Ulo: final size and construction peak are different numbers", () => {
    // The backlog's Ulo "discrepancy" was final size versus peak: the cheapest build is 9 stars, but
    // standing it up holds scaffolding, so its peak is what selectionMinCost reports.
    const sel = whole(model, "ulo_the_keeper_of_the_waters");
    const r = found(findSupport(model, cons, table, sel, 55, []));
    expect(sel.size + r.addedStars).toBe(9);
    expect(r.peak).toBe(selectionMinCost(model, cons, table, sel));
  });

  test("the returned order is oracle-legal for the returned stars and keeps the selection", () => {
    const sel = whole(model, "light_of_empyrion");
    const r = found(findSupport(model, cons, table, sel, 55, []));
    for (const s of sel) expect(r.stars.has(s)).toBe(true);
    expect(verifyBuildOrder(cons, membersOf(model, r.stars), r.order, 55)).toBeNull();
    expect(r.stars.size).toBe(sel.size + r.addedStars);
    expect(Math.max(...r.order.map((s) => s.heldAfter))).toBe(r.peak);
  });

  test("a tight cap is respected: the suggestion's peak never exceeds it", () => {
    const sel = whole(model, "crab");
    const floor = selectionMinCost(model, cons, table, sel);
    const r = found(findSupport(model, cons, table, sel, floor, []));
    expect(r.peak).toBeLessThanOrEqual(floor);
  });

  test("deterministic: same result for a permuted selection order", () => {
    const sel = whole(model, "oleron", "hammer");
    const a = found(findSupport(model, cons, table, sel, 55, ["offensivePhysicalModifier"]));
    const b = found(findSupport(model, cons, table, new Set([...sel].reverse()), 55, ["offensivePhysicalModifier"]));
    expect(b.added).toEqual(a.added);
    expect(b.finished).toEqual(a.finished);
    expect(b.order).toEqual(a.order);
  });

  test("a partial whose finish is cheapest support is finished", () => {
    // Anvil taken to 2 of its stars, plus a constellation needing the ascendant Anvil grants once
    // complete: finishing Anvil is part of the cheapest completion.
    const anvil = model.constellations.get("anvil")!.starIds;
    const sel = new Set<StarId>([anvil[0]!, anvil[1]!, ...whole(model, "oleron")]);
    const r = found(findSupport(model, cons, table, sel, 55, []));
    const bare = found(findSupport(model, cons, table, whole(model, "oleron"), 55, []));
    expect(r.finished).toContain("anvil");
    expect(r.stars.size).toBeLessThanOrEqual(bare.stars.size + 2);
  });

  test("affinity tags do not score", () => {
    const sel = whole(model, "oleron");
    const r = found(findSupport(model, cons, table, sel, 55, ["aff:grant:chaos"]));
    expect(r.score).toBe(0);
  });
});

describe("findSupport on synthetic models", () => {
  test("tie-break: a tag on one of two equal-cost supports picks it", () => {
    const z = [0, 0, 0, 0, 0] as ReachCon["req"];
    const rc: ReachCon[] = [
      { id: "need", size: 2, req: [3, 0, 0, 0, 0], grant: z },
      { id: "a", size: 3, req: [1, 0, 0, 0, 0], grant: [4, 0, 0, 0, 0] },
      { id: "b", size: 3, req: [1, 0, 0, 0, 0], grant: [4, 0, 0, 0, 0] },
      ...[0, 1, 2, 3, 4].map((i) => ({
        id: `x${i}`,
        size: 1,
        req: z,
        grant: z.map((_, k) => (k === i ? 1 : 0)) as ReachCon["req"],
      })),
    ];
    const t = buildCoverTable(rc);
    const sel = whole(modelOf(rc), "need");
    const untagged = found(findSupport(modelOf(rc), rc, t, sel, 10, []));
    expect(untagged.added).toEqual(["a"]); // canonical id order breaks the bare tie
    const tagged = found(findSupport(modelOf(rc, new Set(["b"])), rc, t, sel, 10, ["t"]));
    expect(tagged.added).toEqual(["b"]);
    expect(tagged.score).toBe(3);
    expect(tagged.addedStars).toBe(untagged.addedStars);
  });

  test("brute force: fewest added stars, then the best tagged score", () => {
    const rng = mulberry32(20261008);
    let checked = 0;
    for (let trial = 0; trial < (SLOW ? 400 : 80); trial++) {
      const { cons: rc, budget } = randModel(rng);
      const tagged = new Set(rc.filter(() => rng() < 0.3).map((c) => c.id));
      const m = modelOf(rc, tagged);
      const t = buildCoverTable(rc);
      const pick = rc.filter((c) => !c.id.startsWith("x") && rng() < 0.4);
      if (!pick.length) continue;
      const sel = whole(m, ...pick.map((c) => c.id));
      const st = selectionSummary(m, sel);
      if (covers(st.supply, st.target)) continue; // already self-covering: nothing to find
      const truth = bruteForce(m, rc, sel, budget, tagged);
      const r = findSupport(m, rc, t, sel, budget, ["t"]);
      if (!truth) {
        expect(r.kind).toBe("none");
        continue;
      }
      const f = found(r);
      checked++;
      expect(f.addedStars).toBe(truth.added);
      expect(f.score).toBe(truth.score);
      expect(verifyBuildOrder(rc, membersOf(m, f.stars), f.order, budget)).toBeNull();
    }
    expect(checked).toBeGreaterThan(10);
  }, 120_000);
});

describe("findSupport over the reachable-builds corpus", () => {
  // Drop each granting member from a reachable build to make an incomplete selection the engine still
  // lights at the auto-raised cap; Find must never come back empty-handed for one.
  const cases: { label: string; sel: Set<StarId>; cap: number }[] = [];
  for (const c of fixture.cases) {
    const ids = Object.keys(c.sel);
    for (const drop of ids) {
      const con = model.constellations.get(drop);
      if (!con || !Object.values(con.affinityBonus).some((v) => (v ?? 0) > 0)) continue;
      const sel = new Set<StarId>();
      for (const id of ids)
        if (id !== drop) for (const s of model.constellations.get(id)!.starIds.slice(0, c.sel[id])) sel.add(s);
      cases.push({ label: `${c.label} - ${drop}`, sel, cap: 0 });
    }
  }
  const sample = SLOW ? cases : cases.filter((_, i) => i % 12 === 0);
  test(`every incomplete selection gets a verified suggestion (${sample.length} cases)`, () => {
    let checked = 0;
    for (const c of sample) {
      const st = selectionSummary(model, c.sel);
      if (covers(st.supply, st.target)) continue;
      const floor = selectionMinCost(model, cons, table, c.sel);
      if (floor > 55) continue;
      const cap = Math.max(55, floor);
      const r = findSupport(model, cons, table, c.sel, cap, []);
      if (r.kind !== "found") throw new Error(`no suggestion for ${c.label}`);
      for (const s of c.sel) expect(r.stars.has(s)).toBe(true);
      expect(verifyBuildOrder(cons, membersOf(model, r.stars), r.order, cap)).toBeNull();
      expect(r.costProven).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  }, 120_000);
});
