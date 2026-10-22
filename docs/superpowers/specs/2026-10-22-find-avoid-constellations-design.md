# Find: avoided constellations (design)

## Intent and why

Find (the support search on `feat/find-support`: `core/supportFinder.ts`, `core/findBuild.ts`)
suggests the cheapest set of supporting constellations for the user's selection. It treats every
constellation as an equal stepping stone. A real build often cannot use some of them. The motivating
case: Kraken requires a two-handed weapon, the user's character will never wield one, and Find routed
through Kraken anyway. The user wants to say "never route through this constellation" once, and have
every Find result respect it.

## Behavior

1. **Toggle.** Right-clicking (context menu) a constellation on the starmap toggles its "avoid" mark.
   The browser context menu is suppressed on constellations only. Touch has no right-click; a
   long-press equivalent is the builder's call (see "Left to the builder").
2. **Scope: Find only, final build.** Find's resulting build never contains a star Find added from an
   avoided constellation. Temporary scaffolding is allowed (see rule 8): the build order may take an
   avoided constellation's stars early and refund them, as long as none remain in the final set. The mark does not restrict manual selection: the user can still click its stars as usual.
   It changes nothing in per-click reachability, dimming, or the build-order panel.
3. **Hand-picked avoided constellations are base selection.** If an avoided constellation has stars in
   the user's selection (picked by hand, or arrived via a shared link), Find treats those stars like any
   other selected stars: already paid for, usable as part of the build, never counted as an addition.
   Find never leaves *further* stars of an avoided constellation in the final build (it does not
   "finish" one), though it may use them as refunded scaffolding.
   Stars the user selected stay as the user selected them.
4. **Unreachable, with a reason.** If Find can only reach the goal with an avoided constellation
   *remaining in the final build* (temporary scaffolding does not count), it does not fall back. It reports no result and names the avoided constellation(s)
   that blocked it, so the user understands why (and knows that picking one by hand, or un-avoiding it,
   would change the answer). This is distinct from the existing "No supporting build fits within your
   point cap" message (`ui.buildOrder.findNone`): the user must be able to tell "blocked by avoids"
   from "over the cap".
5. **Badge.** An avoided constellation shows a visible badge on the map. That is the only indicator
   required; no list or "clear all" control.
6. **Shareable.** The set of avoided constellations lives in the URL hash and round-trips through
   `encodeHash`/`decodeHash` in `web/src/core/urlState.ts`, tolerating stale or malformed values (e.g.
   unknown constellation ids). Per CLAUDE.md, the wire format is append-only: a new param, never a
   reordering of existing ones.
7. **Localized.** Every new user-facing string (badge label/tooltip, the blocked-by-avoids message with
   the constellation names) is a catalog key in `web/src/i18n/app.<locale>.json` and added to the
   `web/test/appCatalog.test.ts` guard. No hardcoded strings.
8. **Temporary scaffolding is allowed.** Find may take an avoided constellation's stars early in the
   build order and refund them, provided the verified order shows the refund and the final set holds
   none of the added avoided stars. The search must therefore consider such orders (avoided stars are
   excluded from the final set, not from the search's order space). The oracle replay stays the arbiter
   of legality. This is harder to build than a hard exclusion; the user chose it because it matches how
   the in-game rules work.

## Goals

- Find results never end with an added avoided constellation (refunded scaffolding aside).
- A blocked Find explains itself and names the culprit(s).
- State survives a copy/paste of the link.

## Non-goals

- Blocking manual selection of an avoided constellation.
- Affecting reachability dimming, the build-order oracle, or search/"find by stat" features.
- A management list, "clear all", or import/export of avoid lists across builds.
- Per-device or cross-build persistence outside the URL.

## Anti-goals

- Find silently leaving an avoided constellation's added stars in the final build to produce *a* result.
- Scaffolding from an avoided constellation that is not refunded by the end of the verified order.
- Find reporting "doesn't fit your point cap" when the real cause is an avoid.
- Any change to what counts as a legal build or to the in-game rules: avoid only constrains which final
  sets Find may return, so every plan is still replayed through the independent oracle
  (`core/orderLegality.ts`), unchanged and unaware of avoids. Find must remain a pure function of its inputs (now including the avoid
  set), with no wall-clock caps.

## Constraints

- Hexagonal layout: avoid logic is pure core; the contextmenu handler and badge are adapters; `app/main.ts`
  wires it.
- Find's memo key in `app/main.ts` (`memoKey`) must include the avoid set, or stale results will show.
- Reachability has an optional WASM core. Check whether Find's search runs there; if so, the avoid set
  must reach it too (or Find must stay on the TS path with the same result).
- Docs: update `docs/reachability-engine.md` ("Find") in place per the evergreen-docs rule; do not
  append a changelog section.

## Decisions made by the user

- Right-click on the constellation toggles the mark.
- Avoid restricts Find only, not manual selection.
- Blocked goal => "unreachable" with a clear reason, no fallback.
- Hand-picked avoided constellations count as base selection for Find.
- A badge is sufficient UI.
- Temporary scaffolding through an avoided constellation is allowed, if it is refunded (rule 8).

## Clarifications (builder check)

Answered by the conversation: **Selected stars of an avoided constellation count as for any selected star** (affinity, effects).
Find may not leave any *added* star of an avoided constellation in the final build.

Calls made by the writer (not discussed with the user; flag if wrong):
- **Blocked verdict precedence.** Compute the plan without avoids. If it exists and its final set adds
  stars of at least one avoided constellation, and no plan exists with the avoid constraint: "blocked by avoids", listing every avoided
  constellation the unblocked plan uses. If no plan exists even without avoids, or the unblocked plan
  uses no avoided constellation, show the existing `findNone` (cap) message.
- **Modes.** Avoid applies identically to cheapest, fill, and attributes.
- **Core-drop fallback.** The "drop smallest core constellation until buildable" fallback is unchanged
  and may drop a hand-picked avoided constellation like any other; it never adds one.
- **Toggle on selected constellations.** Allowed, no warning; the badge shows.
- **WASM.** If the Find search is not on the WASM path, nothing to do. If it is, falling back to the TS
  path whenever any avoid is set is acceptable; no parity gate may break.
- **Build identity.** The avoid set is Find-affecting state only; it must not change `selectionKey` or
  how builds are compared, but must be in Find's memo key.

## Left to the builder

- Wire param name and encoding for the avoid set (a constellation-id bitset like `fc=`, or a list).
- How `findBuild`'s "drop core constellations until buildable" behavior interacts with avoids; it
  should not be the mechanism that hides an avoid-block, and the blocked message should still name the
  avoided constellation(s).
- How to determine which avoided constellations were "the blocker" (e.g. re-run without the avoids and
  report the avoided ones in the resulting plan).
- Long-press/touch alternative, badge visual, and keyboard accessibility for the toggle.
- Whether Find's button/preview should be disabled or merely report when everything is blocked.
