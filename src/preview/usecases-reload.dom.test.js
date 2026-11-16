// @vitest-environment jsdom
//
// The reload path of the use case controller (usecases.js): a write reloads nothing by itself (its own SSE event does,
// once, with pool and list in parallel), the invalid-files toast shows only when the set changes and never replaces a
// write's confirmation, the selected mapping step survives a reload, and a failed first reload of a group is not silent.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUseCasesView } from "./usecases.js";
import { rawUseCase, personas, dimensions, objects, baseBundle } from "./usecases.test-helper.js";

let calls;
let invalid; // extra fields of the list answer (warnings, invalid_file_count)
let bundle; // what get_use_case answers
let failGroup;
let holdLists; // a promise the list_use_cases answers wait for, or null
let source;

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const settle = async () => {
  await new Promise((r) => setTimeout(r, 300)); // the 120 ms reload debounce
  await flush();
};
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const toast = () => ($(".uc-toast").hidden ? "" : $(".uc-toast strong").textContent);
const count = (tool) => calls.filter((c) => c.tool === tool).length;
const staleBundle = () => ({ ...baseBundle, screens: [{ screen: "gone-screen", exists: false, mappings: [{ step: "notify", scope: "screen", stale: true }] }] });

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
      if (holdLists) await holdLists;
      if (body.group && failGroup) return { ok: false, status: 500, json: async () => ({ code: "io_error", message: "disk on fire" }) };
      const summary = { id: "map-step", title: rawUseCase.title, group: "alpha", status: "ready", steps: 3 };
      return json({ total: 1, use_cases: body.group || body.limit !== 1 ? [summary] : [], counts: { use_cases: 1, personas: personas.length, dimensions: dimensions.length, data_objects: objects.length }, facets: { status: {}, group: { alpha: 1 }, tag: {}, persona: {} }, personas, dimensions, data_objects: objects, ...invalid });
    }
    if (path === "/api/tools/get_use_case") return json(bundle);
    if (path === "/api/tools/suggest_use_case_variants") return json({ suggestions: [] });
    if (path === "/api/use-case") return json({ use_case: source });
    if (path === "/api/tools/set_use_cases") return json({ warnings: [] });
    return json({});
  });
}

async function openView() {
  document.body.innerHTML = `<div id="root"></div>`;
  const view = createUseCasesView({ rootEl: $("#root"), getProject: () => "/p", getProjectName: () => "demo", getScreens: () => [{ name: "editor" }], fetchRender: async () => ({ ok: true, html: "<main></main>" }), fetchScreenNodes: async () => ({ ok: true, nodes: [] }), openScreen: () => {} });
  await view.show();
  await flush();
  return view;
}
const toMapping = async () => {
  $$(".uc-actions button").find((b) => b.textContent.includes("Show on screens")).click();
  await flush();
};
const leaveUnmapped = () => $$(".uc-map-stale-actions button").find((b) => b.textContent === "Leave unmapped").click();
const selectedStep = () => $(".uc-map-step.is-selected")?.dataset.step ?? null;

beforeEach(() => {
  invalid = {};
  bundle = baseBundle;
  failGroup = false;
  holdLists = null;
  source = structuredClone(rawUseCase);
  stubDaemon();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("one reload per write", () => {
  it("a write reloads nothing by itself; its SSE event reloads pool, list and detail once, pool and list in parallel", async () => {
    bundle = staleBundle();
    const view = await openView();
    await toMapping();
    calls.length = 0;
    leaveUnmapped();
    await settle();
    expect(count("set_use_cases")).toBe(1);
    expect(count("list_use_cases")).toBe(0);
    expect(count("get_use_case")).toBe(0);
    // The write's own event: hold the list answers back to see that pool and list are both in flight.
    let release;
    holdLists = new Promise((r) => (release = r));
    calls.length = 0;
    view.onChange();
    await new Promise((r) => setTimeout(r, 300));
    expect(count("list_use_cases")).toBe(2); // pool (include) and list, started together
    expect(count("get_use_case")).toBe(0); // the detail follows once they are in
    release();
    await settle();
    expect(count("list_use_cases")).toBe(3); // plus the one group the list has expanded
    expect(count("get_use_case")).toBe(1);
  });
});

describe("the invalid-files toast", () => {
  const warnings = [{ kind: "invalid_file", message: "usecases/cases/bad.json is not loaded" }];

  it("shows once for a set of invalid files and again only when the set changes", async () => {
    invalid = { warnings, invalid_file_count: 1 };
    const view = await openView();
    expect(toast()).toBe("Some use case files could not be loaded.");
    $(".uc-toast button").click();
    view.onChange();
    await settle();
    expect(toast()).toBe(""); // same set: not shown again
    invalid = { warnings: [...warnings, { kind: "invalid_file", message: "usecases/cases/worse.json is not loaded" }], invalid_file_count: 2 };
    view.onChange();
    await settle();
    expect(toast()).toBe("Some use case files could not be loaded.");
  });

  it("never replaces a save confirmation, and shows with the next reload once that is gone", async () => {
    bundle = staleBundle();
    const view = await openView();
    await toMapping();
    leaveUnmapped();
    await flush();
    expect(toast()).toBe("Step left unmapped.");
    invalid = { warnings, invalid_file_count: 1 };
    view.onChange();
    await settle();
    expect(toast()).toBe("Step left unmapped.");
    $(".uc-toast button").click();
    view.onChange();
    await settle();
    expect(toast()).toBe("Some use case files could not be loaded.");
  });
});

describe("the selected mapping step", () => {
  it("survives a reload while it still exists and falls back to none when it is gone", async () => {
    const view = await openView();
    await toMapping();
    $(".uc-map-step[data-step='pick'] .uc-map-step-btn").click();
    expect(selectedStep()).toBe("pick");
    view.onChange();
    await settle();
    expect($(".uc-mapping")).not.toBeNull();
    expect(selectedStep()).toBe("pick");
    bundle = { ...baseBundle, use_case: { ...baseBundle.use_case, steps: baseBundle.use_case.steps.filter((s) => s.id !== "pick") } };
    view.onChange();
    await settle();
    expect($(".uc-mapping")).not.toBeNull();
    expect(selectedStep()).toBeNull();
  });
});

describe("a failed reload of a group", () => {
  it("shows the error row with Retry instead of staying silent", async () => {
    const view = await openView();
    expect($$(".uc-list-title").map((n) => n.textContent)).toEqual([rawUseCase.title]);
    failGroup = true;
    view.onChange();
    await settle();
    expect($(".uc-error-text").textContent).toContain("disk on fire");
    failGroup = false;
    $(".uc-error-row button").click();
    await flush();
    expect($(".uc-error-row")).toBeNull();
    expect($$(".uc-list-title").map((n) => n.textContent)).toEqual([rawUseCase.title]);
  });
});
