// ABOUTME: Renders the guided build-order panel: a numbered step list with constellation art, scaffold
// ABOUTME: add/refund rows, a running held total, honest empty states, and the per-step affinity popup
// ABOUTME: (post-step have/need in the Affinity panel's visual language), the Find button beside the heading,
// ABOUTME: and Find's suggestion preview with Apply/Dismiss. Pure string output.
import type { Affinity, DevotionModel } from "../core/types";
import { AFFINITIES } from "../core/types";
import type { AffinityDeficit } from "../core/dimReasons";
import { deficitPhrase } from "./dimText";
import type { StepState, TransStep } from "../core/orderLegality";
import type { BuildStep } from "../core/reachability";
import { selectionDelta, type FindOutcome } from "../core/findBuild";
import type { FindMode, StarId } from "../core/types";
import type { TransitionRung } from "../core/transitionOrder";
import type { AssetManifest } from "../ports/DataSource";
import { affinityOrb } from "./affinityColors";
import type { Localization } from "../ports/Localization";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The five Crossroads share the generic name "Crossroads" and have no art. Label each by its fixed
// position on the devotion map (cardinal direction) and show a dot in the affinity it grants.
const CROSSROADS: Record<string, { dirKey: string; affinity: Affinity }> = {
  crossroads_primordial: { dirKey: "n", affinity: "primordial" },
  crossroads_chaos: { dirKey: "nw", affinity: "chaos" },
  crossroads_order: { dirKey: "ne", affinity: "order" },
  crossroads_eldritch: { dirKey: "sw", affinity: "eldritch" },
  crossroads_ascendant: { dirKey: "se", affinity: "ascendant" },
};

// The step name shared by rows and the popup: crossroads get a direction label, others their game name.
function stepConName(loc: Localization, model: DevotionModel, conId: string): string {
  const c = model.constellations.get(conId);
  const cr = CROSSROADS[conId];
  return cr
    ? `${c ? loc.gameText(c.nameTag) : loc.translate("ui.buildOrder.crossroads")} (${loc.translate(`ui.buildOrder.dir.${cr.dirKey}`)})`
    : c
      ? loc.gameText(c.nameTag)
      : conId;
}

// Why no order is shown, for the empty-state copy:
// - empty: nothing meaningful to order yet (no selection, or no point cap to assemble within).
// - incomplete: the selection does not cover its own affinity (deficit per color); it needs other
//   constellations, so no order exists yet. This is the common partial-selection case (e.g. a capstone alone).
// - searched: the selection is self-covering but no construction order assembles it within budget. minCap is
//   the fewest points at which it would assemble (<= 55), or null when no legal path exists even at 55.
export type NoOrderInfo =
  | { kind: "empty" }
  | { kind: "incomplete"; deficit: AffinityDeficit[] }
  | { kind: "searched"; minCap: number | null };

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
    (m) =>
      `<option value="${m}"${m === find.mode ? " selected" : ""}>${loc.translate(`ui.buildOrder.findMode.${m}`)}</option>`,
  ).join("");
  const select = `<select class="bo-find-mode" aria-label="${esc(loc.translate("ui.buildOrder.findModeLabel"))}"${lockMode ? " disabled" : ""}>${options}</select>`;
  const btn = `<button type="button" class="bo-find" title="${title}"${find.enabled ? "" : " disabled"}>${loc.translate("ui.buildOrder.find")}</button>`;
  return `<div class="bo-head">${h}<span class="bo-find-ctl">${select}${btn}</span></div>`;
}

export function buildOrderHtml(
  loc: Localization,
  model: DevotionModel,
  manifest: AssetManifest | null,
  steps: BuildStep[] | null,
  noOrder?: NoOrderInfo | null,
  find?: FindButton,
): string {
  if (!steps) {
    const info: NoOrderInfo = noOrder ?? { kind: "empty" };
    let body: string;
    if (info.kind === "incomplete") {
      const deficit = esc(deficitPhrase(loc, model, info.deficit));
      body =
        `<div class="bo-empty-msg">${loc.translate("ui.buildOrder.incompleteAffinity", { deficit })}</div>` +
        `<div class="bo-empty-sub">${loc.translate("ui.buildOrder.addSupporting")}</div>`;
    } else if (info.kind === "searched") {
      body =
        info.minCap != null
          ? `<div class="bo-empty-msg">${loc.translate("ui.buildOrder.noPathCap", { minCap: info.minCap })}</div>` +
            `<div class="bo-empty-sub">${loc.translate("ui.buildOrder.scaffoldingNote")}</div>`
          : `<div class="bo-empty-msg">${loc.translate("ui.buildOrder.noLegalPath")}</div>`;
    } else {
      // nothing to order yet: the order appears once the selection covers its own affinity.
      body = `<div class="bo-empty-msg">${loc.translate("ui.buildOrder.selectPrompt")}</div>`;
    }
    return `${headingHtml(loc, find)}<div class="bo-empty">${body}</div>`;
  }
  return `${headingHtml(loc, find)}<div class="bo-list">${stepRowsHtml(loc, model, manifest, steps)}</div>`;
}

