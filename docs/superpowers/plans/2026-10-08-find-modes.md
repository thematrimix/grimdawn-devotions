# Find Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Find into a re-optimizable, mode-driven suggester. It works from the user's core picks, can swap out its own earlier suggestions, and can spend points on stars carrying any tagged attribute (true OR).

**Architecture:**
- The core is a pure set model (`findCore.ts`) reconciled once per refresh and saved in the URL as `fc=`.
- The search is split three ways:
  - `supportFinder.ts`: support search. It keeps today's cheapest contract and adds a candidate enumerator.
  - `findFill.ts` (new): exact fill knapsack.
  - `findBuild.ts` (new): mode orchestration, verification, dropping, and the per-constellation delta.
- The adapter renders a mode selector and a delta preview. `main.ts` wires state, the URL, and live recompute.

**Tech Stack:** TypeScript, bun test, Biome, a headless-Chromium e2e over CDP (`web/e2e/smoke.ts`).

**Spec:** `docs/superpowers/specs/2026-10-08-find-modes-design.md` (builds on `docs/superpowers/specs/2026-10-08-find-supporting-build-design.md`).

## Global Constraints

- Branch `feat/find-support` (draft PR #1 on thematrimix/grimdawn-devotions). Commit per task. Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`: add `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"` to each `git commit` below.
- Run every command from `web/` unless stated otherwise. Tests use `bun test <file>`. Typecheck with `bunx tsc --noEmit`, lint with `bunx biome lint --error-on-warnings`, format with `bunx biome format --write <paths>`.
- No user-facing literal in app code. Every string is a key in `web/src/i18n/app.en.json`, and is also listed in `REQUIRED` in `web/test/appCatalog.test.ts`. Only English is added; the other locales fall back per key.
- Every planner state round-trips through `encodeHash`/`decodeHash` and tolerates stale or malformed links. Mode is `fm=` (`1` fill, `2` attributes, anything else cheapest). Core is `fc=` (a star bitset; absent means core = selection).
- Results are deterministic: work caps count nodes and candidates, never wall-clock time. Every suggestion passes `gateBuildOrder` before it is returned.
- **Engine boundary:** do not change any verdict in `web/src/core/reachability.ts`. Only exporting is allowed. No Rust changes.
- **True OR:** a star scores 1 if it carries at least one tagged player or pet attribute. Affinity tags never score.

## Review Focus

1. **A hand-edited `fc=` naming stars not in `s=`.** Decode clamps it into the selection, and an empty or equal core decodes as "no core". Pinned in Task 1.
2. **Tags that score nothing.** Only affinity tags, or attributes no reachable star carries: fill and attributes must return exactly the Cheapest result without error. Pinned in Task 4.
3. **The cap equals the build size.** Fill capacity is 0, so fill must return the support unchanged instead of failing. Pinned in Task 4.
4. **A partly-taken core constellation.** Fill may extend it, but only with predecessor-closed stars. Pinned in Task 2, with branching predecessors.
5. **Changing mode or tags with the preview open.** The preview must recompute (the memo key includes both), not show a stale result or close. Pinned in Task 6 (e2e).

---

## File Structure

| File | Responsibility |
|---|---|
| `web/src/core/types.ts` | add `FindMode` |
| `web/src/core/urlState.ts` | `fc=` / `fm=` codec |
| `web/src/core/findCore.ts` (new) | `reconcileCore`: the core's lifecycle as a pure function |
| `web/src/core/findFill.ts` (new) | `fillTagged`: exact OR-tagged fill under a capacity |
| `web/src/core/supportFinder.ts` | shared covering walk, `findSupport` (cheapest), `supportCandidates`, `acceptsBuild`, `verifiedOrder`, `taggedStars` |
| `web/src/core/findBuild.ts` (new) | `findBuild` (modes, fill retries, dropping), `selectionDelta` |
| `web/src/adapters/buildOrderView.ts` | mode selector, always-usable button, delta preview |
| `web/src/app/main.ts` | core / mode / open state, reconcile, wholesale resets, live recompute, Apply |
| `web/src/i18n/app.en.json`, `web/test/appCatalog.test.ts` | keys |
| `web/test/support/synthModel.ts` (new) | `modelOf` synthetic DevotionModel builder shared by the tests |
| `web/test/find-core.test.ts`, `find-fill.test.ts`, `find-build.test.ts` (new) | unit tests |
| `web/scripts/find-perf.ts` (new) | corpus timing per mode |
| `docs/reachability-engine.md`, `BACKLOG.md` | evergreen docs |

---

### Task 1: FindMode, the core reconciler, and the URL codec

**Files:**
- Modify: `web/src/core/types.ts` (append)
- Create: `web/src/core/findCore.ts`
- Modify: `web/src/core/urlState.ts` (`KNOWN_PARAMS`, `encodeHash`, `decodeHash`)
- Test: `web/test/find-core.test.ts` (create), `web/test/urlState.test.ts` (append)

**Interfaces:**
- Produces: `type FindMode = "cheapest" | "fill" | "attributes"` (types.ts).
- Produces: `reconcileCore(core: Set<StarId> | null, prev: Set<StarId>, next: Set<StarId>): Set<StarId> | null`.
- Produces: `encodeHash(selected, pointCap, canonical, benefits?, statCanonical?, baseline?, query?, source?, find?, findCore?: Set<StarId> | null, findMode?: FindMode): string`.
- Produces: `decodeHash(...)` returns an object that adds `findCore: Set<StarId> | null` and `findMode: FindMode`.

- [ ] **Step 1: Write the failing tests**

`web/test/find-core.test.ts`:

```ts
// ABOUTME: Tests the Find core's lifecycle: user clicks join or leave the core, Find's own suggestions
// ABOUTME: stay outside it, and a core that has caught up with the selection collapses to null.
import { test, expect } from "bun:test";
import { reconcileCore } from "../src/core/findCore";

const S = (...ids: string[]) => new Set(ids);

test("no core stays no core", () => {
  expect(reconcileCore(null, S("a:0"), S("a:0", "b:0"))).toBeNull();
});

test("a newly clicked star joins the core; suggestions stay out", () => {
  // core {a}, selection {a, sup} after Apply; the user clicks c
  const core = reconcileCore(S("a:0"), S("a:0", "sup:0"), S("a:0", "sup:0", "c:0"));
  expect([...core!].sort()).toEqual(["a:0", "c:0"]);
});

test("a removed star leaves the core", () => {
  const core = reconcileCore(S("a:0", "c:0"), S("a:0", "c:0", "sup:0"), S("a:0", "sup:0"));
  expect([...core!]).toEqual(["a:0"]);
});

test("removing every suggestion collapses the core to null (core = selection)", () => {
  expect(reconcileCore(S("a:0"), S("a:0", "sup:0"), S("a:0"))).toBeNull();
});

test("removing every core star collapses to null rather than an empty core", () => {
  expect(reconcileCore(S("a:0"), S("a:0", "sup:0"), S("sup:0"))).toBeNull();
});
```

Append to `web/test/urlState.test.ts`:

```ts
test("the Find mode round-trips as fm=; cheapest emits nothing", () => {
  for (const [mode, param] of [["fill", "fm=1"], ["attributes", "fm=2"]] as const) {
    const h = encodeHash(new Set(), 55, canonical, new Set(), [], null, "", "", false, null, mode);
    expect(h).toContain(param);
    expect(decodeHash(h, canonical, [])!.findMode).toBe(mode);
  }
  expect(encodeHash(new Set(), 55, canonical, new Set(), [], null, "", "", false, null, "cheapest")).not.toContain("fm=");
  for (const v of ["", "0", "3", "x"]) expect(decodeHash(`p=55&fm=${v}`, canonical, [])!.findMode).toBe("cheapest");
});

test("the Find core round-trips as fc= only when it differs from the selection", () => {
  const sel = new Set(["bat:0", "bat:1", "crossroads_chaos:0"]);
  const core = new Set(["bat:0", "bat:1"]);
  const h = encodeHash(sel, 55, canonical, new Set(), [], null, "", "", false, core);
  expect(h).toContain("fc=");
  expect([...decodeHash(h, canonical, [])!.findCore!].sort()).toEqual(["bat:0", "bat:1"]);
  expect(encodeHash(sel, 55, canonical, new Set(), [], null, "", "", false, new Set(sel))).not.toContain("fc=");
  expect(decodeHash("p=55&s=AA", canonical, [])!.findCore).toBeNull();
});

test("a stale fc= is clamped into the selection; empty or equal decodes as no core", () => {
  const sel = new Set(["bat:0", "bat:1"]);
  const s = encodeHash(sel, 55, canonical).match(/s=([^&]*)/)![1];
  const fcWide = encodeHash(new Set(["bat:0", "crossroads_chaos:0"]), 55, canonical).match(/s=([^&]*)/)![1];
  const d = decodeHash(`p=55&s=${s}&fc=${fcWide}`, canonical, [])!;
  expect([...d.findCore!]).toEqual(["bat:0"]);
  const fcOutside = encodeHash(new Set(["crossroads_chaos:0"]), 55, canonical).match(/s=([^&]*)/)![1];
  expect(decodeHash(`p=55&s=${s}&fc=${fcOutside}`, canonical, [])!.findCore).toBeNull();
  expect(decodeHash(`p=55&s=${s}&fc=${s}`, canonical, [])!.findCore).toBeNull();
  expect(decodeHash(`p=55&s=${s}&fc=!!`, canonical, [])!.findCore).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/find-core.test.ts test/urlState.test.ts`
Expected: FAIL. `findCore` is missing, and `findMode`/`findCore` are undefined on the decoded object.

- [ ] **Step 3: Implement**

Append to `web/src/core/types.ts`:

```ts
/** What Find optimizes: fewest added stars, that plus a tagged-attribute fill, or most tagged stars. */
export type FindMode = "cheapest" | "fill" | "attributes";
```

Create `web/src/core/findCore.ts`:

```ts
// ABOUTME: The Find core: the stars the user chose, as distinct from support Find suggested. Find computes
// ABOUTME: from the core so it can swap its own earlier suggestions out. null means "core = selection".
import type { StarId } from "./types";

/**
 * Carry the core across one selection change: stars the change added join it (the user clicked them),
 * stars it removed leave it. Wholesale replacements (import, save load, reset, baseline restore, a hash
 * without fc=) do not come through here; their callers reset the core to null instead. A core that ends
 * equal to the selection, or empty, collapses to null.
 */
export function reconcileCore(
  core: Set<StarId> | null,
  prev: Set<StarId>,
  next: Set<StarId>,
): Set<StarId> | null {
  if (!core) return null;
  const out = new Set<StarId>();
  for (const s of core) if (next.has(s)) out.add(s);
  for (const s of next) if (!prev.has(s)) out.add(s);
  // out is a subset of next, so equal size means equal sets.
  return out.size === 0 || out.size === next.size ? null : out;
}
```

In `web/src/core/urlState.ts`:
- Add `import type { FindMode } from "./types";` next to the existing types import. The file stays free of runtime dependencies.
- Change `KNOWN_PARAMS` to `["p", "s", "b", "q", "cs", "cp", "gt", "fd", "fc", "fm"] as const`.
- Make these edits to `encodeHash` and `decodeHash`:

```ts
// encodeHash: two new trailing parameters
  find = false,
  findCore: Set<StarId> | null = null,
  findMode: FindMode = "cheapest",
): string {
// ...after the fd=1 line:
  // The core rides only when Find's suggestions are part of the selection (core differs from it).
  if (findCore && findCore.size > 0 && findCore.size !== selected.size) out += `&fc=${encodeBitset(findCore, canonical)}`;
  if (findMode === "fill") out += "&fm=1";
  else if (findMode === "attributes") out += "&fm=2";
  return out;
```

```ts
// decodeHash return type gains:
  findCore: Set<StarId> | null;
  findMode: FindMode;
// ...before the return:
  // A stale core is clamped into the selection; an empty or equal one means "core = selection".
  const coreRaw = decodeBitset(params.get("fc") ?? "", canonical);
  const coreIn = new Set([...coreRaw].filter((s) => selected.has(s)));
  const findCore = coreIn.size > 0 && coreIn.size < selected.size ? coreIn : null;
  const fm = params.get("fm");
  const findMode: FindMode = fm === "1" ? "fill" : fm === "2" ? "attributes" : "cheapest";

  return { selected, pointCap, benefits, baseline, query, source, find, findCore, findMode };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/find-core.test.ts test/urlState.test.ts && bunx tsc --noEmit`
Expected: PASS, and tsc reports no errors. `main.ts` still compiles because the new parameters are optional.

- [ ] **Step 5: Commit**

```bash
bunx biome format --write src/core/types.ts src/core/findCore.ts src/core/urlState.ts test/find-core.test.ts test/urlState.test.ts
git add src/core/types.ts src/core/findCore.ts src/core/urlState.ts test/find-core.test.ts test/urlState.test.ts
git commit -m "feat(find): core reconciler and fc=/fm= URL state"
```

---

### Task 2: Exact OR-tagged fill (`findFill.ts`)

**Files:**
- Create: `web/test/support/synthModel.ts` (moves `modelOf` out of `web/test/support-finder.test.ts` and extends it)
- Modify: `web/test/support-finder.test.ts` (import `modelOf` from the support file and delete the local copy)
- Create: `web/src/core/findFill.ts`
- Test: `web/test/find-fill.test.ts`

**Interfaces:**
- Consumes: `selectionSummary`, `covers`, `type ReachCon` from `reachability.ts`.
- Produces: `fillTagged(model: DevotionModel, cons: ReachCon[], base: Set<StarId>, capacity: number, tagged: Set<StarId>): FillResult`.
- Produces: `interface FillResult { stars: Set<StarId>; added: number; tagged: number }`, where `stars` is the base plus the fill.
- Produces (test support): `modelOf(rcons: ReachCon[], tagged?: Set<string>, preds?: Record<string, number[][]>): DevotionModel`. Stars of the constellations in `tagged` carry bonus `t`. `preds[conId][i]` lists the predecessor indices of star `i`; the default is a chain.

- [ ] **Step 1: Move and extend the synthetic model builder**

Create `web/test/support/synthModel.ts`:

```ts
// ABOUTME: A DevotionModel built from synthetic ReachCons, for tests that need stars (Find, fill):
// ABOUTME: each constellation is a chain unless predecessors are given; tagged constellations carry bonus "t".
import type { ReachCon } from "../../src/core/reachability";
import { AFFINITIES, type Constellation, type DevotionModel, type Star, type StarId } from "../../src/core/types";

export function modelOf(
  rcons: ReachCon[],
  tagged: Set<string> = new Set(),
  preds: Record<string, number[][]> = {},
): DevotionModel {
  const stars = new Map<StarId, Star>();
  const constellations = new Map<string, Constellation>();
  const mapOf = (v: number[]) => Object.fromEntries(AFFINITIES.map((a, i) => [a, v[i]!]).filter(([, n]) => n));
  for (const c of rcons) {
    const starIds: StarId[] = [];
    for (let i = 0; i < c.size; i++) {
      const id = `${c.id}:${i}` as StarId;
      starIds.push(id);
      const p = preds[c.id]?.[i] ?? (i ? [i - 1] : []);
      stars.set(id, {
        id,
        constellationId: c.id,
        index: i,
        predecessors: p.map((j) => `${c.id}:${j}` as StarId),
        position: { x: 0, y: 0 },
        bonuses: tagged.has(c.id) ? { t: 1 } : {},
        celestialPower: null,
        weaponRequirement: null,
      });
    }
    constellations.set(c.id, {
      id: c.id,
      nameTag: c.id,
      descriptionTag: null,
      tier: 1,
      affinityRequired: mapOf(c.req),
      affinityBonus: mapOf(c.grant),
      background: null,
      starIds,
    });
  }
  return { stars, constellations };
}
```

In `web/test/support-finder.test.ts`:
- Delete the local `function modelOf(...)` and its doc comment.
- Add `import { modelOf } from "./support/synthModel";`.
- Remove the now-unused `Constellation`, `Star` and `AFFINITIES` from its types import.

Run: `bun test test/support-finder.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 2: Write the failing fill tests**

`web/test/find-fill.test.ts`:

```ts
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
    const pick = rc.filter((c) => rng() < 0.4);
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/find-fill.test.ts`
Expected: FAIL with "Cannot find module ../src/core/findFill".

- [ ] **Step 4: Implement `web/src/core/findFill.ts`**

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/find-fill.test.ts test/support-finder.test.ts && bunx tsc --noEmit`
Expected: PASS. If the brute-force test fails, print the trial's `rc`, `base`, `cap` and both results, and fix the DP. Do not loosen the assertion.

- [ ] **Step 6: Commit**

```bash
bunx biome format --write src/core/findFill.ts test/find-fill.test.ts test/support/synthModel.ts test/support-finder.test.ts
git add src/core/findFill.ts test/find-fill.test.ts test/support/synthModel.ts test/support-finder.test.ts
git commit -m "feat(find): exact OR-tagged fill under a capacity"
```

---

### Task 3: Shared covering walk, support candidates, and exported verification

**Files:**
- Modify (rewrite): `web/src/core/supportFinder.ts`
- Test: `web/test/support-finder.test.ts` (append)

**Interfaces:**
- Produces: `taggedStars(model: DevotionModel, tags: Iterable<string>): Set<StarId>` (now exported).
- Produces: `acceptsBuild(cons: ReachCon[], table: CoverTable, members: ReachCon[], cap: number): boolean`.
- Produces: `interface VerifiedOrder { order: BuildStep[]; states: StepState[]; peak: number }`.
- Produces: `verifiedOrder(cons: ReachCon[], table: CoverTable, members: ReachCon[], cap: number): VerifiedOrder | null`.
- Produces: `interface SupportCandidate { stars: Set<StarId>; members: ReachCon[]; added: number; tagged: number; key: string }`.
- Produces: `supportCandidates(model, cons, table, base: Set<StarId>, cap: number, tagged: Set<StarId>, nodeCap: number, maxCandidates: number): { candidates: SupportCandidate[]; exhaustive: boolean }`.
- Keeps: the `findSupport(model, cons, table, selected, cap, benefitTags)` contract and `FindFound` / `FindResult`, unchanged.

- [ ] **Step 1: Write the failing tests** (append to `web/test/support-finder.test.ts`; add `supportCandidates, verifiedOrder, acceptsBuild, taggedStars` to its import from `../src/core/supportFinder`)

```ts
describe("support candidates", () => {
  test("enumerates covering support sets, including the cheapest, each with a size and tagged count", () => {
    const sel = whole(model, "oleron");
    const t = taggedStars(model, ["offensivePhysicalModifier"]);
    const { candidates } = supportCandidates(model, cons, table, sel, 55, t, 200_000, 400);
    expect(candidates.length).toBeGreaterThan(1);
    const cheapest = found(findSupport(model, cons, table, sel, 55, []));
    expect(Math.min(...candidates.map((c) => c.added))).toBeLessThanOrEqual(cheapest.addedStars);
    for (const c of candidates) {
      for (const s of sel) expect(c.stars.has(s)).toBe(true);
      expect(c.stars.size).toBe(sel.size + c.added);
      expect(c.tagged).toBe([...c.stars].filter((s) => !sel.has(s) && t.has(s)).length);
    }
  });

  test("verifiedOrder returns an oracle-legal order exactly when the gate passes", () => {
    const r = found(findSupport(model, cons, table, whole(model, "oleron"), 55, []));
    const members = membersOf(model, r.stars);
    expect(acceptsBuild(cons, table, members, 55)).toBe(true);
    const v = verifiedOrder(cons, table, members, 55)!;
    expect(verifyBuildOrder(cons, members, v.order, 55)).toBeNull();
    expect(v.peak).toBe(r.peak);
    expect(verifiedOrder(cons, table, members, members.reduce((n, m) => n + m.size, 0) - 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/support-finder.test.ts`
Expected: FAIL. The functions are not exported from `../src/core/supportFinder`.

- [ ] **Step 3: Rewrite `web/src/core/supportFinder.ts`**

The phase logic and constants are kept. The DFS moves into a module-level `walkCovering`, which both searches share.

```ts
// ABOUTME: Find's support search: the covering builds over a base selection. findSupport picks the cheapest
// ABOUTME: (fewest added stars, tagged tie-break, verified order); supportCandidates lists many for the
// ABOUTME: attributes mode. Both share one covering walk modeled on the exact resolver.
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

/** A covering build over a base, before verification: the attributes mode ranks these. */
export interface SupportCandidate {
  stars: Set<StarId>; // base plus the support's stars
  members: ReachCon[]; // the build's members (finished partials at full size and grant)
  added: number;
  tagged: number; // added stars carrying a tagged attribute
  key: string; // canonical id list: the final tie-break
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
    return { chosen: [...chosen].sort(byId), finished: [...finished].sort(), added, score, key: keyOf(chosen, finished) };
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

/**
 * Covering support builds over `base` within `cap`, for the attributes mode: not only the cheapest. The
 * filler is every unstarted constellation that grants affinity OR carries a tagged star, tagged-dense
 * first so builds rich in tagged stars are met before the node cap. A covering build is listed without
 * the (costly) acceptance test; the caller ranks and then verifies. Keeps at most `maxCandidates`, by
 * tagged desc, added asc, key; `exhaustive` is false when the node cap stopped the walk or the list was trimmed.
 */
export function supportCandidates(
  model: DevotionModel,
  cons: ReachCon[],
  table: CoverTable,
  base: Set<StarId>,
  cap: number,
  tagged: Set<StarId>,
  nodeCap: number,
  maxCandidates: number,
): { candidates: SupportCandidate[]; exhaustive: boolean } {
  const st = canonicalSummary(model, base);
  const conTagged = (id: string): number =>
    (model.constellations.get(id)?.starIds ?? []).filter((s) => tagged.has(s) && !base.has(s)).length;
  const filler = cons
    .filter((c) => !st.startedIds.has(c.id) && (hasGrant(c) || conTagged(c.id) > 0))
    .sort((a, b) => conTagged(b.id) / b.size - conTagged(a.id) / a.size || ratio(b) - ratio(a) || byId(a, b));
  const limit = cap - st.own;
  let list: SupportCandidate[] = [];
  let trimmed = false;
  const rankC = (cs: SupportCandidate[]) =>
    [...cs].sort((a, b) => b.tagged - a.tagged || a.added - b.added || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const capHit = walkCovering(
    st,
    table,
    cap,
    filler,
    nodeCap,
    (b) => b > limit,
    (chosen, finished, added, members) => {
      const stars = starsOf(model, base, chosen, finished);
      let t = 0;
      for (const s of stars) if (!base.has(s) && tagged.has(s)) t++;
      list.push({ stars, members, added, tagged: t, key: keyOf(chosen, finished) });
      if (list.length > maxCandidates * 2) {
        list = rankC(list).slice(0, maxCandidates);
        trimmed = true;
      }
    },
  );
  const ranked = rankC(list);
  if (ranked.length > maxCandidates) trimmed = true;
  return { candidates: ranked.slice(0, maxCandidates), exhaustive: !capHit && !trimmed };
}

function rank(cs: Candidate[]): Candidate[] {
  return [...cs].sort((a, b) => a.added - b.added || b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
```

- [ ] **Step 4: Run the tests to verify they pass, unchanged behavior included**

Run: `bun test test/support-finder.test.ts && REACH_SLOW=1 bun test test/support-finder.test.ts && bunx tsc --noEmit`
Expected: PASS in both tiers. The original 10 tests pin the cheapest behavior, so the refactor must not change it.

- [ ] **Step 5: Commit**

```bash
bunx biome format --write src/core/supportFinder.ts test/support-finder.test.ts
git add src/core/supportFinder.ts test/support-finder.test.ts
git commit -m "refactor(find): shared covering walk; export support candidates and verification"
```

---

### Task 4: Mode orchestration, dropping, and the delta (`findBuild.ts`)

**Files:**
- Create: `web/src/core/findBuild.ts`
- Test: `web/test/find-build.test.ts`

**Interfaces:**
- Consumes: `findSupport`, `supportCandidates`, `acceptsBuild`, `verifiedOrder`, `taggedStars` (Task 3); `fillTagged` (Task 2); `FindMode` (Task 1).
- Produces:

```ts
export interface FindPlan {
  kind: "found";
  mode: FindMode; // the mode that produced it (a tagless fill/attributes request reports "cheapest")
  stars: Set<StarId>; // what Apply sets
  core: Set<StarId>; // the core kept (the input core minus dropped constellations)
  dropped: string[]; // core constellations removed to reach a legal build, canonical order
  addedStars: number; // stars.size - core.size
  tagged: number; // stars outside the core carrying a tagged attribute (true OR)
  peak: number;
  exhaustive: boolean; // false: a work cap was hit, so the preview says "best found"
  order: BuildStep[];
  states: StepState[];
}
export type FindOutcome = FindPlan | { kind: "none" };
export function findBuild(model, cons, table, core: Set<StarId>, cap: number, tags: Iterable<string>, mode: FindMode): FindOutcome;
export interface ConDelta { conId: string; from: number; to: number; total: number }
export function selectionDelta(model: DevotionModel, before: Set<StarId>, after: Set<StarId>): ConDelta[];
```

- [ ] **Step 1: Write the failing tests**

`web/test/find-build.test.ts`:

```ts
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
  });

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
  });
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
      if (p.exhaustive) expect(p.tagged).toBeGreaterThanOrEqual(truth);
      legal(m, rc, p, budget);
    }
  });
});

test("selectionDelta lists per-constellation star count changes in model order", () => {
  const before = new Set<StarId>([...whole(model, "oleron"), ...whole(model, "crane")]);
  const after = new Set<StarId>([...whole(model, "oleron"), ...model.constellations.get("hammer")!.starIds.slice(0, 2)]);
  const d = selectionDelta(model, before, after);
  const crane = d.find((x) => x.conId === "crane")!;
  const hammer = d.find((x) => x.conId === "hammer")!;
  expect(crane).toMatchObject({ from: model.constellations.get("crane")!.starIds.length, to: 0 });
  expect(hammer).toMatchObject({ from: 0, to: 2, total: model.constellations.get("hammer")!.starIds.length });
  expect(d.find((x) => x.conId === "oleron")).toBeUndefined();
});
```

The three OR stat ids (`defensivePhysical`, `offensiveTotalDamageModifier` = All Damage, `defensiveAbsorptionModifier`) were checked against `canonicalBenefitIds` while writing this plan.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/find-build.test.ts`
Expected: FAIL with "Cannot find module ../src/core/findBuild".

- [ ] **Step 3: Implement `web/src/core/findBuild.ts`**

```ts
// ABOUTME: Find's modes over the user's core: cheapest support, cheapest plus an OR-tagged fill, or the most
// ABOUTME: OR-tagged stars within the cap. Every plan carries a verified order; an unbuildable core drops its
// ABOUTME: smallest constellations until one exists. Also the per-constellation delta the preview lists.
import { fillTagged } from "./findFill";
import type { StepState } from "./orderLegality";
import { selectionSummary, type BuildStep, type CoverTable, type ReachCon } from "./reachability";
import {
  acceptsBuild,
  findSupport,
  supportCandidates,
  taggedStars,
  verifiedOrder,
  type VerifiedOrder,
} from "./supportFinder";
import type { DevotionModel, FindMode, StarId } from "./types";

// Work caps (counts, never wall-clock): the plan stays a pure function of (core, cap, tags, mode).
const MAX_DROPS = 6; // core constellations dropped before giving up
const FILL_RETRIES = 6; // smaller capacities tried when a filled build fails the oracle
const ATTR_NODE_CAP = 300_000; // covering-walk nodes for the attributes mode
const ATTR_CANDIDATES = 400; // support builds ranked by the attributes mode
const ATTR_VERIFY = 12; // top-ranked support builds filled and verified

export interface FindPlan {
  kind: "found";
  mode: FindMode;
  stars: Set<StarId>;
  core: Set<StarId>;
  dropped: string[];
  addedStars: number;
  tagged: number;
  peak: number;
  exhaustive: boolean;
  order: BuildStep[];
  states: StepState[];
}
export type FindOutcome = FindPlan | { kind: "none" };

export interface ConDelta {
  conId: string;
  from: number;
  to: number;
  total: number;
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

  function taggedOver(base: Set<StarId>, stars: Set<StarId>): number {
    let n = 0;
    for (const s of stars) if (!base.has(s) && tagged.has(s)) n++;
    return n;
  }
  function draftOf(base: Set<StarId>, stars: Set<StarId>, v: VerifiedOrder, exhaustive: boolean, m: FindMode): Draft {
    return {
      mode: m,
      stars,
      addedStars: stars.size - base.size,
      tagged: taggedOver(base, stars),
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
  /** The base plus the best verified fill: the DP's pick, retried at smaller capacities if the oracle rejects it. */
  function filled(base: Set<StarId>, built: Set<StarId>): { stars: Set<StarId>; v: VerifiedOrder } | null {
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
    const f = filled(base, c.stars);
    return f ? draftOf(base, f.stars, f.v, c.exhaustive, "fill") : { ...c, mode: "fill" };
  }
  function attributes(base: Set<StarId>): Draft | null {
    const viaFill = fill(base);
    const { candidates, exhaustive } = supportCandidates(
      model,
      cons,
      table,
      base,
      cap,
      tagged,
      ATTR_NODE_CAP,
      ATTR_CANDIDATES,
    );
    // Rank by the optimistic total (support's tagged plus its unverified fill), then verify the top few.
    const scored = candidates
      .map((c) => {
        const f = fillTagged(model, cons, c.stars, cap - c.stars.size, tagged);
        return { c, total: c.tagged + f.tagged, size: f.stars.size };
      })
      .sort((a, b) => b.total - a.total || a.size - b.size || (a.c.key < b.c.key ? -1 : a.c.key > b.c.key ? 1 : 0));
    let best: Draft | null = null;
    const better = (d: Draft, than: Draft | null) =>
      !than || d.tagged > than.tagged || (d.tagged === than.tagged && d.stars.size < than.stars.size);
    for (const { c } of scored.slice(0, ATTR_VERIFY)) {
      if (!acceptsBuild(cons, table, c.members, cap)) continue;
      const f = filled(base, c.stars);
      const v = f ? f.v : verifiedOrder(cons, table, c.members, cap);
      if (!v) continue;
      const d = draftOf(base, f ? f.stars : c.stars, v, true, "attributes");
      if (better(d, best)) best = d;
    }
    // Not exhaustive when the walk was capped, or an unverified candidate could still have beaten the winner.
    const unseen = scored.slice(ATTR_VERIFY).some((s) => !best || s.total > best.tagged);
    if (best) best.exhaustive = exhaustive && !unseen;
    if (viaFill && better({ ...viaFill, mode: "attributes" }, best))
      return { ...viaFill, mode: "attributes", exhaustive: viaFill.exhaustive && exhaustive && !unseen };
    return best;
  }
  function planFor(base: Set<StarId>): Draft | null {
    if (effective === "fill") return fill(base);
    if (effective === "attributes") return attributes(base);
    return cheapest(base);
  }
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

/** Per-constellation star counts that differ between two selections, in model order. */
export function selectionDelta(model: DevotionModel, before: Set<StarId>, after: Set<StarId>): ConDelta[] {
  const out: ConDelta[] = [];
  for (const c of model.constellations.values()) {
    let from = 0;
    let to = 0;
    for (const s of c.starIds) {
      if (before.has(s)) from++;
      if (after.has(s)) to++;
    }
    if (from !== to) out.push({ conId: c.id, from, to, total: c.starIds.length });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/find-build.test.ts && bunx tsc --noEmit`
Expected: PASS.
- If the synthetic attributes test fails on a seed, print the trial's model, core, budget, truth and plan.
- A plan whose `tagged` is below a verified whole-constellation build while `exhaustive` is true is a real bug in the candidate ordering or the `unseen` check. Fix it; do not loosen the test.

- [ ] **Step 5: Commit**

```bash
bunx biome format --write src/core/findBuild.ts test/find-build.test.ts
git add src/core/findBuild.ts test/find-build.test.ts
git commit -m "feat(find): cheapest, fill and most-attributes modes with dropping"
```

---

### Task 5: Mode selector, always-usable button, and delta preview (view + i18n)

**Files:**
- Modify: `web/src/adapters/buildOrderView.ts` (`FindButton`, `FIND_DISABLED_KEY`, `headingHtml`, `buildOrderHtml`, `transitionHtml`, `findPreviewHtml`)
- Modify: `web/src/i18n/app.en.json`, `web/test/appCatalog.test.ts`
- Test: `web/test/build-order-view.test.ts` (append)

**Interfaces:**
- Consumes: `FindOutcome`, `selectionDelta` (Task 4); `FindMode` (Task 1).
- Produces:
  - `type FindButton = { enabled: true; mode: FindMode } | { enabled: false; reason: "empty" | "uncapped" | "compare" | "previewing"; mode: FindMode }`
  - `findPreviewHtml(loc, model, manifest, outcome: FindOutcome, selection: Set<StarId>, cap: number, mode: FindMode, tagsActive: boolean): string`
  - DOM hooks: `select.bo-find-mode` (option values are the `FindMode` strings), `button.bo-find`, `button.bo-find-apply` (disabled when the result equals the selection), `button.bo-find-dismiss`, `.bo-find-summary`, `ul.bo-find-adds`, `ul.bo-find-removes`, `ul.bo-find-dropped`, `.bo-find-optimal`.

- [ ] **Step 1: Write the failing view tests** (append to `web/test/build-order-view.test.ts`, and add the imports shown)

```ts
import { findPreviewHtml } from "../src/adapters/buildOrderView";
import { buildCoverTable, buildReachCons } from "../src/core/reachability";
import { findBuild, type FindPlan } from "../src/core/findBuild";

const rcons = buildReachCons(model);
const rtable = buildCoverTable(rcons);
const oleron = new Set(model.constellations.get("oleron")!.starIds);

test("buildOrderHtml shows the mode selector and an enabled Find on any non-empty capped selection", () => {
  const html = buildOrderHtml(enLoc, model, null, [], null, { enabled: true, mode: "fill" });
  expect(html).toContain('class="bo-find-mode"');
  expect(html).toContain('<option value="fill" selected>');
  expect(html).toMatch(/<button type="button" class="bo-find" [^>]*>Find<\/button>/);
  expect(html).not.toMatch(/class="bo-find"[^>]*disabled/);
});

test("findPreviewHtml lists adds, the summary and the order, with Apply enabled", () => {
  const out = findBuild(model, rcons, rtable, oleron, 55, [], "cheapest") as FindPlan;
  const html = findPreviewHtml(enLoc, model, null, out, oleron, 55, "cheapest", false);
  expect(html).toContain("bo-find-adds");
  expect(html).toContain(`+${out.addedStars}`);
  expect(html).not.toContain("bo-find-removes");
  expect(html).toMatch(/<button type="button" class="bo-find-apply">/);
  expect(html).toContain("bo-list");
});

test("findPreviewHtml lists removed suggestions when the plan swaps them out", () => {
  const out = findBuild(model, rcons, rtable, oleron, 55, [], "cheapest") as FindPlan;
  // An earlier suggestion the plan no longer uses: a crossroads that is not in the plan.
  const extra = ["crossroads_chaos", "crossroads_order", "crossroads_primordial", "crossroads_eldritch", "crossroads_ascendant"]
    .map((id) => model.constellations.get(id)!.starIds[0]!)
    .find((s) => !out.stars.has(s))!;
  const html = findPreviewHtml(enLoc, model, null, out, new Set([...out.stars, extra]), 55, "cheapest", false);
  expect(html).toContain("bo-find-removes");
  expect(html).not.toContain("bo-find-optimal");
});

test("findPreviewHtml says already optimal and disables Apply when nothing changes", () => {
  const out = findBuild(model, rcons, rtable, oleron, 55, [], "cheapest") as FindPlan;
  const html = findPreviewHtml(enLoc, model, null, out, new Set(out.stars), 55, "cheapest", false);
  expect(html).toContain("bo-find-optimal");
  expect(html).toMatch(/class="bo-find-apply" disabled/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/build-order-view.test.ts`
Expected: FAIL. `FindButton` requires `mode`, and `findPreviewHtml` has the wrong arity.

- [ ] **Step 3: Implement**

In `web/src/adapters/buildOrderView.ts`:
- Replace the `import type { FindResult } ...` line with:

```ts
import { selectionDelta, type FindOutcome } from "../core/findBuild";
import type { FindMode, StarId } from "../core/types";
```

- Replace `FindButton`, `FIND_DISABLED_KEY` and `headingHtml` with:

```ts
// The Find controls beside the Build Order heading: a mode selector and the button. Find is usable on any
// non-empty selection under a finite cap, outside compare mode; disabled, its title says why.
export type FindButton =
  | { enabled: true; mode: FindMode }
  | { enabled: false; reason: "empty" | "uncapped" | "compare" | "previewing"; mode: FindMode };

const FIND_DISABLED_KEY: Record<Exclude<FindButton, { enabled: true }>["reason"], string> = {
  empty: "ui.buildOrder.findDisabledEmpty",
  uncapped: "ui.buildOrder.findDisabledUncapped",
  compare: "ui.buildOrder.findDisabledCompare",
  previewing: "ui.buildOrder.findDisabledPreviewing",
};
const FIND_MODES: FindMode[] = ["cheapest", "fill", "attributes"];

/** The panel heading with the Find controls beside it (none when `find` is omitted). */
function headingHtml(loc: Localization, find?: FindButton): string {
  const h = `<h2>${loc.translate("ui.panel.buildOrder")}</h2>`;
  if (!find) return h;
  const title = esc(loc.translate(find.enabled ? "ui.buildOrder.findTitle" : FIND_DISABLED_KEY[find.reason]));
  // The selector stays live while previewing (switching mode recomputes); only compare/uncapped/empty lock it.
  const lockMode = !find.enabled && find.reason !== "previewing";
  const options = FIND_MODES.map(
    (m) => `<option value="${m}"${m === find.mode ? " selected" : ""}>${loc.translate(`ui.buildOrder.findMode.${m}`)}</option>`,
  ).join("");
  const select = `<select class="bo-find-mode" aria-label="${esc(loc.translate("ui.buildOrder.findModeLabel"))}"${lockMode ? " disabled" : ""}>${options}</select>`;
  const btn = `<button type="button" class="bo-find" title="${title}"${find.enabled ? "" : " disabled"}>${loc.translate("ui.buildOrder.find")}</button>`;
  return `<div class="bo-head">${h}<span class="bo-find-ctl">${select}${btn}</span></div>`;
}
```

- In `transitionHtml`, change the heading call to `headingHtml(loc, { enabled: false, reason: "compare", mode: "cheapest" })`.
- Replace `findPreviewHtml` with:

```ts
/**
 * Find's preview: the mode's suggestion against the current selection, as per-constellation Adds and
 * Removes (Find's earlier suggestions it swaps out) and any core constellations Dropped to stay legal;
 * its added points and peak against the cap; the tagged count; the verified order; Apply and Dismiss.
 * A suggestion equal to the selection says so and disables Apply.
 */
export function findPreviewHtml(
  loc: Localization,
  model: DevotionModel,
  manifest: AssetManifest | null,
  outcome: FindOutcome,
  selection: Set<StarId>,
  cap: number,
  mode: FindMode,
  tagsActive: boolean,
): string {
  const head = headingHtml(loc, { enabled: false, reason: "previewing", mode });
  const dismiss = `<button type="button" class="bo-find-dismiss">${loc.translate("ui.buildOrder.findDismiss")}</button>`;
  if (outcome.kind === "none")
    return `${head}<div class="bo-empty"><div class="bo-empty-msg">${loc.translate("ui.buildOrder.findNone")}</div></div><div class="bo-find-actions">${dismiss}</div>`;
  const dropped = new Set(outcome.dropped);
  const delta = selectionDelta(model, selection, outcome.stars);
  const label = (d: { conId: string; to: number; total: number }) => {
    const name = esc(stepConName(loc, model, d.conId));
    return d.to > 0 && d.to < d.total
      ? `${name} <span class="bo-partial">${loc.translate("ui.buildOrder.partial", { taken: d.to, total: d.total })}</span>`
      : name;
  };
  const list = (cls: string, headKey: string, items: string[]) =>
    items.length
      ? `<div class="bo-find-sub">${loc.translate(headKey)}</div><ul class="${cls}">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`
      : "";
  const adds = delta.filter((d) => d.to > d.from).map(label);
  const removes = delta.filter((d) => d.to < d.from && !dropped.has(d.conId)).map(label);
  const drops = outcome.dropped.map((id) => esc(stepConName(loc, model, id)));
  const unchanged = adds.length === 0 && removes.length === 0;
  const summary = `<div class="bo-find-summary">${loc.translate("ui.buildOrder.findSuggested", { added: outcome.addedStars, peak: outcome.peak, cap })}</div>`;
  const optimal = unchanged ? `<div class="bo-find-optimal">${loc.translate("ui.buildOrder.findAlreadyOptimal")}</div>` : "";
  const best = outcome.exhaustive ? "" : `<div class="bo-note">${loc.translate("ui.buildOrder.findBestFound")}</div>`;
  const tagged = tagsActive
    ? `<div class="bo-empty-sub">${loc.translate("ui.buildOrder.findTagged", { count: outcome.tagged })}</div>`
    : "";
  const apply = `<button type="button" class="bo-find-apply"${unchanged ? " disabled" : ""}>${loc.translate("ui.buildOrder.findApply")}</button>`;
  return (
    `${head}<div class="bo-find-box">${summary}${optimal}${best}` +
    list("bo-find-adds", "ui.buildOrder.findAdds", adds) +
    list("bo-find-removes", "ui.buildOrder.findRemoves", removes) +
    list("bo-find-dropped", "ui.buildOrder.findDropped", drops) +
    `${tagged}<div class="bo-find-actions">${apply}${dismiss}</div></div>` +
    `<div class="bo-list">${stepRowsHtml(loc, model, manifest, outcome.order)}</div>`
  );
}
```

In `web/src/styles.css`, after the `.bo-find-actions` rule, add:

```css
.bo-find-ctl {
  display: flex;
  gap: 4px;
  align-items: baseline;
}
.bo-find-mode {
  background: #1b2531;
  border: 1px solid #283446;
  border-radius: 4px;
  color: #d7c89a;
  font-size: 0.68rem;
}
.bo-find-sub {
  margin-top: 4px;
  opacity: 0.7;
}
.bo-find-optimal {
  margin-top: 4px;
}
.bo-find-apply:disabled {
  opacity: 0.45;
  cursor: default;
}
```

i18n:
- In `web/src/i18n/app.en.json`, delete `ui.buildOrder.findDisabledComplete` and `ui.buildOrder.findFinishPartial`.
- Change `ui.buildOrder.findTitle` to `"Find the best build for the selected mode"`.
- Add these keys after `ui.buildOrder.findNone`:

```json
  "ui.buildOrder.findModeLabel": "Find optimizes for",
  "ui.buildOrder.findMode.cheapest": "Cheapest",
  "ui.buildOrder.findMode.fill": "Cheapest + fill",
  "ui.buildOrder.findMode.attributes": "Most attributes",
  "ui.buildOrder.findAdds": "Adds",
  "ui.buildOrder.findRemoves": "Removes",
  "ui.buildOrder.findDropped": "Dropped (could not be kept)",
  "ui.buildOrder.findAlreadyOptimal": "Your build is already optimal for this mode.",
```

In `web/test/appCatalog.test.ts` `REQUIRED`, remove the two deleted keys and add the eight new ones, using the same names.

- [ ] **Step 4: Run the tests**

Run: `bun test test/build-order-view.test.ts test/appCatalog.test.ts test/i18nBoundary.test.ts && bunx tsc --noEmit`
Expected: the view and catalog tests PASS. `tsc` FAILS only in `src/app/main.ts`, because `FindButton` now needs `mode` and `findPreviewHtml`'s arity changed. Task 6 fixes that; do not commit until it does. Treat Tasks 5 and 6 as one commit, made at the end of Task 6.

---

### Task 6: Controller wiring (core, mode, live recompute, Apply) and e2e

**Files:**
- Modify: `web/src/app/main.ts`
- Modify: `web/e2e/smoke.ts` (the Find block added earlier)

**Interfaces:**
- Consumes: `reconcileCore` (Task 1), `findBuild` / `FindOutcome` (Task 4), `findPreviewHtml` / `FindButton` (Task 5), and `decodeHash`'s `findCore` / `findMode`.

- [ ] **Step 1: Replace the Find state and imports**

In `main.ts`:
- Replace `import { findSupport, type FindResult } from "../core/supportFinder";` with:

```ts
import { findBuild, type FindOutcome } from "../core/findBuild";
import { reconcileCore } from "../core/findCore";
```

- Add `FindMode` to the existing `import type { Affinity, SelectionState, StarId } from "../core/types";`.
- Replace the block that starts `// Find's preview. findFor is...` and declares `findFor`, `pendingFind`, `findMemo`, `curFind` with:

```ts
  // Find. findOpen: the preview is showing (fd=1); it stays open across changes and recomputes. findCore:
  // the user's own picks when Find's suggestions are part of the selection (null = core is the selection),
  // carried across clicks by reconcileCore against coreBase (the selection it was last reconciled with) and
  // reset by wholesale replacements. findMode: what Find optimizes (fm=). pendingFind asks the next refresh
  // to open the preview once the cap has settled (a Find click, or fd=1 in a restored link).
  let findOpen = false;
  let pendingFind = false;
  let findCore: Set<StarId> | null = null;
  let coreBase = new Set<StarId>();
  let findMode: FindMode = "cheapest";
  let findMemo: { key: string; result: FindOutcome } | null = null;
  let curFind: FindOutcome | null = null;
```

- [ ] **Step 2: Restore and reset**

In `applyHash`, replace the two Find lines (`findFor = null; pendingFind = ...`) with:

```ts
    findOpen = false;
    pendingFind = restored?.find ?? false;
    findCore = restored?.findCore ?? null;
    coreBase = new Set(state.selected);
    findMode = restored?.findMode ?? "cheapest";
```

Add `findCore = null;` on the line before the `refresh(...)` call in each wholesale replacement:
- the Reset button handler (`state = { selected: new Set(), pointCap: state.pointCap };`);
- `cmp-revert` and `cmp-swap`;
- the grimtools import (`state = { selected: repairSelection(...wanted, cap), pointCap: cap };` followed by `source = slug;`);
- the save-file load (`state = { selected: repairSelection(...), pointCap: cap };` followed by `source = "";`).

- [ ] **Step 3: Reconcile once per refresh, and rewrite the Find block**

At the very start of `refresh(...)`, before `dimCache.clear();`, add:

```ts
    // Clicks join or leave the core; Find's own suggestions stay outside it (see core/findCore.ts).
    findCore = reconcileCore(findCore, coreBase, state.selected);
    coreBase = new Set(state.selected);
```

Replace the block from `// Find is offered only for an incomplete selection...` through `else paintBuildOrder(curBuildOrder, boInfo, findBtn);` with:

```ts
    // Find is usable on any non-empty selection under a finite cap, outside compare mode.
    const capped = !!table && Number.isFinite(state.pointCap);
    const findBtn: FindButton = baseline
      ? { enabled: false, reason: "compare", mode: findMode }
      : !capped
        ? { enabled: false, reason: "uncapped", mode: findMode }
        : state.selected.size === 0
          ? { enabled: false, reason: "empty", mode: findMode }
          : { enabled: true, mode: findMode };
    if (pendingFind) {
      pendingFind = false;
      if (findBtn.enabled) findOpen = true;
    }
    if (!findBtn.enabled) findOpen = false;
    curFind = null;
    if (findOpen && table) {
      const core = findCore ?? state.selected;
      const tags = [...selectedBenefits].sort();
      const memoKey = `${selectionKey(core)}|${state.pointCap}|${tags.join(",")}|${findMode}`;
      if (findMemo?.key !== memoKey)
        findMemo = { key: memoKey, result: findBuild(model, cons, table, core, state.pointCap, tags, findMode) };
      curFind = findMemo.result;
    }
    if (curTransition) paintTransition(curTransition);
    else if (curFind) paintFind(curFind);
    else paintBuildOrder(curBuildOrder, boInfo, findBtn);
```

- [ ] **Step 4: Paint functions, Apply, mode changes, hash**

- In `paintBuildOrder`, after the `.bo-find` click listener, add `wireFindMode(panel);`.
- Replace `paintFind` with the version below, and add `wireFindMode` next to it:

```ts
  // Switching the mode recomputes (and, with the preview open, re-previews) through refresh.
  function wireFindMode(panel: HTMLElement) {
    panel.querySelector<HTMLSelectElement>(".bo-find-mode")?.addEventListener("change", (e) => {
      findMode = (e.currentTarget as HTMLSelectElement).value as FindMode;
      refresh();
    });
  }
  // Find's preview in place of the order. Apply makes the suggestion the selection (one history entry, so
  // Back undoes it) and records the core it kept, so a later Find can swap these suggestions out.
  function paintFind(result: FindOutcome) {
    hideBoPop();
    const panel = boPanel();
    const tagsActive = [...selectedBenefits].some((t) => {
      const tag = parseTag(t);
      return !!tag && tag.kind !== "affinity";
    });
    panel.innerHTML = findPreviewHtml(
      localization,
      model,
      data.manifest,
      result,
      state.selected,
      state.pointCap,
      findMode,
      tagsActive,
    );
    wireBoRows(panel);
    wireFindMode(panel);
    panel.querySelector(".bo-find-apply:not(:disabled)")?.addEventListener("click", () => {
      if (curFind?.kind !== "found") return;
      state = { selected: new Set(curFind.stars), pointCap: state.pointCap };
      findCore = curFind.core.size < curFind.stars.size ? new Set(curFind.core) : null;
      coreBase = new Set(curFind.stars);
      findOpen = false;
      refresh();
    });
    panel.querySelector(".bo-find-dismiss")?.addEventListener("click", () => {
      findOpen = false;
      refresh();
    });
  }
```

- In `writeHash`, change the encode call's trailing arguments from `source, findFor !== null)` to `source, findOpen, findCore, findMode)`.
- Remove every remaining reference to `findFor`. Then run `grep -n "findFor\|findSupport\|FindResult" src/app/main.ts` and expect no output.

- [ ] **Step 5: Typecheck, lint, and run the full suite**

Run: `bunx tsc --noEmit && bunx biome lint --error-on-warnings && bun test`
Expected: tsc and lint are clean. Every test passes except the known `reach-peakcost.test.ts` timeout, which also fails on `main` on this machine. If any other test fails, fix it before continuing.

- [ ] **Step 6: Update the e2e Find block**

In `web/e2e/smoke.ts`, inside the `// --- Find: ...` block, replace the check `"Find is disabled once the build covers its own affinity"` and everything after it, up to and including the `"Dismiss leaves the selection unchanged"` check, with:

```ts
  check(
    !(await cdp.evaluate<boolean>("document.querySelector('.bo-find').disabled")),
    "Find stays usable on a complete build",
  );
  check((await cdp.evaluate<string>("location.hash")).includes("fc="), "Apply records the core (fc=)");
  await cdp.evaluate("document.querySelector('.bo-find').click()");
  check(
    await waitFor("!!document.querySelector('.bo-find-optimal')"),
    "Find right after Apply says the build is already optimal",
  );
  // Switch to Most attributes with the preview open: it recomputes in place and the mode rides in the URL.
  await cdp.evaluate(
    `(() => { const s = document.querySelector('.bo-find-mode'); s.value = 'attributes'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  check(
    await waitFor("location.hash.includes('fm=2') && !!document.querySelector('.bo-find-box')"),
    "changing the mode with the preview open recomputes it (fm=2)",
  );
  check(
    await waitFor("!!document.querySelector('.bo-find-adds') || !!document.querySelector('.bo-find-optimal')"),
    "the attributes preview lists adds or says optimal",
  );
  const modeHash = await cdp.evaluate<string>("location.hash");
  await cdp.evaluate(`location.hash = "p=55"`);
  await waitFor("!document.querySelector('.bo-find-box')");
  await cdp.evaluate(`location.hash = "${modeHash.slice(1)}"`);
  check(
    await waitFor("!!document.querySelector('.bo-find-box') && document.querySelector('.bo-find-mode').value === 'attributes'"),
    "a link restores the mode, the core and the open preview",
  );
  await cdp.evaluate("document.querySelector('.bo-find-dismiss').click()");
  check(
    await waitFor("!document.querySelector('.bo-find-box') && !location.hash.includes('fd=')"),
    "Dismiss drops the preview and its flag",
  );
  check(
    (await cdp.evaluate<string>("document.getElementById('point-bar').textContent")).includes("31 used"),
    "Dismiss leaves the selection unchanged",
  );
```

Also delete the earlier `"Back after Apply returns to the preview"` check and its `history.back()`. The flow above now continues from the applied build.

- [ ] **Step 7: Build and run the e2e**

Run (from the repo root): `just build && just e2e`
Expected: `E2E PASS` in all four smoke files.

- [ ] **Step 8: Commit Tasks 5 and 6 together**

```bash
bunx biome format --write src test e2e
git add -A src test e2e
git commit -m "feat(planner): Find modes, always-usable Find, and a re-optimizable core

The Find button works on any capped selection. A mode selector picks
Cheapest, Cheapest + fill, or Most attributes (true-OR tagged stars).
The preview recomputes on change and lists Adds, Removes (earlier
suggestions swapped out) and Dropped. Apply records the user's core
(fc=), so a later Find can replace its own suggestions."
```

---

### Task 7: Corpus timing, evergreen docs, and the PR

**Files:**
- Create: `web/scripts/find-perf.ts`
- Modify: `docs/reachability-engine.md` (rewrite the "Find: the supporting-build suggester" section in place)
- Modify: `BACKLOG.md` (the Find follow-ups entry)

- [ ] **Step 1: Add the timing script**

`web/scripts/find-perf.ts`:

```ts
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
```

Run: `bun scripts/find-perf.ts && bun scripts/find-perf.ts --tags`
Expected: `none=0` and `illegal=0` for every mode. Cheapest stays near p95 ~110 ms.
- If `attributes` has p95 > 1000 ms or max > 3000 ms, lower `ATTR_NODE_CAP` and `ATTR_CANDIDATES` in `findBuild.ts` (halve both) and re-run. Record the final numbers.
- If the `bestFound` count is a large share for `attributes`, report it in the PR rather than raising the caps past the time budget.

- [ ] **Step 2: Rewrite the evergreen doc section**

In `docs/reachability-engine.md`, replace the whole `## Find: the supporting-build suggester` section, in place, with a `## Find` section. It describes the current behavior only:
- **Purpose and controls:** the button is usable on any capped selection outside compare mode, with a mode selector (`fm=`), an open preview (`fd=1`) that recomputes on change, and Apply / Dismiss.
- **The core:** what it is, how clicks update it (`reconcileCore`), and which wholesale replacements reset it. `fc=` is encoded only when the core differs from the selection; a stale `fc=` is clamped.
- **The three modes:** what each optimizes, true-OR scoring (a star counts once if it carries any tagged player or pet attribute; affinity tags never score), and that tagless requests run as Cheapest.
- **Cheapest:** keep the existing two-phase description (added stars vs. peak, the shuffled-witness acceptance, verify through the panel path, greedy fallback).
- **Fill:** the eligibility rule (constellations the build already covers), per-constellation closed subsets, the exact knapsack, and the oracle retry at smaller capacities.
- **Most attributes:** the candidate walk (tagged-dense first, no acceptance test while listing), ranking by optimistic total, verifying the top `ATTR_VERIFY`, and never scoring below fill. When the result is "best found" (`exhaustive: false`).
- **Dropping:** a safety net. It drops the smallest core constellation and retries, and lists what it dropped.
- **Measured numbers:** the `find-perf.ts` lines from Step 1, and which test files pin what.

- [ ] **Step 3: Update BACKLOG**

In `BACKLOG.md`, in the "Find follow-ups" entry:
- Delete the bullet about "Productive support". The fill and attributes modes deliver it.
- Add one bullet: "Weight attribute matches (stat magnitude, or covering every tagged attribute at least once) if true-OR counting proves too coarse: `fillTagged` scores options per star; a weight map from `taggedStars` would slot in there."
- Keep the map-highlight, Worker and translation bullets.

- [ ] **Step 4: Run the full gates**

Run (from `web/`): `bunx tsc --noEmit && bunx biome lint --error-on-warnings && bun test && REACH_SLOW=1 bun test test/support-finder.test.ts test/find-fill.test.ts test/find-build.test.ts`
Then run (from the repo root): `just e2e && just perf`
Expected:
- Everything is green except the known `reach-peakcost` timeout.
- The `just perf` median is within noise of the earlier 17 ms. Find runs on demand, never per click.

- [ ] **Step 5: Commit, push, and update the PR**

```bash
git add web/scripts/find-perf.ts docs/reachability-engine.md BACKLOG.md
git commit -m "docs(find): modes, core and fill in the engine reference; timing script"
git push
cd web
{ gh pr view 1 -R thematrimix/grimdawn-devotions --json body -q .body
  printf '\n\n## Modes update\n\nSpec: docs/superpowers/specs/2026-10-08-find-modes-design.md. find-perf over the real-builds corpus (no tags, then the three OR tags):\n\n```\n'
  bun scripts/find-perf.ts
  bun scripts/find-perf.ts --tags
  printf '```\n'
} > /tmp/find-pr-body.md
gh pr edit 1 -R thematrimix/grimdawn-devotions --body-file /tmp/find-pr-body.md
```

Expected: the PR body keeps its original text, followed by a "Modes update" section with six measured lines.
