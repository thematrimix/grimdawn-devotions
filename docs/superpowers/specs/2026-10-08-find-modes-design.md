# Find modes: re-optimizable suggestions and attribute fill

Status: design, approved 2026-10-08. Point-in-time record; when shipped, rewrite the "Find" section
of `docs/reachability-engine.md` in place. Builds on
[2026-10-08-find-supporting-build-design.md](2026-10-08-find-supporting-build-design.md).

## Problem

The first version of Find (draft PR #1) suggests the cheapest supporting build for an incomplete
selection. Three things fall short of what users want:

1. **Find cannot re-optimize.** After Apply the build covers itself, so Find is disabled. Even if
   it were enabled, the support it added is now indistinguishable from stars the user picked, so a
   later Find could only add more on top of it.
2. **The user's own picks are not the explicit priority.** The result must always be a legal
   build, and it must keep as many of the user's chosen stars as possible.
3. **Tagged attributes only break ties.** Users want Find to pursue stars carrying their tagged
   attributes, and they want to choose how hard.

## Decisions (with the user)

- Find stays a **button**, usable at any time. An open preview recalculates whenever something
  changes, instead of closing.
- Find may **swap out its earlier suggestions** (the core, below).
- A **mode selector** offers three objectives. The default is **Cheapest**.
- Attribute matching is **true OR**: a star scores 1 if it carries at least one tagged attribute,
  and 0 if it carries none. We iterate if this turns out not to be right.
- The result is always legal. When the user's stars cannot all be kept, Find drops as few as
  possible and says which.

## The core: what Find must keep

- The **core** is the set of stars the user chose themselves. Find's suggestions are not in it.
- **Apply** sets `selection = result` and `core = the core Find worked from` (minus any dropped
  stars). The support Find added is therefore outside the core.
- **A star click** that adds stars adds them to the core. One that removes stars removes them from
  the core. This covers both the toggleStar and toggleConstellation paths, the popover included.
- **Wholesale replacements reset the core to the new selection.** These are hash navigation without
  `fc=`, grimtools import, save-file load, Reset, and the baseline restore and swap actions.
- **Invariant:** `core ⊆ selection`, and every write re-establishes it.
- **URL:** `fc=<bitset>`, using the star-bitset codec. When it is absent, the core equals the
  selection, so every existing link means what it meant before. It is encoded only when the core
  differs from the selection.
- Find always computes from the core. Selected stars outside the core are free to keep or drop.
  The preview reports **Adds** (result minus selection) and **Removes** (selection minus result,
  excluding the core) separately.

## Modes

The mode is saved in the URL as `fm=` (`1` = cheapest + fill, `2` = most attributes; absent or
anything else = cheapest). The selector sits beside the Find button. `T` below is the set of stars
carrying any tagged player or pet attribute (affinity tags are excluded, as today). `tagged(X)` is
`|X ∩ T|` over the stars X adds beyond the core.

| Mode | Primary | Then |
|---|---|---|
| Cheapest | fewest added stars over the core | most `tagged`, lowest peak, canonical ids |
| Cheapest + fill | the Cheapest result's support | spend `cap − size` on fill, maximizing `tagged` |
| Most attributes | most `tagged` within the cap | fewest stars, lowest peak, canonical ids |

With no attribute tags, every mode returns the Cheapest result. When the core already covers
itself, Cheapest adds nothing. The preview then says the build is already at its cheapest, and the
fill modes may still add stars.

## Fill

- **Input:** a self-covering build `B` (core plus support) whose supply is `S`, and a capacity
  `k = cap − |B|`.
- **Eligible constellations** are those not fully in `B` whose requirement `S` already covers. Any
  star subset of such a constellation leaves the build self-covering. A completed fill
  constellation's own grant is ignored, which is conservative. Partly-taken constellations in `B`
  are eligible to extend.
- **Per constellation:** enumerate every predecessor-closed subset of its unselected stars that is
  consistent with the stars already taken. There are at most 2^8 per constellation. Keep the best
  `tagged` count for each size.
- **Across constellations:** a multiple-choice knapsack DP over the capacity, which is exact under
  this eligibility rule. Ties prefer fewer stars, then canonical ids.
- **Verification:** the filled build goes through the panel path (`buildOrderPath` + `gateBuildOrder`).
  Fill members need no scaffold, but the oracle decides. If it rejects the build, re-run the DP at
  capacity `k − 1` and repeat (bounded).

## Most attributes

- Enumerate accepted support sets over the core, not just the cheapest ones. This is the same
  covering DFS, with its limit at `cap − |core|`, keeping candidates up to a count cap.
- Fill each candidate (above). Score it as `tagged(support) + tagged(fill)`, and keep the best by
  the mode's order.
- The work is capped by node and candidate counts, never wall-clock time, so the result stays a pure
  function of (core, cap, tags, mode). A hit cap sets `exhaustive: false`, and the preview then says
  "best found".

## Dropping

The planner already refuses selections that cannot be completed within 55, so with a valid core
this should not fire. It is a safety net for stale links and exhausted searches.

- If no mode finds a verified result from the core, remove the core's smallest constellation (all
  its stars), breaking ties by canonical id, and retry. Repeat, bounded.
- The preview lists every dropped constellation under "Dropped".
- Apply removes the dropped stars from the core.

## Preview and lifecycle

- The Find button is enabled whenever the selection is non-empty under a finite cap. It is
  disabled in compare mode, in the uncapped view, and on an empty selection.
- `fd=1` stays the open-preview flag. While it is set, every refresh recomputes the suggestion for
  the current (core, cap, tags, mode), memoized on that key. Changes no longer close the preview.
- The preview shows:
  - the mode;
  - "+N points, peak P of C";
  - the Adds, Removes, and Dropped lists, with finished partials marked;
  - the tagged count;
  - the verified order;
  - Apply and Dismiss.
- A result identical to the current selection says so instead ("already optimal for this mode").
  Apply is disabled for it.

## Engine boundary

`supportFinder.ts` keeps its current contract for the Cheapest mode. The fill and the
most-attributes search live in core modules (a new `findFill.ts`, or more code in
`supportFinder.ts`) and use only exported engine helpers. No classify or resolver verdict changes,
so nothing needs mirroring in Rust.

## i18n

New keys go in `app.en.json` and the `appCatalog.test.ts` guard:

- the mode labels and the selector's aria label;
- the Adds, Removes, and Dropped headings;
- "already optimal";
- the always-usable button titles, which replace `findDisabledComplete`.

## Testing

- **Fill DP:** brute-force every eligible subset on synthetic models. That gives the max `tagged`
  at each capacity, with predecessor branching and partly-taken constellations covered.
- **Most attributes:** brute-force support × fill on small models, and check it is at least the
  Cheapest + fill score.
- **OR counting:** on the real map, tag physical resistance, all damage, and armor absorption. A
  star with any one of them counts as 1. A star with two still counts as 1.
- **Core:**
  - Apply, then change tags or the mode, then Find again. Earlier support can be swapped out, and
    Removes lists it.
  - Clicks update the core.
  - Imports and Reset set it.
  - `fc=` round-trips, an absent `fc=` means core = selection, and a stale `fc=` is clamped into
    the selection.
- **Lifecycle:** a change with the preview open recomputes rather than closing. Find works on a
  complete build. The no-op result says "already optimal".
- **Corpora:** reachable-builds and real-builds per mode, with no tags and with tags. Report
  found/verified counts, how often the cap was hit, and p50/p95/max timings.
- **e2e:** the selector, Find after Apply, Removes appearing, and URL restore of `fm=` and `fc=`.
