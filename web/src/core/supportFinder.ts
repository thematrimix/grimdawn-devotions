// ABOUTME: Find's support search: the cheapest covering build over a base selection (fewest added stars,
// ABOUTME: tagged tie-break, verified order), plus the acceptance and verification helpers the modes share.
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

// Work caps, counted in DFS nodes (never wall-clock) so the result is a pure function of its inputs and a
// shared link recomputes the identical suggestion.
const COST_NODE_CAP = 400_000; // phase 1: prove the fewest added stars
const TIE_NODE_CAP = 200_000; // phase 2: enumerate equal-cost alternatives for the tie-break
const MAX_TIES = 256; // equal-cost candidates kept for ranking
const MAX_VERIFY = 8; // candidates replayed through the real build-order path
// The covering-node acceptance: the ladder gate, else the peak witness WITH seeded shuffles (the classify
// path's count). The per-click resolver runs the witness without shuffles to stay cheap and WASM-equivalent;
// Find runs on demand and replays every suggestion through the oracle, so it can afford the cap-tight builds
// only a shuffled order fits.
const WITNESS_TRIES = 32;
const WITNESS_NODE_CAP = 3000;
// The panel's live build order (selectionView) uses 32 tries; Find verifies with the same call so an applied
// suggestion shows the very order previewed.
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

