// ABOUTME: Tests buildOrderHtml - the right-sidebar build-order panel markup: numbered complete rows with
// ABOUTME: constellation art, distinct scaffold add/refund rows with the running held total, and the
// ABOUTME: empty states (prompt, incomplete-deficit, and the no-legal-path message).
import { test, expect } from "bun:test";
import doc from "../../data/devotions.json";
import { buildModel } from "../src/core/model";
import { buildOrderHtml, findPreviewHtml } from "../src/adapters/buildOrderView";
import { buildCoverTable, buildReachCons } from "../src/core/reachability";
import { findBuild, type FindPlan } from "../src/core/findBuild";
import { affinityColor } from "../src/adapters/affinityColors";
import type { BuildStep } from "../src/core/reachability";
import { enLoc } from "./helpers/localizeEn";

const model = buildModel(doc as any);
const firstCon = [...model.constellations.values()][0]!;

test("buildOrderHtml renders complete and scaffold rows with held totals and con ids", () => {
  const steps: BuildStep[] = [
    { kind: "scaffold-add", conId: firstCon.id, points: 1, heldAfter: 1 },
    { kind: "complete", conId: firstCon.id, points: 5, heldAfter: 6 },
    { kind: "scaffold-refund", conId: firstCon.id, points: -1, heldAfter: 5 },
  ];
  const html = buildOrderHtml(enLoc, model, null, steps);
  expect(html).toContain(`data-con-id="${firstCon.id}"`);
  expect(html).toContain(enLoc.gameText(firstCon.nameTag));
  expect(html).toContain("bo-add");
  expect(html).toContain("bo-refund");
  expect(html).toContain("6"); // a held total
});

test("buildOrderHtml null defaults to the empty prompt with no button", () => {
  const html = buildOrderHtml(enLoc, model, null, null);
  expect(html).toContain("Select a self-covering build");
  expect(html).not.toContain("data-find-order");
  expect(html).not.toContain("Incomplete build");
});

test("buildOrderHtml incomplete: names the affinity deficit, who needs it, and offers no search button", () => {
  // Oleron alone: needs 20 Ascendant + 7 Order, both set by Oleron's own requirement
  const html = buildOrderHtml(enLoc, model, null, null, {
    kind: "incomplete",
    deficit: [
      { color: 0, count: 20, sources: ["oleron"] },
      { color: 3, count: 7, sources: ["oleron"] },
    ],
  });
  expect(html).toContain("Incomplete build");
  expect(html).toContain("20 more Ascendant for Oleron");
  expect(html).toContain("7 more Order for Oleron");
  expect(html).toContain("and"); // joins multiple deficits
  expect(html).not.toContain("data-find-order"); // searching cannot help an incomplete selection
});

test("buildOrderHtml searched with a minCap reports the points floor", () => {
  const html = buildOrderHtml(enLoc, model, null, null, { kind: "searched", minCap: 13 });
  expect(html).toContain("No path to this build in fewer than 13 points");
  expect(html).not.toContain("data-find-order");
});

test("buildOrderHtml searched with null minCap reports no legal path", () => {
  const html = buildOrderHtml(enLoc, model, null, null, { kind: "searched", minCap: null });
  expect(html).toContain("No legal path to this build exists");
});

test("buildOrderHtml labels a crossroads with its cardinal direction and an affinity dot", () => {
  const steps: BuildStep[] = [
    { kind: "scaffold-add", conId: "crossroads_chaos", points: 1, heldAfter: 1 },
    { kind: "complete", conId: "crossroads_eldritch", points: 1, heldAfter: 2 },
  ];
  const html = buildOrderHtml(enLoc, model, null, steps);
  expect(html).toContain("Crossroads (NW)"); // chaos crossroads sits NW
  expect(html).toContain("Crossroads (SW)"); // eldritch crossroads sits SW
  expect(html).toContain(`background:${affinityColor("chaos")}`); // colored dot in the art column
  expect(html).toContain(`background:${affinityColor("eldritch")}`);
});

test("buildOrderHtml marks a complete step smaller than its constellation as a partial pick", () => {
  const con = [...model.constellations.values()].find((c) => c.starIds.length >= 3)!;
  const size = con.starIds.length;
  const partial = buildOrderHtml(enLoc, model, null, [
    { kind: "complete", conId: con.id, points: size - 1, heldAfter: size - 1 },
  ]);
  expect(partial).toContain(`(${size - 1}/${size})`);
  expect(partial).toContain("bo-partial");
  // A full-size step carries no partial marker.
  const full = buildOrderHtml(enLoc, model, null, [{ kind: "complete", conId: con.id, points: size, heldAfter: size }]);
  expect(full).not.toContain("bo-partial");
});

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
  const extra = [
    "crossroads_chaos",
    "crossroads_order",
    "crossroads_primordial",
    "crossroads_eldritch",
    "crossroads_ascendant",
  ]
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

test("findPreviewHtml uses the attributes-specific best-found note", () => {
  const out = { ...(findBuild(model, rcons, rtable, oleron, 55, [], "cheapest") as FindPlan), exhaustive: false };
  expect(findPreviewHtml(enLoc, model, null, out, oleron, 55, "attributes", true)).toContain(
    enLoc.translate("ui.buildOrder.findBestFoundAttributes"),
  );
  expect(findPreviewHtml(enLoc, model, null, out, oleron, 55, "cheapest", true)).toContain(
    enLoc.translate("ui.buildOrder.findBestFound"),
  );
});
