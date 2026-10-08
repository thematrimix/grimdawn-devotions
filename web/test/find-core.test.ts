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
