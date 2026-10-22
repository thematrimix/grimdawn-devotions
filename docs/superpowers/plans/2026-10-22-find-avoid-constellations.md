# Find: Avoided Constellations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-clicking a constellation toggles an "avoid" mark; Find never leaves an added star of an avoided constellation in its final build, and says so (naming the culprits) when that makes the goal unreachable.

**Architecture:** The avoid set is a set of constellation ids threaded as an optional trailing parameter through `findSupport`, `fillTagged` and `findBuild` (default empty = today's behavior). It only filters which constellations may be *added to the final build*; the order engine's scaffold pool (`peakToReach` uses all of `cons`) is untouched, so refunded scaffolding through an avoided constellation already works and the oracle stays unaware of avoids. State lives in the URL hash as `av=<comma-separated constellation ids>`. A new `FindOutcome` variant `blocked` carries the avoided ids that were the cause.

**Tech Stack:** TypeScript, Bun test (`cd web && bun test <file>`), vanilla SVG renderer, `just check` as the final gate.

**Spec:** `docs/superpowers/specs/2026-10-22-find-avoid-constellations-design.md`

## Global Constraints

- Right-click on a constellation toggles the mark; the browser menu is suppressed only when the click resolves to a constellation or star.
- Avoid restricts Find only, never manual selection, dimming, reachability or the build-order panel.
- Hand-picked stars of an avoided constellation are ordinary base selection; Find never adds or finishes further stars of it.
- Temporary scaffolding through an avoided constellation is allowed if refunded (final set holds none of the added avoided stars).
- Blocked verdict shows a message distinct from `ui.buildOrder.findNone` and names the avoided constellations.
- State round-trips through `encodeHash`/`decodeHash` in `web/src/core/urlState.ts`, tolerates stale/malformed values, and an empty avoid set leaves the hash byte-identical to today.
- No hardcoded user-facing strings: catalog keys in `web/src/i18n/app.en.json`, added to the `web/test/appCatalog.test.ts` guard.
- Find stays a pure function of its inputs (node caps, no wall-clock); every plan is still oracle-verified.
- Update `docs/reachability-engine.md` ("Find") in place; no changelog sections.

## Review Focus

- A constellation the user partly took that is avoided: Find must not finish it, and the user's stars stay selected.
- `av=` with unknown ids, duplicates, empty items or hundreds of entries: ignored/clamped, never throws, never changes the selection.
- Over-cap vs blocked: when no plan exists even without avoids, the existing `findNone` message shows, not the blocked one.
- Avoided id equal to a crossroads (`crossroads_*`): behaves like any constellation.
- Empty avoid set: results and hash identical to before (regression).

Design calls made while planning (flag to the user): (1) the avoid set is encoded as constellation ids, not a bitset, because there is no published constellation wire order and ids are short; (2) `findBuild`'s drop-core fallback must not silently drop the user's constellations to dodge an avoid, so "blocked" is decided by comparing against the avoid-free run (Task 2); (3) touch has no gesture in this plan (BACKLOG entry, Task 6).

---

### Task 1: `findSupport` honors an avoid set

**Files:**
- Modify: `web/src/core/supportFinder.ts` (`findSupport`, ~line 235)
- Test: `web/test/support-finder.test.ts`

**Interfaces:**
- Produces: `findSupport(model, cons, table, selected, cap, benefitTags, avoid: ReadonlySet<string> = new Set()): FindResult`. Constellation ids in `avoid` are excluded from `filler` and from `st.partialFinish`.

- [ ] **Step 1: Write failing tests** in `support-finder.test.ts` (use the file's existing real-model setup): (a) take a selection whose unconstrained `findSupport` returns `added` containing id `X`; with `avoid = new Set([X])` the result is either `none` or has no star of `X` beyond `selected`, and when found `verifyBuildOrder` returns null; (b) a selection that partly takes constellation `P` and where unconstrained Find lists `P` in `finished`: with `avoid={P}` the result's `finished` excludes `P` and every star in `selected` is still in `stars`; (c) `avoid` empty gives a `stars` set equal to the no-argument call for the same inputs.
- [ ] **Step 2: Run** `cd web && bun test test/support-finder.test.ts` — expect the new tests to FAIL (extra argument ignored).
- [ ] **Step 3: Implement.** After `canonicalSummary`, filter `filler` with `!avoid.has(c.id)` and replace `st` with a copy whose `partialFinish` drops avoided ids (`conScore` loop over `st.partialFinish` then uses the filtered list). The greedy fallback (`greedyFrom`/`lastGreedyFiller`) is not avoid-aware, so after `greedyCandidate()` returns, reject it (treat as no winner) if `chosen` includes an avoided id or `finished` includes one.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Scaffolding test.** Add `test("an avoided constellation may appear as refunded scaffolding")`: search the real map (a small loop over a few `whole(...)` selections, as the file already does) for a found plan whose `order` contains a `scaffold-add` step for constellation `S` that is not in the final set; then with `avoid={S}` assert the plan is still found and its order still contains a `scaffold-add` for `S` followed by its `scaffold-refund`, with no `S` star in `stars`. If real data has no such case, build one with `modelOf` from `test/support/synthModel.ts`. Run; expect PASS (no code change should be needed; if it fails, scaffolding is being filtered somewhere it should not be).
- [ ] **Step 6: Commit** `feat(find): findSupport takes an avoid set`.

### Task 2: `fillTagged` and `findBuild` honor avoids; blocked outcome

**Files:**
- Modify: `web/src/core/findFill.ts`, `web/src/core/findBuild.ts`
- Test: `web/test/find-fill.test.ts`, `web/test/find-build.test.ts`

**Interfaces:**
- Consumes: Task 1's `findSupport(..., avoid)`.
- Produces:
  - `fillTagged(model, cons, base, capacity, tagged, avoid: ReadonlySet<string> = new Set()): FillResult` — skips avoided constellations as fill items.
  - `findBuild(model, cons, table, core, cap, tags, mode, avoid: ReadonlySet<string> = new Set()): FindOutcome`
  - `export interface FindBlocked { kind: "blocked"; avoided: string[] }` (canonical id order); `FindOutcome = FindPlan | { kind: "none" } | FindBlocked`.

- [ ] **Step 1: Write failing tests.** `find-fill.test.ts`: with a tagged set that a known-eligible constellation `Y` carries, `fillTagged(..., avoid={Y})` returns no star of `Y`. `find-build.test.ts`, per mode (`cheapest`, `fill`, `attributes`): no returned plan has a gained star (vs `core`) in an avoided constellation. Blocked: on a synthetic model (`modelOf`) where the only supporter of the core is `S`, `findBuild(..., avoid={S})` returns `{kind:"blocked", avoided:["S"]}`; with a cap too small even without avoids it returns `{kind:"none"}`; an avoid id that the unconstrained plan does not use returns `{kind:"none"}` (not blocked) when the constrained run fails for another reason. Drop-fallback: where unconstrained is found with `dropped=[]` and constrained would only succeed by dropping a core constellation, expect `blocked`, not a plan with drops.
- [ ] **Step 2: Run** `cd web && bun test test/find-fill.test.ts test/find-build.test.ts` — expect FAIL.
- [ ] **Step 3: Implement fill/attributes filtering.** In `fillTagged`'s constellation loop `continue` when `avoid.has(con.id)`; in `findBuild`, pass `avoid` into `findSupport` (in `cheapest`), `fillTagged` (in `filled`), and skip avoided constellations in `blockedCandidates`.
- [ ] **Step 4: Implement the blocked verdict** by renaming the existing body to an inner `run(avoid)` returning `FindPlan | {kind:"none"}`, and wrapping: `a = run(avoid)`. If `avoid.size === 0` return `a`. If `a` is found with `a.dropped.length === 0`, return `a`. Otherwise `b = run(empty set)`; if `b` is found, `b.dropped.length < (a.kind === "found" ? a.dropped.length : Infinity)`, and the avoided constellation ids with a star in `b.stars` that is not in `b.core` is non-empty, return `{ kind: "blocked", avoided: <those ids sorted> }`; else return `a`.
- [ ] **Step 5: Run** both files plus `test/support-finder.test.ts` — expect PASS.
- [ ] **Step 6: Commit** `feat(find): findBuild avoid set and blocked outcome`.

### Task 3: `av=` in the URL hash

**Files:**
- Modify: `web/src/core/urlState.ts` (`KNOWN_PARAMS` line 13, `encodeHash` ~205, `decodeHash` ~245)
- Test: `web/test/urlState.test.ts`

**Interfaces:**
- Produces: `encodeHash(..., findMode = "cheapest", avoided: ReadonlySet<string> = new Set())` appends `&av=<ids sorted, comma-joined>` only when non-empty. `decodeHash(...)` result gains `avoided: string[]` (normalized: split on `,`, keep items matching `^[a-z0-9_]{1,64}$`, dedupe, first 64 only; `[]` when absent). Callers intersect with real constellation ids.

- [ ] **Step 1: Write failing tests:** round trip `av=a,b` ; empty set produces a hash byte-identical to the pre-change output for an existing fixture state (the file already pins hashes — keep those passing); `av=` with junk (`%00`, spaces, 200 ids, duplicates, empty items) decodes to a clean list and never throws; `av` alone counts as a known param (a hash of just `av=bat` decodes non-null).
- [ ] **Step 2: Run** `cd web && bun test test/urlState.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** as specified; add `"av"` to `KNOWN_PARAMS`.
- [ ] **Step 4: Run** same — expect PASS, including the existing wire-id pin tests.
- [ ] **Step 5: Commit** `feat(url): av= carries the avoided constellations`.

### Task 4: Renderer — right-click dep and badge

**Files:**
- Modify: `web/src/adapters/svgRenderer.ts` (`RenderOpts` ~129, deps interface ~524, container listeners ~549, badge near the art layer ~412), `web/src/styles.css`, `web/src/i18n/app.en.json`
- Test: `web/test/svgRenderer.test.ts`, `web/test/appCatalog.test.ts`

**Interfaces:**
- Produces: `RenderOpts.avoided?: ReadonlySet<string>` and `RenderOpts.avoidLabel?: string`; deps gain `onConstellationContext(id: string): void`. Catalog key `ui.avoid.badge` (tooltip text, e.g. "Avoided by Find").

- [ ] **Step 1: Write failing tests** in `svgRenderer.test.ts`: `renderSvgMarkup(model, state, { manifest: null, avoided: new Set(["bat"]), avoidLabel: "Avoided by Find" })` contains exactly one element with `class="avoid-badge"` and `data-con-id="bat"` whose `<title>` is the label; without `avoided` the markup contains no `avoid-badge`. Add `ui.avoid.badge` to the `appCatalog.test.ts` guard list in that file's existing style.
- [ ] **Step 2: Run** `cd web && bun test test/svgRenderer.test.ts test/appCatalog.test.ts` — expect FAIL.
- [ ] **Step 3: Implement the badge** as a small `<g class="avoid-badge" data-con-id=...>` (circle-with-slash glyph, `pointer-events="none"`) placed at the top-left of the constellation's star bounding box (same box math as `highlightCon`), appended after the stars layer so nothing paints over it. Style in `styles.css` using existing color tokens. Add the catalog key.
- [ ] **Step 4: Implement the gesture.** Next to the existing `click` listener in `svgRenderer.ts` (~line 549), add a `contextmenu` listener: resolve `sid = target.getAttribute("data-star-id")` → `model.stars.get(sid)?.constellationId`, else `conAt(clientX, clientY)`; if an id resolves, `preventDefault()` and call `deps.onConstellationContext(id)`; otherwise do nothing (browser menu stays).
- [ ] **Step 5: Run** the two test files — expect PASS. Commit `feat(map): avoid badge and right-click gesture`.

### Task 5: Wire it in `main.ts` and the Find panel

**Files:**
- Modify: `web/src/app/main.ts` (state ~148–183, `onConstellationClick` ~447, `writeHash` ~935, Find compute ~1042–1053, render call), `web/src/adapters/buildOrderView.ts` (`findPreviewHtml` ~159), `web/src/i18n/app.en.json`
- Test: `web/test/build-order-view.test.ts`, `web/test/appCatalog.test.ts`; regression `just e2e`

**Interfaces:**
- Consumes: Tasks 2–4 (`findBuild(..., avoid)`, `FindBlocked`, `encodeHash(..., avoided)`, `decodeHash(...).avoided`, `RenderOpts.avoided/avoidLabel`, `onConstellationContext`).
- Produces: catalog key `ui.buildOrder.findBlocked` with param `{names}` (e.g. "Blocked: reaching this needs {names}, which you marked to avoid. Unmark it or pick it yourself."). `findPreviewHtml` renders it for `outcome.kind === "blocked"`, resolving each id through the same name helper used for `stepConName`, joined with a locale-neutral separator the catalog owns.

- [ ] **Step 1: Write failing tests** in `build-order-view.test.ts`: `findPreviewHtml` with `{kind:"blocked", avoided:["bat"]}` contains the translated blocked text with the constellation's display name, does not contain the `findNone` text, and has a Dismiss button but no Apply. Add `ui.buildOrder.findBlocked` to the catalog guard.
- [ ] **Step 2: Run** `cd web && bun test test/build-order-view.test.ts test/appCatalog.test.ts` — expect FAIL.
- [ ] **Step 3: Implement the panel branch** in `findPreviewHtml` (before the found-plan code, next to the `none` branch) and the catalog key.
- [ ] **Step 4: Wire `main.ts`:** add `let avoided = new Set<string>()`; in `applyHash` set it from `restored?.avoided` intersected with `model.constellations` keys; pass `avoided` to `encodeHash` in `writeHash`; implement `onConstellationContext` as toggle then `refresh()`; include `[...avoided].sort().join("+")` in `memoKey`; pass `avoided` as the last argument of `findBuild`; pass `avoided` and `localization.translate("ui.avoid.badge")` to the renderer opts. Confirm any code that narrows `curFind.kind` (`curFind?.kind !== "found"` in Apply) still typechecks for the new variant.
- [ ] **Step 5: Run** `just typecheck && cd web && bun test` — expect PASS. Run `just e2e` — expect the existing smoke to pass unchanged.
- [ ] **Step 6: Manual check** with `just serve`: right-click a constellation, badge appears and `location.hash` gains `av=`; reload keeps it; right-click again clears both; Find on a selection that needed it shows the blocked message; right-click on empty map space opens the normal browser menu.
- [ ] **Step 7: Commit** `feat(planner): wire avoided constellations into Find`.

### Task 6: Docs, backlog, final gate

**Files:**
- Modify: `docs/reachability-engine.md` (the Find section), `BACKLOG.md`

- [ ] **Step 1:** In the Find section of `docs/reachability-engine.md`, rewrite in place to describe the avoid set: it filters final-build additions and partial finishes only, scaffolding is unrestricted, the blocked verdict rule from Task 2 step 4, and `av=` in the hash.
- [ ] **Step 2:** Add a `BACKLOG.md` entry: touch gesture for avoid (long-press or an item in the commit popover), plus a keyboard path; point at `onConstellationContext` in `svgRenderer.ts` and `showCommitPopover` in `main.ts`.
- [ ] **Step 3: Run** `just check` — expect all of fmt-check, test, lint, typecheck to pass.
- [ ] **Step 4: Commit** `docs(find): avoided constellations`.