export interface VerifiedOrder {
  order: BuildStep[];
  states: StepState[];
  peak: number;
}

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
export function taggedStars(model: DevotionModel, tags: Iterable<string>): Set<StarId> {
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

/** selectionSummary in canonical order: a decoded link and a sequence of clicks need not share iteration order. */
function canonicalSummary(model: DevotionModel, selected: Set<StarId>): ReachState {
  const st = selectionSummary(model, selected);
  return { ...st, built: [...st.built].sort(byId), partialFinish: [...st.partialFinish].sort(byId) };
}

/** The base's committed members, with the chosen partial finishes at full size and grant. */
function baseMembers(st: ReachState, finished: Set<string>): ReachCon[] {
  const pf = new Map(st.partialFinish.map((p) => [p.id, p]));
  return st.built.map((b) => {
    const p = pf.get(b.id);
    return p && finished.has(b.id) ? { ...b, grant: p.grant, size: b.size + p.remaining } : b;
  });
}

/** The ladder gate, else the shuffled peak witness: the build fits the cap by some legal construction. */
export function acceptsBuild(cons: ReachCon[], table: CoverTable, members: ReachCon[], cap: number): boolean {
  return (
    peakGateReachable(cons, members, cap) ||
    minPeakSampled(cons, table, members, cap, WITNESS_TRIES, WITNESS_NODE_CAP) <= cap
  );
}

/** The panel's own order for these members at this cap, only when the independent oracle proves it legal. */
export function verifiedOrder(
  cons: ReachCon[],
  table: CoverTable,
  members: ReachCon[],
  cap: number,
): VerifiedOrder | null {
  const gated = gateBuildOrder(cons, members, buildOrderPath(cons, table, members, cap, ORDER_TRIES), cap);
  if (!gated) return null;
  let peak = 0;
  for (const s of gated.steps) peak = Math.max(peak, s.heldAfter);
  return { order: gated.steps, states: gated.states, peak };
}

/**
 * Every covering build over `st`: for each subset of partial finishes, a cover-table-pruned DFS over
 * `filler` (include first). `over(bound)` prunes a node whose added-star bound is out of reach; a covering
 * node is reported (unless `over` its cost) and its supersets pruned, since more filler only adds stars
 * and cannot lower the peak. Returns true when `nodeCap` stopped the walk early.
 */
function walkCovering(
  st: ReachState,
  table: CoverTable,
  cap: number,
  filler: ReachCon[],
  nodeCap: number,
  over: (bound: number) => boolean,
  onCovering: (chosen: ReachCon[], finished: string[], added: number, members: ReachCon[]) => void,
): boolean {
  let nodes = 0;
  let capHit = false;
  const chosen: ReachCon[] = [];
  let finished: string[] = [];
  let builtCons: ReachCon[] = [];
  function rec(i: number, build: Vec, added: number, maxReq: Vec): void {
    if (capHit) return;
    if (++nodes > nodeCap) {
      capHit = true;
      return;
    }
    if (covers(build, maxReq)) {
      if (!over(added)) onCovering(chosen, finished, added, [...builtCons, ...chosen]);
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
  const pf = st.partialFinish;
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
    builtCons = baseMembers(st, fin);
    chosen.length = 0;
    rec(0, build, added, st.target);
    if (capHit) break;
  }
  return capHit;
}

/** The base plus every star of the chosen constellations and of the finished partials. */
function starsOf(model: DevotionModel, base: Set<StarId>, chosen: ReachCon[], finished: string[]): Set<StarId> {
  const stars = new Set<StarId>(base);
  for (const id of [...chosen.map((c) => c.id), ...finished])
    for (const sid of model.constellations.get(id)?.starIds ?? []) stars.add(sid);
  return stars;
}

const keyOf = (chosen: ReachCon[], finished: string[]): string =>
  [...chosen.map((c) => c.id), ...finished.map((id) => `${id}#finish`)].sort().join(",");

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
  const st = canonicalSummary(model, selected);
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
  for (const p of st.partialFinish) conScore.set(p.id, scoreOf(p.id));
  const candidateOf = (chosen: ReachCon[], finished: string[], added: number): Candidate => {
    let score = 0;
    for (const c of chosen) score += conScore.get(c.id)!;
    for (const id of finished) score += conScore.get(id)!;
    return {
      chosen: [...chosen].sort(byId),
      finished: [...finished].sort(),
      added,
      score,
      key: keyOf(chosen, finished),
    };
  };
  const membersFor = (c: Candidate): ReachCon[] => [...baseMembers(st, new Set(c.finished)), ...c.chosen];

  // Phase 1: the fewest added stars. Each accepted build tightens the limit, so only strictly cheaper
  // builds are pursued afterward.
  let best: Candidate | null = null;
  let limit = cap - st.own + 1;
  const costProven = !walkCovering(
    st,
    table,
    cap,
    filler,
    COST_NODE_CAP,
    (b) => b >= limit,
    (chosen, finished, added, members) => {
      if (!acceptsBuild(cons, table, members, cap)) return;
      best = candidateOf(chosen, finished, added);
      limit = added;
    },
  );
  // Phase 2: every accepted build at exactly that cost, for the benefit tie-break. Only a capped phase 1
  // can leave a cheaper build for this pass to meet; it becomes the cost.
  let tiesExhausted = false;
  let ties: Candidate[] = [];
  if (best) {
    limit = (best as Candidate).added;
    const seen = new Set<string>();
    tiesExhausted = !walkCovering(
      st,
      table,
      cap,
      filler,
      TIE_NODE_CAP,
      (b) => b > limit,
      (chosen, finished, added, members) => {
        if (!acceptsBuild(cons, table, members, cap)) return;
        if (added < limit) {
          limit = added;
          ties = [];
        }
        const c = candidateOf(chosen, finished, added);
        if (c.added !== limit || seen.has(c.key)) return;
        seen.add(c.key);
        ties.push(c);
        if (ties.length > MAX_TIES * 2) ties = rank(ties).slice(0, MAX_TIES);
      },
    );
    if (!ties.length) ties = [best];
  }

  // Verify through the real path, in rank order: the first score group with any verified order wins, and
  // within it the lowest peak. Greedy's own build is the last resort, so a selection the engine lights
  // never comes back empty-handed.
  let winner: ({ c: Candidate } & VerifiedOrder) | null = null;
  for (const c of rank(ties).slice(0, MAX_VERIFY)) {
    if (winner && (c.added !== winner.c.added || c.score !== winner.c.score)) break;
    const v = verifiedOrder(cons, table, membersFor(c), cap);
    if (v && (!winner || v.peak < winner.peak)) winner = { c, ...v };
  }
  if (!winner) {
    const g = greedyCandidate();
    const v = g ? verifiedOrder(cons, table, membersFor(g), cap) : null;
    if (g && v) winner = { c: g, ...v };
  }
  if (!winner) return { kind: "none" };
  const w: Candidate = winner.c;
  return {
    kind: "found",
    stars: starsOf(model, selected, w.chosen, w.finished),
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
