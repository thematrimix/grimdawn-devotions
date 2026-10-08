// ABOUTME: Times findBuild per mode over incomplete selections derived from the build corpora (one granting
// ABOUTME: member dropped), with and without OR tags. Reports found/verified/non-exhaustive counts and p50/p95/max.
import { buildModel } from "../src/core/model";
import { buildCoverTable, buildReachCons, covers, selectionMinCost, selectionSummary } from "../src/core/reachability";
import { findBuild } from "../src/core/findBuild";
import { verifyBuildOrder } from "../src/core/orderLegality";
import type { FindMode, StarId } from "../src/core/types";

const model = buildModel(await Bun.file(`${import.meta.dir}/../../data/devotions.json`).json());
const cons = buildReachCons(model);
const table = buildCoverTable(cons);
const real = await Bun.file(`${import.meta.dir}/../test/fixtures/real-builds.json`).json();
const tags = process.argv.includes("--tags")
  ? ["defensivePhysical", "offensiveTotalDamageModifier", "defensiveAbsorptionModifier"]
  : [];
const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.slice(8) ?? 1e9);

const selections: Set<StarId>[] = [];
for (const b of real.builds as { starIds: string[] }[]) {
  const all = new Set(b.starIds.filter((s) => model.stars.has(s)) as StarId[]);
  for (const drop of new Set([...all].map((s) => model.stars.get(s)!.constellationId))) {
    const c = model.constellations.get(drop)!;
    if (!Object.values(c.affinityBonus).some((v) => (v ?? 0) > 0)) continue;
    const sel = new Set([...all].filter((s) => model.stars.get(s)!.constellationId !== drop));
    const st = selectionSummary(model, sel);
    if (covers(st.supply, st.target) || selectionMinCost(model, cons, table, sel) > 55) continue;
    selections.push(sel);
  }
}
for (const mode of ["cheapest", "fill", "attributes"] as FindMode[]) {
  const times: number[] = [];
  let none = 0;
  let partial = 0;
  let illegal = 0;
  for (const sel of selections.slice(0, limit)) {
    const t0 = performance.now();
    const r = findBuild(model, cons, table, sel, 55, tags, mode);
    times.push(performance.now() - t0);
    if (r.kind === "none") {
      none++;
      continue;
    }
    if (!r.exhaustive) partial++;
    if (verifyBuildOrder(cons, selectionSummary(model, r.stars).built, r.order, 55)) illegal++;
  }
  times.sort((a, b) => a - b);
  const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))]!.toFixed(1);
  console.log(
    `${mode.padEnd(10)} n=${times.length} none=${none} illegal=${illegal} bestFound=${partial} p50=${q(0.5)}ms p95=${q(0.95)}ms max=${q(1)}ms`,
  );
}
