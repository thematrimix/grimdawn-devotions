// ABOUTME: Find's modes over the user's core: cheapest support, cheapest plus an OR-tagged fill, or the most
// ABOUTME: OR-tagged stars within the cap. Every plan carries a verified order; an unbuildable core drops its
// ABOUTME: smallest constellations until one exists. Also the per-constellation delta the preview lists.
import { fillTagged } from "./findFill";
import type { StepState } from "./orderLegality";
import { covers, selectionSummary, type BuildStep, type CoverTable, type ReachCon } from "./reachability";
import { findSupport, taggedStars, verifiedOrder, type VerifiedOrder } from "./supportFinder";
import type { DevotionModel, FindMode, StarId } from "./types";

// Work caps (counts, never wall-clock): the plan stays a pure function of (core, cap, tags, mode).
const MAX_DROPS = 6; // core constellations dropped before giving up
const FILL_RETRIES = 6; // smaller capacities tried when a filled build fails the oracle
const ATTR_ROUNDS = 3; // greedy rounds of the attributes mode
const ATTR_TRIES = 6; // blocked tagged constellations tried per round, best tagged-per-star first
const PRUNE_PASSES = 3; // prune-and-refill passes over a build's redundant support

export interface FindPlan {
  kind: "found";
  mode: FindMode; // the mode that produced it (a tagless fill/attributes request reports "cheapest")
  stars: Set<StarId>; // what Apply sets
  core: Set<StarId>; // the core kept (the input core minus dropped constellations)
  dropped: string[]; // core constellations removed to reach a legal build, canonical order
  addedStars: number; // stars.size - core.size
  tagged: number; // stars outside the core carrying a tagged attribute (true OR)
  peak: number;
  exhaustive: boolean; // false: a work cap or the greedy search stood in for a proof ("best found")
  order: BuildStep[];
  states: StepState[];
}
export type FindOutcome = FindPlan | { kind: "none" };

export interface ConDelta {
  conId: string;
  from: number;
  to: number;
  total: number;
  gained: number; // stars only in `after` (a same-count swap gains and loses)
  lost: number; // stars only in `before`
}

type Draft = Omit<FindPlan, "kind" | "core" | "dropped">;

