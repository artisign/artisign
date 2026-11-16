// @vitest-environment jsdom
//
// The use case controller (usecases.js): "Leave unmapped" and "Pick new target" on a stale step, on the base flow and in a
// variant, and the fallback to the base flow when the selected variant no longer exists.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUseCasesView } from "./usecases.js";
import { rawUseCase, personas, dimensions, objects, baseBundle, variantBundle } from "./usecases.test-helper.js";

let calls;
let source; // what GET /api/use-case answers
let variantGone;

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const toast = () => $(".uc-toast:not([hidden]) strong")?.textContent ?? "";
const writes = () => calls.filter((c) => c.tool === "set_use_cases");

// The variant view with a stale mapping on the step the variant added.
const staleVariantBundle = {
  ...variantBundle,
  screens: [{ screen: "picker", exists: false, mappings: [{ step: "time", scope: "screen", stale: true }] }],
};

function stubDaemon() {
  calls = [];
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("fetch", async (url, init) => {
    const path = String(url).split("?")[0];
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, tool: path.startsWith("/api/tools/") ? path.slice(11) : null, body });
    const json = (value) => ({ ok: true, status: 200, json: async () => value, text: async () => "" });
    if (path === "/api/tools/list_use_cases") {
      const summary = { id: "map-step", title: rawUseCase.title, group: rawUseCase.group, status: "ready", steps: 3, variants: 2 };
      return json({ total: 1, use_cases: [summary], counts: { use_cases: 1, personas: personas.length, dimensions: dimensions.length, data_objects: objects.length }, facets: { status: {}, group: {}, tag: {}, persona: {} }, personas, dimensions, data_objects: objects });
    }
    if (path === "/api/tools/get_use_case") {
      if (body.variant) {
        if (variantGone) return { ok: false, status: 404, json: async () => ({ code: "not_found", message: "no such variant" }) };
        return json(staleVariantBundle);
      }
      return json({ ...baseBundle, screens: [{ screen: "gone-screen", exists: false, mappings: [{ step: "notify", scope: "screen", stale: true }] }] });
    }
    if (path === "/api/tools/suggest_use_case_variants") return json({ suggestions: [] });
    if (path === "/api/use-case") return json({ use_case: source });
    if (path === "/api/tools/set_use_cases") return json({ warnings: [] });
    return json({});
  });
}

async function openView(variantId = null, { toMapping = true } = {}) {
  document.body.innerHTML = `<div id="root"></div>`;
  const view = createUseCasesView({ rootEl: $("#root"), getProject: () => "/p", getProjectName: () => "demo", getScreens: () => [{ name: "editor" }], fetchRender: async () => ({ ok: true, html: "<main></main>" }), fetchScreenNodes: async () => ({ ok: true, nodes: [] }), openScreen: () => {} });
  await view.show();
  await flush();
  await view.openCase("map-step", variantId);
  await flush();
  if (toMapping) {
    $$(".uc-actions button").find((b) => b.textContent.includes("Show on screens")).click();
    await flush();
  }
  return view;
}
const button = (label) => $$(".uc-map-stale-actions button").find((b) => b.textContent === label);

beforeEach(() => {
  source = structuredClone(rawUseCase);
  variantGone = false;
  stubDaemon();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Leave unmapped", () => {
  it("on the base flow strips the target from the base step and writes only the steps", async () => {
    await openView();
    button("Leave unmapped").click();
    await flush();
    expect(writes()).toHaveLength(1);
    const [payload] = writes()[0].body.use_cases;
    expect(Object.keys(payload).sort()).toEqual(["id", "steps"]);
    expect(payload.id).toBe("map-step");
    expect(payload.steps.find((s) => s.id === "notify").target).toBeUndefined();
    expect(payload.steps.find((s) => s.id === "tap").target).toEqual({ screen: "editor", node: "btn-map" });
    expect(toast()).toBe("Step left unmapped.");
  });

  it("in a variant strips the target from the variant op that produces the step and leaves the base steps alone", async () => {
    // The stored variant appends "time" and replaces it again: the replace is what the view shows.
    const time = (action, node) => ({ id: "time", actor: "dex", action, target: { screen: "picker", node } });
    source.variants[0].steps = [{ op: "append", step: time("Sets the time", "first") }, { op: "replace", step_id: "time", step: time("Sets the time later", "second") }];
    await openView("agent");
    button("Leave unmapped").click();
    await flush();
    expect(writes()).toHaveLength(1);
    const [payload] = writes()[0].body.use_cases;
    expect(Object.keys(payload).sort()).toEqual(["id", "variants"]);
    const ops = payload.variants.find((v) => v.id === "agent").steps;
    expect(ops[0].step.target).toEqual({ screen: "picker", node: "first" });
    expect(ops[1].step.target).toBeUndefined();
    expect(toast()).toBe("Step left unmapped in this variant.");
  });

  it("writes nothing and says so when the stored step has no target any more", async () => {
    await openView();
    source.steps = source.steps.map(({ target: _target, ...rest }) => rest);
    button("Leave unmapped").click();
    await flush();
    expect(writes()).toHaveLength(0);
    expect(toast()).toContain("Nothing to change");
  });
});

describe("Pick new target", () => {
  it("on the base flow opens the edit dialog focused on that step's row, without writing", async () => {
    await openView();
    button("Pick new target").click();
    await flush();
    expect($("dialog")).not.toBeNull();
    const rows = $$(".uc-step-edit");
    expect(rows).toHaveLength(3);
    expect(rows[2].contains(document.activeElement)).toBe(true); // "notify" is the third step
    expect(calls.some((c) => c.path === "/api/use-case")).toBe(true); // the edit starts from the stored file
    expect(writes()).toHaveLength(0);
  });

  it("in a variant, for a step the variant added, opens the edit dialog focused on that variant", async () => {
    await openView("agent");
    button("Pick new target").click();
    await flush();
    expect($("dialog")).not.toBeNull();
    const cards = $$(".uc-variant-edit");
    expect(cards).toHaveLength(2);
    expect(cards[0].contains(document.activeElement)).toBe(true); // "agent" is the first variant
    expect(writes()).toHaveLength(0);
  });
});

describe("a variant that no longer exists", () => {
  it("falls back to the base flow with a toast instead of 'no longer exists'", async () => {
    variantGone = true;
    await openView("gone", { toMapping: false });
    expect(calls.filter((c) => c.tool === "get_use_case" && c.body.variant === "gone")).toHaveLength(1);
    expect(toast()).toBe("That variant no longer exists. Showing the base flow.");
    expect($(".uc-title").textContent).toBe("Map a step to an element");
  });
});
