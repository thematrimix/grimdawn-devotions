// ABOUTME: Find: the cheapest supporting build for a selection that does not cover its own affinity.
// ABOUTME: Fewest added stars (whole supporting constellations plus finished partials), tie-broken toward
// ABOUTME: stars carrying the user's tagged benefits, and returned only with an oracle-verified build order.
import { starValuesGranting, starValuesGrantingPet } from "./aggregate";
import { parseTag } from "./benefitTag";
import { gateBuildOrder, type StepState } from "./orderLegality";
import {
  addCap,
  buildOrderPath,
  coverCostAt,
  covers,
  greedyFrom,
  INF,
  lastGreedyFiller,
  maxV,
  minPeakSampled,
  peakGateReachable,
  selectionSummary,
  type BuildStep,
  type CoverTable,
  type ReachCon,
  type ReachState,
  type Vec,
} from "./reachability";
import type { DevotionModel, StarId } from "./types";

// Work caps, counted in DFS nodes (never wall-clock) so the result is a pure function of
// (selection, cap, tags) and a shared link recomputes the identical suggestion.
const COST_NODE_CAP = 400_000; // phase 1: prove the fewest added stars
const TIE_NODE_CAP = 200_000; // phase 2: enumerate equal-cost alternatives for the tie-break
const MAX_TIES = 256; // equal-cost candidates kept for ranking
const MAX_VERIFY = 8; // candidates replayed through the real build-order path
// The covering-node acceptance: the ladder gate, else the peak witness WITH seeded shuffles (the
// classify path's count). The per-click resolver runs the witness without shuffles to stay cheap and
// WASM-equivalent; Find runs once per click of its button and replays every suggestion through the
// oracle, so it can afford to accept the cap-tight builds only a shuffled order fits.
const WITNESS_TRIES = 32;
const WITNESS_NODE_CAP = 3000;
// The panel's live build order (selectionView) uses 32 tries; Find verifies with the same call so an
// applied suggestion shows the very order previewed.
const ORDER_TRIES = 32;

export interface FindFound {
  kind: "found";
  stars: Set<StarId>; // the selection plus every added star: what Apply sets
  added: string[]; // supporting constellations added whole, canonical (id) order
  finished: string[]; // partially-taken constellations Find completes, canonical order
  addedStars: number; // final build size minus the selection: the objective
  peak: number; // construction peak of the verified order (must fit the cap; not the objective)
  score: number; // added stars carrying a tagged benefit: the tie-break
  costProven: boolean; // phase 1 finished: no build with fewer added stars exists
  tiesExhausted: boolean; // phase 2 finished: every equal-cost alternative was ranked
  order: BuildStep[];
  states: StepState[];
}
export type FindResult = FindFound | { kind: "none" };

interface Candidate {
  chosen: ReachCon[];
  finished: string[];
  added: number;
  score: number;
  key: string;
}

const hasGrant = (c: ReachCon): boolean => !!(c.grant[0] || c.grant[1] || c.grant[2] || c.grant[3] || c.grant[4]);
const ratio = (c: ReachCon): number => (c.grant[0] + c.grant[1] + c.grant[2] + c.grant[3] + c.grant[4]) / c.size;
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The stars carrying any tagged player or pet benefit (affinity tags are constellation-level and skipped). */
function taggedStars(model: DevotionModel, tags: Iterable<string>): Set<StarId> {
  const out = new Set<StarId>();
  for (const s of tags) {
    const tag = parseTag(s);
    if (!tag || tag.kind === "affinity") continue;
    const values =
      tag.kind === "pet" ? starValuesGrantingPet(model, tag.statId) : starValuesGranting(model, tag.statId);
    for (const sid of values.keys()) out.add(sid);
  }
  return out;
}

function deficitOf(target: Vec, build: Vec): Vec {
  return [
    Math.max(0, target[0] - build[0]),
    Math.max(0, target[1] - build[1]),
    Math.max(0, target[2] - build[2]),
    Math.max(0, target[3] - build[3]),
    Math.max(0, target[4] - build[4]),
  ];
}