/** The best build for `mode` over the core within `cap` (see docs/reachability-engine.md, "Find"). */
export function findBuild(
  model: DevotionModel,
  cons: ReachCon[],
  table: CoverTable,
  core: Set<StarId>,
  cap: number,
  tags: Iterable<string>,
  mode: FindMode,
): FindOutcome {
  if (!Number.isFinite(cap) || core.size === 0) return { kind: "none" };
  const tagList = [...tags];
  const tagged = taggedStars(model, tagList);
  const effective: FindMode = tagged.size === 0 ? "cheapest" : mode;
  const reqById = new Map(cons.map((c) => [c.id, c.req]));
  let kept = new Set(core);
  const dropped: string[] = [];
  for (let attempt = 0; attempt <= MAX_DROPS && kept.size > 0; attempt++) {
    const draft = planFor(kept);
    if (draft) return { kind: "found", ...draft, core: kept, dropped: [...dropped].sort() };
    const victim = smallestConstellation(model, kept);
    if (!victim) break;
    kept = new Set([...kept].filter((s) => model.stars.get(s)?.constellationId !== victim));
    dropped.push(victim);
  }
  return { kind: "none" };

  function draftOf(base: Set<StarId>, stars: Set<StarId>, v: VerifiedOrder, exhaustive: boolean, m: FindMode): Draft {
    let n = 0;
    for (const s of stars) if (!base.has(s) && tagged.has(s)) n++;
    return {
      mode: m,
      stars,
      addedStars: stars.size - base.size,
      tagged: n,
      peak: v.peak,
      exhaustive,
      order: v.order,
      states: v.states,
    };
  }
  function cheapest(base: Set<StarId>): Draft | null {
    const r = findSupport(model, cons, table, base, cap, tagList);
    if (r.kind !== "found") return null;
    return draftOf(base, r.stars, r, r.costProven && r.tiesExhausted, "cheapest");
  }
  /** The built set plus the best verified fill: the DP's pick, retried at smaller capacities if the oracle rejects it. */
  function filled(built: Set<StarId>): { stars: Set<StarId>; v: VerifiedOrder } | null {
    let capacity = cap - built.size;
    for (let attempt = 0; attempt < FILL_RETRIES && capacity > 0; attempt++) {
      const f = fillTagged(model, cons, built, capacity, tagged);
      if (f.added === 0) return null;
      const v = verifiedOrder(cons, table, selectionSummary(model, f.stars).built, cap);
      if (v) return { stars: f.stars, v };
      capacity = f.added - 1;
    }
    return null;
  }
  function fill(base: Set<StarId>): Draft | null {
    const c = cheapest(base);
    if (!c) return null;
    const f = filled(c.stars);
    return f ? draftOf(base, f.stars, f.v, c.exhaustive, "fill") : { ...c, mode: "fill" };
  }
  /**
   * Greedy improvement from cheapest + fill. The fill only reaches constellations the build already
   * covers; a tagged constellation that needs more affinity is "blocked". Each round tries adding one
   * blocked constellation's tagged stars (with their predecessors) to the core, re-runs cheapest + fill,
   * and keeps the best improvement, scored against the ORIGINAL core so the added tagged stars count.
   * Each build is then pruned and refilled (support the fill made redundant is refunded for more fill).
   * Greedy proves nothing, so the result is exhaustive only when it reaches the trivial upper bound.
   */
  function attributes(base: Set<StarId>): Draft | null {
    const start = fill(base);
    if (!start) return null;
    let best: Draft = pruneRefill(base, base, { ...start, mode: "attributes" });
    let current = base;
    for (let round = 0; round < ATTR_ROUNDS; round++) {
      const blocked = blockedCandidates(current, best.stars);
      if (!blocked.length) break;
      let roundBest: { d: Draft; core: Set<StarId> } | null = null;
      for (const b of blocked.slice(0, ATTR_TRIES)) {
        const next = new Set([...current, ...b.add]);
        if (next.size > cap) continue;
        const d = fill(next);
        if (!d) continue;
        const scored = draftOf(base, d.stars, d, false, "attributes");
        if (better(scored, roundBest?.d ?? null)) roundBest = { d: scored, core: next };
      }
      // Prune-and-refill only the round's winner: it is the costly step (one oracle replay per try).
      if (roundBest) roundBest.d = pruneRefill(base, roundBest.core, roundBest.d);
      if (!roundBest || !better(roundBest.d, best)) break;
      best = roundBest.d;
      current = roundBest.core;
    }
    // Proven only at the trivial bound: every remaining tagged star taken, or every free point tagged.
    let open = 0;
    for (const s of tagged) if (!base.has(s)) open++;
    best.exhaustive = best.tagged >= Math.min(open, cap - base.size);
    return best;
  }
  /**
   * Refund support the fill made redundant: drop a non-core constellation when the rest still covers
   * itself, refill the freed points, and keep the result when the oracle verifies it and it scores
   * better. `keep` (the working core) is never touched; scores count against `base`.
   */
  function pruneRefill(base: Set<StarId>, keep: Set<StarId>, d: Draft): Draft {
    let cur = d;
    for (let pass = 0; pass < PRUNE_PASSES; pass++) {
      let improved = false;
      const byCon = new Map<string, StarId[]>();
      for (const s of cur.stars) {
        if (keep.has(s)) continue;
        const id = model.stars.get(s)!.constellationId;
        byCon.set(id, [...(byCon.get(id) ?? []), s]);
      }
      for (const [id, stars] of [...byCon].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (stars.length !== model.constellations.get(id)!.starIds.length) continue; // only whole support
        const pruned = new Set([...cur.stars].filter((s) => !stars.includes(s)));
        const st = selectionSummary(model, pruned);
        if (!covers(st.supply, st.target)) continue;
        const f = filled(pruned);
        const v = f ? f.v : verifiedOrder(cons, table, st.built, cap);
        if (!v) continue;
        const next = draftOf(base, f ? f.stars : pruned, v, false, "attributes");
        if (better(next, cur)) {
          cur = next;
          improved = true;
          break;
        }
      }
      if (!improved) break;
    }
    return cur;
  }
  /** Tagged constellations the build cannot fill (requirement above its supply), as the stars to add. */
  function blockedCandidates(current: Set<StarId>, stars: Set<StarId>): { add: StarId[]; tagged: number }[] {
    const supply = selectionSummary(model, stars).supply;
    const out: { id: string; add: StarId[]; tagged: number }[] = [];
    for (const con of model.constellations.values()) {
      const req = reqById.get(con.id);
      if (!req || covers(supply, req)) continue;
      const want = con.starIds.filter((s) => tagged.has(s) && !stars.has(s));
      if (!want.length) continue;
      // The tagged stars plus their predecessors: the closed set a player must take to reach them.
      const add = new Set<StarId>();
      const stack = [...want];
      while (stack.length) {
        const s = stack.pop()!;
        if (add.has(s) || current.has(s)) continue;
        add.add(s);
        stack.push(...(model.stars.get(s)?.predecessors ?? []));
      }
      out.push({ id: con.id, add: [...add], tagged: want.length });
    }
    return out
      .sort((a, b) => b.tagged / b.add.length - a.tagged / a.add.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ add, tagged: t }) => ({ add, tagged: t }));
  }
  function planFor(base: Set<StarId>): Draft | null {
    if (effective === "fill") return fill(base);
    if (effective === "attributes") return attributes(base);
    return cheapest(base);
  }
}

/** More tagged stars, then fewer stars. */
function better(d: Draft, than: Draft | null): boolean {
  return !than || d.tagged > than.tagged || (d.tagged === than.tagged && d.stars.size < than.stars.size);
}

/** The core constellation with the fewest core stars (canonical id breaks ties): the first to drop. */
function smallestConstellation(model: DevotionModel, stars: Set<StarId>): string | null {
  const count = new Map<string, number>();
  for (const s of stars) {
    const id = model.stars.get(s)?.constellationId;
    if (id) count.set(id, (count.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [id, n] of count)
    if (best === null || n < count.get(best)! || (n === count.get(best)! && id < best)) best = id;
  return best;
}

/** Per-constellation star changes between two selections, in model order (any differing star counts). */
export function selectionDelta(model: DevotionModel, before: Set<StarId>, after: Set<StarId>): ConDelta[] {
  const out: ConDelta[] = [];
  for (const c of model.constellations.values()) {
    let from = 0;
    let to = 0;
    let gained = 0;
    let lost = 0;
    for (const s of c.starIds) {
      const b = before.has(s);
      const a = after.has(s);
      if (b) from++;
      if (a) to++;
      if (a && !b) gained++;
      if (b && !a) lost++;
    }
    if (gained || lost) out.push({ conId: c.id, from, to, total: c.starIds.length, gained, lost });
  }
  return out;
}
