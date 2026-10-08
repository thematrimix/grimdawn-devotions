// ABOUTME: Find's fill: spend a capacity on stars carrying any tagged attribute (true OR), exactly. Only
// ABOUTME: constellations the base already covers are eligible, so any predecessor-closed pick keeps it valid.
import { covers, selectionSummary, type ReachCon } from "./reachability";
import type { DevotionModel, StarId } from "./types";

export interface FillResult {
  stars: Set<StarId>; // the base plus the fill
  added: number;
  tagged: number;
}

interface Option {
  size: number;
  tagged: number;
  stars: StarId[];
}

/**
 * The fill that maximizes tagged stars within `capacity`, then uses the fewest stars, then prefers
 * canonical (model) order. A constellation is eligible when it is not complete in the base and the
 * base's completed supply covers its requirement: then every predecessor-closed subset of its stars
 * leaves the base self-covering (a partial grants nothing and asks only what is already met; a completed
 * one's grant is ignored, which is conservative). Per constellation the closed subsets (at most 2^8) give
 * the best tagged count per size; a multiple-choice knapsack over the capacity picks across them.
 */
export function fillTagged(
  model: DevotionModel,
  cons: ReachCon[],
  base: Set<StarId>,
  capacity: number,
  tagged: Set<StarId>,
): FillResult {
  const none: FillResult = { stars: new Set(base), added: 0, tagged: 0 };
  if (capacity <= 0 || tagged.size === 0) return none;
  const supply = selectionSummary(model, base).supply;
  const reqById = new Map(cons.map((c) => [c.id, c.req]));
  const items: Option[][] = [];
  for (const con of model.constellations.values()) {
    const req = reqById.get(con.id);
    const free = con.starIds.filter((s) => !base.has(s));
    if (!req || free.length === 0 || !covers(supply, req)) continue;
    if (!free.some((s) => tagged.has(s))) continue;
    // Best tagged count per size over predecessor-closed subsets (ascending mask order: deterministic).
    const bySize = new Map<number, Option>();
    for (let mask = 1; mask < 1 << free.length; mask++) {
      const pick: StarId[] = [];
      for (let i = 0; i < free.length; i++) if (mask & (1 << i)) pick.push(free[i]!);
      const inPick = new Set(pick);
      let closed = true;
      for (const s of pick)
        for (const p of model.stars.get(s)!.predecessors) if (!base.has(p) && !inPick.has(p)) closed = false;
      if (!closed) continue;
      let t = 0;
      for (const s of pick) if (tagged.has(s)) t++;
      if (t === 0) continue;
      const cur = bySize.get(pick.length);
      if (!cur || t > cur.tagged) bySize.set(pick.length, { size: pick.length, tagged: t, stars: pick });
    }
    // Drop dominated options: a bigger pick that does not tag more.
    const opts: Option[] = [];
    for (const o of [...bySize.values()].sort((a, b) => a.size - b.size))
      if (!opts.length || o.tagged > opts[opts.length - 1]!.tagged) opts.push(o);
    if (opts.length) items.push(opts);
  }
  // dp[j] = most tagged with total size <= j; choice[i][j] = the option item i takes at budget j.
  let dp = new Array<number>(capacity + 1).fill(0);
  const choice: Int16Array[] = [];
  for (const opts of items) {
    const next = dp.slice();
    const ch = new Int16Array(capacity + 1).fill(-1);
    for (let j = 0; j <= capacity; j++)
      for (let o = 0; o < opts.length; o++) {
        const op = opts[o]!;
        if (op.size > j) break;
        const v = dp[j - op.size]! + op.tagged;
        if (v > next[j]!) {
          next[j] = v;
          ch[j] = o;
        }
      }
    dp = next;
    choice.push(ch);
  }
  const bestTagged = dp[capacity]!;
  if (bestTagged === 0) return none;
  // The smallest budget reaching the best count is the fewest stars that get it.
  let j = dp.indexOf(bestTagged);
  const stars = new Set(base);
  let added = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const o = choice[i]![j]!;
    if (o < 0) continue;
    const op = items[i]![o]!;
    for (const s of op.stars) stars.add(s);
    added += op.size;
    j -= op.size;
  }
  return { stars, added, tagged: bestTagged };
}