// The numbered from-scratch step rows, shared by the live panel and Find's preview.
function stepRowsHtml(
  loc: Localization,
  model: DevotionModel,
  manifest: AssetManifest | null,
  steps: BuildStep[],
): string {
  let n = 0;
  return steps
    .map((s, si) => {
      const c = model.constellations.get(s.conId);
      const cr = CROSSROADS[s.conId];
      const name = stepConName(loc, model, s.conId);
      const artName = c?.background?.image?.split("/").pop() ?? "";
      const art = manifest?.images[artName];
      // Crossroads have no art; their art-column cell holds a dot in the granted affinity's color.
      const dot = cr ? `<span class="bo-art">${affinityOrb(cr.affinity)}</span>` : "";
      const img = art && s.kind === "complete" ? `<img class="bo-art" src="${esc(art.url)}" alt=""/>` : "";
      const held = `<span class="bo-held">${s.heldAfter}</span>`;
      if (s.kind === "complete") {
        n++;
        const artCell = img || dot;
        // A step smaller than its constellation is a deliberate partial pick (e.g. 4 of 6 stars to
        // reach a celestial power): annotate it so the row does not read as the full constellation.
        const partial =
          c && s.points < c.starIds.length
            ? ` <span class="bo-partial">${loc.translate("ui.buildOrder.partial", { taken: s.points, total: c.starIds.length })}</span>`
            : "";
        return `<div class="bo-step bo-complete" data-con-id="${esc(s.conId)}" data-step-i="${si}"><span class="bo-n">${n}</span>${artCell}<span class="bo-name">${esc(name)}${partial}</span><span class="bo-pts">+${s.points}</span>${held}</div>`;
      }
      const label =
        s.kind === "scaffold-add" ? loc.translate("ui.buildOrder.add") : loc.translate("ui.buildOrder.refund");
      const cls = s.kind === "scaffold-add" ? "bo-add" : "bo-refund";
      // Empty art-column cell (or the crossroads dot) so the five grid columns line up with complete rows.
      const artCell = dot || `<span class="bo-art"></span>`;
      return `<div class="bo-step ${cls}" data-con-id="${esc(s.conId)}" data-step-i="${si}"><span class="bo-n"></span>${artCell}<span class="bo-name">${label} ${esc(name)}</span><span class="bo-pts">${s.points > 0 ? "+" : ""}${s.points}</span>${held}</div>`;
    })
    .join("");
}

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
  const optimal = unchanged
    ? `<div class="bo-find-optimal">${loc.translate("ui.buildOrder.findAlreadyOptimal")}</div>`
    : "";
  const bestKey = mode === "attributes" ? "ui.buildOrder.findBestFoundAttributes" : "ui.buildOrder.findBestFound";
  const best = outcome.exhaustive ? "" : `<div class="bo-note">${loc.translate(bestKey)}</div>`;
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

/**
 * Compare mode: the baseline-to-current transition order. Same row vocabulary as the from-scratch
 * panel above (a step's own kind is "add"/"refund" rather than "scaffold-add"/"scaffold-refund"/
 * "complete", so a row numbers and gets art only when an add reaches the constellation's full size
 * AND the constellation survives to the end of the transition - transient scaffolds keep the plain
 * Add vocabulary even at full size;
 * the partial badge instead marks any row - add or refund - that leaves the member short of full
 * size). A heading names the direction, and the full-respec rung carries a plain notice. Zero steps
 * means the builds already match.
 */
