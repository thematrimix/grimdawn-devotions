# Find: suggest the cheapest supporting build

Status: design, approved 2026-10-08. Point-in-time record; when shipped, the evergreen
description lives in `docs/reachability-engine.md` ("Find: supporting build suggester").


## Context

Today the build-order panel only orders a **self-covering** selection. When the
user's stars need affinity they don't supply, the panel says "Incomplete build:
needs X. Add supporting constellations that grant it." and leaves the user to work
out which ones. This is the backlog item "Supporting-set suggester" (BACKLOG.md,
Guided build order follow-ups).

Goal: put a **Find** button next to the Build Order heading. It searches for the
**fewest added stars** (whole supporting constellations, plus optionally finishing
partially-taken ones) that turn the selection into a legal, self-covering build
whose construction peak fits the point cap. Among equal-cost answers it prefers
the one carrying the most stars with the user's tagged "Available to get"
attributes (`selectedBenefits`). The result is shown as a **preview**: the added
constellations and the verified build order of the completed build, with
**Apply** and **Dismiss**. Nothing changes until Apply is clicked.

Decisions made with the user: objective = "cheapest, prefer attributes"
(leftover points stay unspent); result UX = "preview, then Apply".

## Two numbers, kept apart

- **Added stars**: final-build size minus the current selection. This is what Find
  minimizes.
- **Construction peak**: most points held at once, including transient
  scaffolding. This must be ≤ `state.pointCap`, but it is not the objective.
  `minCost`/`selectionMinCost` measure the peak and must not be used as the
  optimality check. The preview shows both ("+N stars · peak M of cap").

## Core: `web/src/core/supportFinder.ts` (new, pure)

`findSupport(model, cons, table, selected: Set<StarId>, cap: number, benefitTags: readonly string[]): FindResult`

```ts
type FindResult =
  | { kind: "found"; stars: Set<StarId>; added: string[] /* con ids */; finished: string[];
      addedStars: number; peak: number; score: number; exhaustive: boolean;
      order: BuildStep[]; states: StepState[] }
  | { kind: "none" };
```

1. `st = selectionSummary(model, selected)`. Filler = unstarted constellations
   that grant affinity (same set `reachableExactFrom` uses). Partials in
   `st.partialFinish` may be finished or left, as in the resolver's outer mask loop.
2. **Score.** For each tag in `benefitMarkOrder(benefitTags, benefitCanonical)`
   (affinity tags already excluded), union `starValuesGranting` /
   `starValuesGrantingPet` (`web/src/core/aggregate.ts`) into one star set.
   Score of a candidate = how many of its *added* stars (new constellations plus
   finished partials' remaining stars) are in that set.
3. **Seed the incumbent** from greedy. Expose greedy's placed pool alongside
   `greedyFrom` without changing its verdict: either a new exported
   `greedyWitness(cons, st, budget)` sharing the body, or a module-global like
   `lastGreedyBootColors`. Map `#finish` ids back to partials. Without the seed,
   a search over about 88 fillers with no memo can blow up.
4. **Branch-and-bound DFS** modeled on `reachableExactFrom`, but kept separate.
   It does not stop at the first hit; it ranks candidates by
   `(addedStars asc, score desc, peak asc, canonical id list)`.
   - Prune when `cost + coverCostAt(table, deficit) > best.addedStars`. Use
     strict `>` so equal-cost alternatives survive for the tie-break. Use `>=`
     only when the incumbent's score already equals the score upper bound
     possible at that cost.
   - At a covering node (`covers(...)`), the candidate is accepted if
     `peakGateReachable(...)` or `minPeakSampled(...) <= cap`, the same
     acceptance test the resolver uses. Covering supersets are pruned, as in the
     resolver.
   - The node cap is a **count of work** (`FIND_NODE_CAP`), never wall-clock, so
     the result is a pure function of (selection, cap, tags). If the cap is hit,
     `exhaustive: false`.
   - Keep the top K (≈8) accepted candidates.
5. **Verify through the real path.** For each ranked candidate, and finally the
   greedy seed as a fallback, build the star set (selection + all stars of the
   added constellations + remaining stars of finished partials). Run
   `selectionView(model, cons, table, stars, cap)`. The first candidate with a
   non-null (oracle-gated) `buildOrder` wins. This keeps Find consistent with
   what the panel would show after Apply, even where the DFS acceptance test and
   `buildOrderPath` disagree.
6. Return `none` only if every candidate fails.

**The engine is left untouched.** Only export existing helpers from
`web/src/core/reachability.ts` (`covers`, `coverCostAt`, `peakGateReachable`,
`fillerFor`, plus the greedy witness accessor) with no behavior change. No
classify/resolver verdict changes, so no Rust/WASM mirroring is needed.

## When Find is enabled

Find is enabled only when the panel is in the `"incomplete"` state: a capped
selection with a table and a non-empty affinity deficit. It is disabled, with a
tooltip saying why, in these cases:

- Empty selection.
- Already self-covering, or the `"searched"` state. Adding support cannot lower
  the peak.
- Uncapped or no-table (degraded) mode.
- Compare mode, where the panel shows a transition.

Because the cap is auto-raised to the validity floor, an incomplete selection
is always reachable. So `none` should never happen, and the corpus test below
pins that.

## URL state (invariant)

The preview is derived, but it is visible state, so it is bookmarkable. Add a
flag (e.g. `fd=1`) to `encodeHash`/`decodeHash` in `web/src/core/urlState.ts`.
On load, or whenever the hash carries it, recompute `findSupport`. This is
deterministic, so the link shows the same suggestion. Any selection, cap, or tag
change drops the flag, which clears the preview. A malformed or stale flag on a
non-incomplete selection is ignored. Add round-trip and stale-link tests in the
existing urlState test file.

## UI

- `web/src/adapters/buildOrderView.ts`: render the Find button in the Build
  Order `<h2>` row, in both the empty-state and list branches. Add a
  `findPreviewHtml(loc, model, result)` that shows:
  - a header: "Suggested: +N stars · peak M of cap", plus "best found (search
    limit reached)" when `!exhaustive`;
  - the added constellations, and finished partials marked as such, with the
    tagged-attribute star count when tags are selected;
  - the verified order, reusing the existing step-list rendering;
  - Apply and Dismiss buttons.