/**
 * The cheapest supporting build for `selected` within `cap`: the fewest added stars that make it a
 * self-covering build with a construction peak at or under the cap, preferring (among equal costs) the
 * one whose added stars carry the most tagged benefits, then the lowest peak, then canonical ids.
 * Every returned suggestion carries the oracle-verified order the panel will show once it is applied.
 */
export function findSupport(
  model: DevotionModel,
  cons: ReachCon[],
  table: CoverTable,
  selected: Set<StarId>,
  cap: number,
  benefitTags: Iterable<string>,
): FindResult {
  const st0 = selectionSummary(model, selected);
  // Canonical order: selectionSummary follows the selection's iteration order, which a decoded link
  // and a sequence of clicks need not share.
  const st: ReachState = {
    ...st0,
    built: [...st0.built].sort(byId),
    partialFinish: [...st0.partialFinish].sort(byId),
  };
  const tagged = taggedStars(model, benefitTags);
  const scoreOf = (conId: string): number => {
    let n = 0;
    for (const sid of model.constellations.get(conId)?.starIds ?? []) if (tagged.has(sid) && !selected.has(sid)) n++;
    return n;
  };
  const conScore = new Map<string, number>();
  const filler = cons
    .filter((c) => !st.startedIds.has(c.id) && hasGrant(c))
    .sort((a, b) => ratio(b) - ratio(a) || byId(a, b));
  for (const c of filler) conScore.set(c.id, scoreOf(c.id));
  const pf = st.partialFinish;
  for (const p of pf) conScore.set(p.id, scoreOf(p.id));
  const remainingById = new Map(pf.map((p) => [p.id, p.remaining]));
  const grantById = new Map(pf.map((p) => [p.id, p.grant]));

  const membersFor = (chosen: ReachCon[], finished: Set<string>): ReachCon[] => [
    ...st.built.map((b) =>
      finished.has(b.id) ? { ...b, grant: grantById.get(b.id)!, size: b.size + remainingById.get(b.id)! } : b,
    ),
    ...chosen,
  ];
  const accepts = (members: ReachCon[]): boolean =>
    peakGateReachable(cons, members, cap) ||
    minPeakSampled(cons, table, members, cap, WITNESS_TRIES, WITNESS_NODE_CAP) <= cap;
  const candidateOf = (chosen: ReachCon[], finished: string[], added: number): Candidate => {
    let score = 0;
    for (const c of chosen) score += conScore.get(c.id)!;
    for (const id of finished) score += conScore.get(id)!;
    const ids = [...chosen.map((c) => c.id), ...finished.map((id) => `${id}#finish`)].sort();
    return { chosen: [...chosen].sort(byId), finished: [...finished].sort(), added, score, key: ids.join(",") };
  };

  // One DFS over whole-constellation filler for every subset of partial finishes, as the exact resolver
  // does (docs/reachability-engine.md). `strict` keeps nodes whose bound EQUALS the limit (phase 2's
  // tie enumeration); otherwise only strictly cheaper builds are pursued (phase 1). A covering node is
  // decided and its supersets pruned: more filler can only add stars, and cannot lower the peak.
  let limit = cap - st.own;
  let nodes = 0;
  let nodeCap = 0;
  let capHit = false;
  let ties: Candidate[] = [];
  function search(strict: boolean, onAccept: (c: Candidate) => void): void {
    nodes = 0;
    capHit = false;
    const chosen: ReachCon[] = [];
    let finished: string[] = [];
    let builtCons: ReachCon[] = [];
    const over = (bound: number): boolean => (strict ? bound > limit : bound >= limit);
    function rec(i: number, build: Vec, added: number, maxReq: Vec): void {
      if (capHit) return;
      if (++nodes > nodeCap) {
        capHit = true;
        return;
      }
      if (covers(build, maxReq)) {
        if (!over(added) && accepts([...builtCons, ...chosen])) onAccept(candidateOf(chosen, finished, added));
        return;
      }
      if (i >= filler.length) return;
      const cov = coverCostAt(table, deficitOf(maxV(maxReq, st.target), build));
      if (cov >= INF || over(added + cov)) return;
      const c = filler[i]!;
      if (st.own + added + c.size <= cap) {
        chosen.push(c);
        rec(i + 1, addCap(build, c.grant), added + c.size, maxV(maxReq, c.req));
        chosen.pop();
      }
      rec(i + 1, build, added, maxReq);
    }
    for (let mask = 0; mask < 1 << pf.length; mask++) {
      let build: Vec = [...st.supply];
      let added = 0;
      const fin = new Set<string>();
      for (let j = 0; j < pf.length; j++)
        if (mask & (1 << j)) {
          build = addCap(build, pf[j]!.grant);
          added += pf[j]!.remaining;
          fin.add(pf[j]!.id);
        }
      if (st.own + added > cap) continue;
      finished = [...fin];
      builtCons = membersFor([], fin);
      chosen.length = 0;
      rec(0, build, added, st.target);
      if (capHit) return;
    }
  }

  // Phase 1: the fewest added stars. Each accepted build tightens the limit, so the search only ever
  // pursues strictly cheaper builds afterward.
  let best: Candidate | null = null;
  nodeCap = COST_NODE_CAP;
  limit = cap - st.own + 1;
  search(false, (c) => {
    best = c;
    limit = c.added;
  });
  const costProven = !capHit;
  // Phase 2: every accepted build at exactly that cost, for the benefit tie-break.
  let tiesExhausted = false;
  if (best) {
    limit = (best as Candidate).added;
    nodeCap = TIE_NODE_CAP;
    const seen = new Set<string>();
    search(true, (c) => {
      if (c.added !== limit || seen.has(c.key)) return;
      seen.add(c.key);
      ties.push(c);
      if (ties.length > MAX_TIES * 2) ties = rank(ties).slice(0, MAX_TIES);
    });
    tiesExhausted = !capHit;
    if (!ties.length) ties = [best];
  }

  // Verify through the real path, in rank order: the first score group with any verified order wins,
  // and within it the lowest peak. Greedy's own build is the last resort, so a selection the engine
  // lights never comes back empty-handed.
  const ranked = rank(ties);
  let winner: { c: Candidate; order: BuildStep[]; states: StepState[]; peak: number } | null = null;
  for (const c of ranked.slice(0, MAX_VERIFY)) {
    if (winner && (c.added !== winner.c.added || c.score !== winner.c.score)) break;
    const v = verify(c);
    if (v && (!winner || v.peak < winner.peak)) winner = { c, ...v };
  }
  if (!winner) {
    const g = greedyCandidate();
    const v = g ? verify(g) : null;
    if (g && v) winner = { c: g, ...v };
  }
  if (!winner) return { kind: "none" };
  const w: Candidate = winner.c;
  const stars = new Set<StarId>(selected);
  for (const id of [...w.chosen.map((c) => c.id), ...w.finished])
    for (const sid of model.constellations.get(id)?.starIds ?? []) stars.add(sid);
  return {
    kind: "found",
    stars,
    added: w.chosen.map((c) => c.id),
    finished: w.finished,
    addedStars: w.added,
    peak: winner.peak,
    score: w.score,
    costProven: costProven && w.added === (best as Candidate | null)?.added,
    tiesExhausted,
    order: winner.order,
    states: winner.states,
  };

  function verify(c: Candidate): { order: BuildStep[]; states: StepState[]; peak: number } | null {
    const members = membersFor(c.chosen, new Set(c.finished));
    const gated = gateBuildOrder(cons, members, buildOrderPath(cons, table, members, cap, ORDER_TRIES), cap);
    if (!gated) return null;
    let peak = 0;
    for (const s of gated.steps) peak = Math.max(peak, s.heldAfter);
    return { order: gated.steps, states: gated.states, peak };
  }

  function greedyCandidate(): Candidate | null {
    if (greedyFrom(cons, st, cap) >= INF) return null;
    const chosen: ReachCon[] = [];
    const finished: string[] = [];
    let added = 0;
    for (const c of lastGreedyFiller()) {
      added += c.size;
      if (c.id.endsWith("#finish")) finished.push(c.id.slice(0, -"#finish".length));
      else chosen.push(c);
    }
    return candidateOf(chosen, finished, added);
  }
}

function rank(cs: Candidate[]): Candidate[] {
  return [...cs].sort((a, b) => a.added - b.added || b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