export function transitionHtml(
  loc: Localization,
  model: DevotionModel,
  manifest: AssetManifest | null,
  steps: TransStep[],
  rung: TransitionRung,
): string {
  const head = `${headingHtml(loc, { enabled: false, reason: "compare", mode: "cheapest" })}<div class="bo-compare-head">${loc.translate("ui.buildOrder.transitionHeading")}</div>`;
  if (!steps.length) return `${head}<div class="bo-empty">${loc.translate("ui.buildOrder.transitionIdentical")}</div>`;
  const note =
    rung === "full-respec" ? `<div class="bo-note">${loc.translate("ui.buildOrder.fullRespecNote")}</div>` : "";
  // A constellation is TRANSIENT when its LAST step in this transition ends at 0: bought (or held)
  // along the way but gone by the end. An add that reaches full size for a transient constellation is
  // scaffolding, not a member of the resulting build, so it stays an unnumbered Add row below rather
  // than claiming a numbered bo-complete slot.
  const finalTo = new Map<string, number>();
  for (const s of steps) finalTo.set(s.conId, s.to);
  const transient = new Set([...finalTo].filter(([, to]) => to === 0).map(([conId]) => conId));
  let n = 0;
  const rows = steps
    .map((s, si) => {
      const c = model.constellations.get(s.conId);
      const cr = CROSSROADS[s.conId];
      const name = stepConName(loc, model, s.conId);
      const artName = c?.background?.image?.split("/").pop() ?? "";
      const art = manifest?.images[artName];
      const completes = s.kind === "add" && !!c && s.to === c.starIds.length && !transient.has(s.conId);
      // Crossroads have no art; their art-column cell holds a dot in the granted affinity's color.
      const dot = cr ? `<span class="bo-art">${affinityOrb(cr.affinity)}</span>` : "";
      const img = art && completes ? `<img class="bo-art" src="${esc(art.url)}" alt=""/>` : "";
      const delta = s.to - s.from;
      const held = `<span class="bo-held">${s.heldAfter}</span>`;
      if (completes) {
        n++;
        const artCell = img || dot;
        return `<div class="bo-step bo-complete" data-con-id="${esc(s.conId)}" data-step-i="${si}"><span class="bo-n">${n}</span>${artCell}<span class="bo-name">${esc(name)}</span><span class="bo-pts">+${delta}</span>${held}</div>`;
      }
      const label = loc.translate(s.kind === "add" ? "ui.buildOrder.add" : "ui.buildOrder.refund");
      const cls = s.kind === "add" ? "bo-add" : "bo-refund";
      // Empty art-column cell (or the crossroads dot) so the five grid columns line up with complete rows.
      const artCell = dot || `<span class="bo-art"></span>`;
      // A step landing short of full size (add or refund) is a deliberate partial member: annotate it
      // so the row does not read as a full constellation.
      const partial =
        s.to > 0 && c && s.to < c.starIds.length
          ? ` <span class="bo-partial">${loc.translate("ui.buildOrder.partial", { taken: s.to, total: c.starIds.length })}</span>`
          : "";
      return `<div class="bo-step ${cls}" data-con-id="${esc(s.conId)}" data-step-i="${si}"><span class="bo-n"></span>${artCell}<span class="bo-name">${label} ${esc(name)}${partial}</span><span class="bo-pts">${delta > 0 ? "+" : ""}${delta}</span>${held}</div>`;
    })
    .join("");
  return `${head}${note}<div class="bo-list">${rows}</div>`;
}

/**
 * The hover/tap popup for one build-order step: the post-step have/need table in the Affinity
 * panel's visual language (same classes, no filter-toggle attributes - the popup is display-only).
 * The step's own effect folds into the table as dimmed parentheticals: its grant appears in the
 * have column as a signed delta (+N, or -N on a refund), its requirement in the need column as
 * (N). `state` comes from the verifying replay via SelectionView.buildOrderStates, so the numbers
 * are the ones the legality judge saw.
 */
export function buildStepPopupHtml(
  loc: Localization,
  model: DevotionModel,
  step: BuildStep | TransStep,
  state: StepState,
): string {
  const name = esc(stepConName(loc, model, step.conId));
  const sign = step.kind === "scaffold-refund" || step.kind === "refund" ? "-" : "+";
  const rows = AFFINITIES.map((a, i) => {
    const n = state.need[i]!;
    const g = state.conGrant[i]!;
    const r = state.conReq[i]!;
    // Parentheticals sit BEFORE the value so the post-step numbers stay column-aligned.
    const haveDelta = g > 0 ? `<span class="bo-pop-delta">(${sign}${g})</span> ` : "";
    const needNote = r > 0 ? `<span class="bo-pop-delta">(${r})</span> ` : "";
    let needCell: string;
    if (n > 0) {
      const met = state.have[i]! >= n;
      const names = (state.needSource.get(i) ?? [])
        .map((cid) => {
          const tag = model.constellations.get(cid)?.nameTag;
          return tag ? loc.gameText(tag) : cid;
        })
        .join(", ");
      needCell = `<span class="aff-need ${met ? "met" : "missing"}" title="${esc(names ? loc.translate("ui.affinity.neededBy", { names }) : "")}">${needNote}${n}</span>`;
    } else {
      needCell = `<span class="aff-need none">${needNote}0</span>`;
    }
    return `<div class="affinity affinity-${a}"><span>${affinityOrb(a)}${loc.translate(`aff.${a}`)}</span><span class="aff-have">${haveDelta}${state.have[i]}</span>${needCell}</div>`;
  }).join("");
  return (
    `<div class="bo-pop-name">${name}</div>` +
    `<div class="bo-pop-table"><div class="affinity-head"><span></span><span class="aff-have">${loc.translate("ui.affinity.have")}</span><span class="aff-need-h">${loc.translate("ui.affinity.need")}</span></div>${rows}</div>`
  );
}