- `web/src/app/main.ts`:
  - Add `findActive` state alongside `curBuildOrder`.
  - Wire the button in `paintBuildOrder`/`wireBoRows`.
  - Find: set the flag, compute, then `refresh("push")`.
  - Apply: `state = { selected: result.stars, pointCap }`, clear the flag, then
    `refresh("push")`. Browser Back undoes it, as with any selection change.
  - Dismiss: clear the flag.
  - The `"incomplete"` branch at ~main.ts:929-940 picks the preview when the
    flag is set.
  - Run synchronously on click. If timing shows a noticeable delay, show a
    "Searching…" state for one frame first (`requestAnimationFrame`). No Web
    Worker; that is already a separate backlog item.
- Styles in `web/src/styles.css` follow the existing `.bo-*` classes.

## i18n

Add new keys to `web/src/i18n/app.en.json` only. Recent features rely on the
per-key English fallback. Also add each key to `web/test/appCatalog.test.ts`.
Keys: `ui.buildOrder.find`, `.findTitle`, `.findDisabled*` (one per reason),
`.findSuggested`, `.findBestFound`, `.findFinishPartial`, `.findTagged`,
`.findApply`, `.findDismiss`, `.findNone`. No literals in app code.

## Docs and backlog

- `docs/reachability-engine.md`: add an evergreen section, "Find: supporting
  build suggester". Cover the objective, the two numbers, the tie-break, the
  verify-through-`selectionView` rule, and the work cap.
- `BACKLOG.md`: replace the "Supporting-set suggester" entry with what remains
  deferred:
  - "productive" support beyond tie-break, i.e. spending leftover points on
    attributes;
  - map highlight of suggested stars;
  - Worker offload.
- Resolve or record the Ulo note. It is likely final size (9) versus peak (11).
  Pin it with a test.

## Tests (`bun test`, new `web/test/support-finder.test.ts`)

- **Corpus consistency.** Every incomplete selection derivable from
  `web/test/fixtures/reachable-builds.json` and `real-builds.json`, built by
  dropping a supporting constellation from a self-covering build, gets a
  `found` result. Its `order` must pass `verifyBuildOrder` at the cap, and the
  found stars must contain the selection.
- **Optimality.** On small synthetic models (reuse `test/support/reach-oracle.ts`
  model builders and `mulberry32`), brute-force every filler subset and assert
  `addedStars` equals the true minimum when `exhaustive`. Also assert that the
  score is the maximum among the minimum-cost subsets.
- **Named cases.** Oleron (backlog spike: +24 support / 31 total; confirm this
  against brute force first), Light of Empyrion, and Ulo.
- **Tie-break.** A tag carried by one of two equal-cost supports flips the
  choice.
- **Determinism.** Two calls return identical output, and so do calls with
  permuted input set order.
- **No-op states.** Self-covering and empty selections leave Find disabled.
- **Partial finish.** A selection whose cheapest completion finishes a partial
  returns it in `finished`.

## Verification

1. `just test`, `just typecheck`, `just lint`.
2. Gates confirming the engine is untouched: `just validate-wasm`, `just perf`
   (per-click latency unchanged), and `just test-slow`.
3. Time `findSupport` on the corpus. Report the p50, p95, and max, plus how many
   results hit the node cap.
4. `just build`, then drive the app with the `run` skill or Playwright:
   - Select Oleron's stars. Tag an attribute in "Available to get". Click Find.
   - Check the preview: added list, "+N · peak", and a verified order.
   - Copy the URL into a new tab and check that the same preview appears.
   - Click Apply. The map and selection update and the order shows; Back restores
     the selection.
   - Dismiss clears the preview.
   - The button is disabled on a self-covering build and in compare mode.
5. `just e2e` still passes. Add a smoke check for Find → Apply.
