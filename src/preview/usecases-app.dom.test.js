// @vitest-environment jsdom
//
// The Use Cases tab inside the whole app (index.html + app.js against a fake daemon): optional by construction.
// A project without usecases/ gets the empty guide, opening the tab only ever reads (list_use_cases / get_use_case /
// GET /api/use-case), every other view is untouched, the list is paged from the server, and SSE `usecases` events
// reload what is shown.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";
import { rawUseCase, personas, dimensions, objects, baseBundle } from "./usecases.test-helper.js";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

const memoryStorage = new Map();
const storageStub = {
  getItem: (k) => memoryStorage.get(k) ?? null,
  setItem: (k, v) => void memoryStorage.set(k, String(v)),
  removeItem: (k) => void memoryStorage.delete(k),
  get length() {
    return memoryStorage.size;
  },
  key: (i) => [...memoryStorage.keys()][i] ?? null,
  clear: () => memoryStorage.clear(),
};

let sources;
let calls; // every request the page made: { path, tool, body, method }
let store; // the fake use-case store; null = a project without usecases/
let screens;

function summarize(u) {
  return { id: u.id, title: u.title, ...(u.group ? { group: u.group } : {}), status: u.status, steps: u.steps.length, ...(u.variants?.length ? { variants: u.variants.length } : {}) };
}

/** A small stand-in for list_use_cases: group prefix, status, query, limit/cursor, include, counts and facets on the first page. */
function listUseCases(input) {
  if (store?.failCursor && input.cursor !== undefined) return { __fail: true };
  if (store?.failInclude && input.include) return { __fail: true, status: 422, code: "invalid_state", message: "invalid usecases/personas.json: not valid JSON" };
  const all = store?.cases ?? [];
  let list = all.filter((u) => (!input.screen || u.steps.some((s) => s.target?.screen === input.screen)) && (!input.group || u.group === input.group || u.group?.startsWith(`${input.group}/`)) && (!input.status || u.status === input.status) && (!input.query || u.title.toLowerCase().includes(input.query.toLowerCase())));
  list = [...list].sort((a, b) => (a.group ?? "\uffff").localeCompare(b.group ?? "\uffff") || a.title.localeCompare(b.title));
  const offset = input.cursor ? Number(input.cursor) : 0;
  const limit = input.limit ?? 50;
  const response = { total: list.length, use_cases: list.slice(offset, offset + limit).map(summarize) };
  if (offset + limit < list.length) response.next_cursor = String(offset + limit);
  if (input.cursor === undefined) {
    const count = (key) => list.reduce((acc, u) => (u[key] === undefined ? acc : { ...acc, [u[key]]: (acc[u[key]] ?? 0) + 1 }), {});
    response.counts = { use_cases: all.length, personas: store?.personas.length ?? 0, dimensions: store?.dimensions.length ?? 0, data_objects: store?.objects.length ?? 0 };
    response.facets = { status: count("status"), group: count("group"), tag: {}, persona: {} };
    if (store?.truncated) response.facets_truncated = store.truncated;
  }
  if (store?.invalid) Object.assign(response, store.invalid);
  if (input.include?.includes("personas")) response.personas = store?.personas ?? [];
  if (input.include?.includes("dimensions")) response.dimensions = store?.dimensions ?? [];
  if (input.include?.includes("data_objects")) response.data_objects = store?.objects ?? [];
  return response;
}

function stubDaemon() {
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  sources = [];
  calls = [];
  vi.stubGlobal("EventSource", class { constructor() { sources.push(this); } close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("fetch", async (url, init) => {
    const path = String(url).split("?")[0];
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, tool: path.startsWith("/api/tools/") ? path.slice(11) : null, body, method: init?.method ?? "GET" });
    const json = (value) => ({ ok: true, status: 200, json: async () => value, text: async () => "" });
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "demo" }], recent: [] });
    if (path === "/api/screens") return json({ screens });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [] });
    if (path === "/api/tools/get_screen") return json({ nodes: [] });
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<main id="m"><div id="btn-map">x</div></main>` };
    if (path === "/api/tools/list_use_cases") {
      const answer = listUseCases(body ?? {});
      if (answer.__fail) return { ok: false, status: answer.status ?? 500, json: async () => ({ code: answer.code ?? "io_error", message: answer.message ?? "disk on fire" }) };
      return json(answer);
    }
    if (path === "/api/tools/get_use_case") {
      const found = store?.cases.find((u) => u.id === body?.id);
      return json(found ? { ...baseBundle, use_case: { ...baseBundle.use_case, id: found.id, title: found.title, group: found.group } } : baseBundle);
    }
    if (path === "/api/use-case") return json({ use_case: rawUseCase });
    return json({});
  });
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const emit = (event) => sources.at(-1).onmessage({ data: JSON.stringify(event) });
const openTab = async () => {
  $('[data-view="usecases"]').click();
  await flush();
};
const useCaseCalls = () => calls.filter((c) => c.tool && /use_case|personas|delete_entity/.test(c.tool) || c.path === "/api/use-case");

const caseOf = (i, group, status = "draft") => ({ ...rawUseCase, id: `uc-${i}`, title: `Case ${i}`, group, status, variants: undefined });

beforeEach(() => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  screens = [{ name: "editor", tags: [], notes: "" }];
  store = null;
  stubDaemon();
});
afterEach(() => vi.unstubAllGlobals());

describe("optionality", () => {
  it("adds a fourth tab and fetches nothing use-case related until it is opened", async () => {
    await import("./app.js");
    await flush();
    expect($$(".view-tab").map((t) => t.textContent)).toEqual(["Screens", "Design System", "Board", "Use Cases"]);
    expect($("#usecases-view").hidden).toBe(true);
    // The only read is the Screens tab's reverse entry (list_use_cases scoped to the open screen); the Use Cases tab fetches nothing itself.
    expect(useCaseCalls().every((c) => c.tool === "list_use_cases" && c.body.screen === "editor")).toBe(true);
    expect(calls.some((c) => c.tool === "list_use_cases" && c.body.include)).toBe(false);
    expect($(".uc-guide")).toBeNull(); // nothing is rendered either, not even the empty guide
  });

  it("a project without usecases/ shows the empty guide, and opening the tab writes nothing", async () => {
    await import("./app.js");
    await flush();
    await openTab();
    expect($("#usecases-view").hidden).toBe(false);
    expect($(".uc-guide-title").textContent).toBe("Describe what people do with your screens");
    expect($(".uc-guide-lede").textContent).toContain("optional");
    expect($(".uc-guide").textContent).toContain("Write use cases for the screens in demo");
    expect($(".uc-list-status").textContent).toBe("0 use cases · 0 personas");
    const tools = useCaseCalls().map((c) => c.tool ?? c.path);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t === "list_use_cases")).toBe(true); // reads only
    expect(calls.some((c) => c.method !== "GET" && /set_use_cases|generate_personas|delete_entity/.test(c.tool ?? ""))).toBe(false);
  });

  it("while it shows, the Screens and Context sidebars and the Elements panel make way; every other view comes back unchanged", async () => {
    await import("./app.js");
    await flush();
    expect($("#sidebar-screens").hidden).toBe(false);
    await openTab();
    expect($("#sidebar-screens").hidden).toBe(true);
    expect($("#sidebar-context").hidden).toBe(true);
    expect($("#inspector").hidden).toBe(true);
    expect($("#screens-view").hidden).toBe(true);
    expect($("#flow-mode-toggle").disabled).toBe(true);
    expect($("#comment-mode-toggle").disabled).toBe(true);
    expect($("#inspect-mode-toggle").disabled).toBe(true);
    $('[data-view="screens"]').click();
    await flush();
    expect($("#usecases-view").hidden).toBe(true);
    expect($("#sidebar-screens").hidden).toBe(false);
    expect($("#sidebar-context").hidden).toBe(false);
    expect($("#inspector").hidden).toBe(false);
    expect($("#screens-view").hidden).toBe(false);
    expect($("#flow-mode-toggle").disabled).toBe(false);
    expect($("#inspect-mode-toggle").disabled).toBe(false);
    $('[data-view="board"]').click();
    await flush();
    expect($("#usecases-view").hidden).toBe(true);
    expect($("#board-view").hidden).toBe(false);
  });

  it("reopening the tab does not fetch again (live events keep it current)", async () => {
    await import("./app.js");
    await flush();
    await openTab();
    const tabCalls = () => useCaseCalls().filter((c) => !c.body?.screen).length; // the Screens tab's own reverse-entry reads are not the tab's
    const before = tabCalls();
    $('[data-view="screens"]').click();
    await openTab();
    expect(tabCalls()).toBe(before);
  });
});

describe("with use cases", () => {
  beforeEach(() => {
    store = { personas, dimensions, objects, cases: [caseOf(1, "mapping/elements", "ready"), caseOf(2, "mapping/elements"), caseOf(3, "personas")] };
  });

  it("lands on the first group's first case: tree with counts from the facets, the detail from get_use_case", async () => {
    await import("./app.js");
    await flush();
    await openTab();
    expect($(".uc-result-text").textContent).toBe("3 use cases");
    expect($$(".uc-group-row .uc-group-name").map((n) => n.textContent)).toEqual(["mapping", "elements", "personas"]);
    expect($$(".uc-group-row .uc-group-count").map((n) => n.textContent)).toEqual(["2", "2", "1"]);
    expect($(".uc-list-row.is-selected .uc-list-title").textContent).toBe("Case 1");
    expect($(".uc-title").textContent).toBe("Case 1"); // the detail comes from get_use_case
    expect(calls.some((c) => c.tool === "get_use_case")).toBe(true);
    expect($(".uc-guide")).toBeNull();
  });

  it("filters, search and sort are server-side requests", async () => {
    await import("./app.js");
    await flush();
    await openTab();
    calls.length = 0;
    const input = $(".uc-search-input");
    input.value = "Case 3";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 400));
    await flush();
    const query = calls.filter((c) => c.tool === "list_use_cases").map((c) => c.body);
    expect(query.length).toBeGreaterThan(0);
    expect(query.every((b) => b.query === "Case 3")).toBe(true);
    expect($(".uc-result-text").textContent).toBe("1 of 3 use cases");
  });

  it("an SSE usecases event reloads the list and the open detail", async () => {
    await import("./app.js");
    await flush();
    await openTab();
    store.cases.push(caseOf(4, "personas"));
    calls.length = 0;
    emit({ type: "change", kind: "usecases", name: "cases/uc-4" });
    await new Promise((r) => setTimeout(r, 300));
    await flush();
    expect($(".uc-result-text").textContent).toBe("4 use cases");
    expect(calls.some((c) => c.tool === "get_use_case")).toBe(true);
  });

  it("a reload keeps the loaded rows of an expanded group and of No group, and never shrinks the list while it runs", async () => {
    store.cases = [...Array.from({ length: 9 }, (_, i) => caseOf(i + 1, "alpha")), ...Array.from({ length: 10 }, (_, i) => caseOf(i + 20, undefined))];
    await import("./app.js");
    await flush();
    await openTab();
    const titles = () => $$(".uc-list-row .uc-list-title").map((n) => n.textContent);
    $$(".uc-group-row").find((r) => r.textContent.includes("No group")).click();
    await flush();
    for (let i = 0; i < 2; i++) {
      $$(".uc-more-row").at(-1)?.click();
      await flush();
    }
    const before = titles().length;
    expect(before).toBeGreaterThan(8);
    // Hold the page requests back so the rows while the reload runs can be observed.
    const real = globalThis.fetch;
    let release;
    const gate = new Promise((r) => (release = r));
    vi.stubGlobal("fetch", async (url, init) => {
      if (String(url).includes("list_use_cases")) await gate;
      return real(url, init);
    });
    emit({ type: "change", kind: "usecases", name: "cases/uc-1" });
    await new Promise((r) => setTimeout(r, 350));
    expect(titles().length).toBe(before); // rows stay while the reload runs
    release();
    await new Promise((r) => setTimeout(r, 300));
    await flush();
    expect(titles().length).toBe(before); // and the same number is back afterwards
  });

  it("unreadable case files show the toast with the first five and the real count, and the list still loads", async () => {
    const warnings = Array.from({ length: 5 }, (_, i) => ({ kind: "invalid_file", message: "usecases/cases/bad-" + i + ".json is not loaded" }));
    store.invalid = { warnings, invalid_file_count: 8 };
    await import("./app.js");
    await flush();
    await openTab();
    const toast = $(".uc-toast");
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toContain("Some use case files could not be loaded.");
    expect($$(".uc-toast li")).toHaveLength(5);
    expect(toast.textContent).toContain("and 3 more");
    expect($(".uc-result-text").textContent).toBe("3 use cases");
  });

  it("an invalid pool file (invalid_state) is reported with the server message", async () => {
    store.failInclude = true;
    await import("./app.js");
    await flush();
    await openTab();
    expect($(".uc-toast").textContent).toContain("invalid usecases/personas.json");
  });

  it("the folder-level events of usecases/ and usecases/cases reload too (a case written with its new folder has no file event)", async () => {
    await import("./app.js");
    await flush();
    await openTab();
    for (const name of ["cases", "usecases"]) {
      store.cases.push(caseOf(store.cases.length + 1, "personas"));
      calls.length = 0;
      emit({ type: "change", kind: "usecases", name });
      await new Promise((r) => setTimeout(r, 300));
      await flush();
      expect($(".uc-result-text").textContent).toBe(`${store.cases.length} use cases`);
      expect(calls.some((c) => c.tool === "list_use_cases")).toBe(true);
    }
  });

});

describe("reverse entry", () => {
  it("a screen lists the use cases that map to it, on a cold load too; one click opens it in the tab", async () => {
    store = { personas, dimensions, objects, cases: [caseOf(1, "mapping/elements", "ready"), caseOf(2, "personas")] };
    await import("./app.js");
    await flush();
    expect($("#screen-usecases").hidden).toBe(false); // straight into Screens, the Use Cases tab never opened
    expect(calls.some((c) => c.tool === "list_use_cases" && c.body.include)).toBe(false);
    expect($(".screen-usecases-sub").textContent).toBe("Steps that map to editor");
    expect($$(".screen-usecases-row").map((r) => r.textContent)).toEqual(["Case 1", "Case 2"]);
    calls.length = 0;
    $$(".screen-usecases-row")[1].click();
    await flush();
    expect($("#usecases-view").hidden).toBe(false);
    expect($(".uc-list-row.is-selected .uc-list-title").textContent).toBe("Case 2");
  });

  it("stays hidden when nothing maps to the screen", async () => {
    store = { personas, dimensions, objects, cases: [caseOf(1, "mapping/elements")] };
    screens = [{ name: "other", tags: [], notes: "" }];
    await import("./app.js");
    await flush();
    expect($("#screen-usecases").hidden).toBe(true);
  });

  it("stays out of the way for a project without use cases", async () => {
    await import("./app.js");
    await flush();
    await openTab();
    $('[data-view="screens"]').click();
    await flush();
    expect($("#screen-usecases").hidden).toBe(true);
  });
});

describe("review round 1", () => {
  it("global shortcuts do not fire behind an open use case dialog", async () => {
    store = { personas, dimensions, objects, cases: [caseOf(1, "mapping/elements")] };
    await import("./app.js");
    await flush();
    await openTab();
    const dialog = document.createElement("dialog");
    dialog.className = "uc-dialog";
    document.body.append(dialog);
    dialog.setAttribute("open", "");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    await flush();
    expect($("#usecases-view").hidden).toBe(false); // "1" would switch to Screens
    dialog.removeAttribute("open");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    await flush();
    expect($("#usecases-view").hidden).toBe(true);
  });
});

describe("review fixes", () => {
  it("the Context panel markup keeps unique ids and the notes -> comments sibling rule (comments divider)", async () => {
    await import("./app.js");
    await flush();
    const ids = $$("[id]").map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect($("#notes-panel").nextElementSibling.id).toBe("comments-panel");
    expect($("#screen-usecases").nextElementSibling.id).toBe("notes-panel");
  });

  it("events that arrive while the tab is hidden are applied: coming back shows the new state", async () => {
    store = { personas, dimensions, objects, cases: [caseOf(1, "mapping/elements")] };
    await import("./app.js");
    await flush();
    await openTab();
    expect($(".uc-result-text").textContent).toBe("1 use case");
    $('[data-view="screens"]').click();
    await flush();
    store.cases.push(caseOf(2, "mapping/elements"), caseOf(3, "personas"));
    emit({ type: "change", kind: "usecases", name: "cases/uc-3" });
    await new Promise((r) => setTimeout(r, 300));
    await flush();
    await openTab();
    expect($(".uc-result-text").textContent).toBe("3 use cases");
  });

  it("an edit always starts from the stored file, not from the copy the detail view loaded earlier", async () => {
    store = { personas, dimensions, objects, cases: [caseOf(1, "mapping/elements")] };
    await import("./app.js");
    await flush();
    await openTab();
    calls.length = 0;
    $$(".uc-actions button")
      .find((b) => b.textContent.includes("Edit"))
      .click();
    await flush();
    expect(calls.some((c) => c.path === "/api/use-case")).toBe(true);
    expect($("dialog")).not.toBeNull();
  });

  it("a group with a trailing slash (not addressable as a tree path) switches to the flat list, so every case is reachable", async () => {
    store = { personas, dimensions, objects, cases: [caseOf(1, "mapping/"), caseOf(2, "a//b"), caseOf(3, "mapping")] };
    await import("./app.js");
    await flush();
    await openTab();
    const titles = $$(".uc-list-title").map((n) => n.textContent);
    expect(titles).toEqual(expect.arrayContaining(["Case 1", "Case 2", "Case 3"]));
    expect($(".uc-group-row")).toBeNull();
  });

  it("group paging uses the cursor and never asks for more than 100 rows at once", async () => {
    store = { personas, dimensions, objects, cases: Array.from({ length: 140 }, (_, i) => caseOf(i, "big")) };
    await import("./app.js");
    await flush();
    await openTab();
    expect($$(".uc-list-row")).toHaveLength(4);
    calls.length = 0;
    $(".uc-more-row").click();
    await flush();
    const more = calls.filter((c) => c.tool === "list_use_cases").map((c) => c.body);
    expect(more).toHaveLength(1);
    expect(more[0]).toMatchObject({ group: "big", limit: 25 });
    expect(more[0].cursor).toBe("4");
    expect($(".uc-tree-spacer").style.height).toBe(`${28 + 29 * 46 + 26}px`); // group row, 29 cases, "Show more"
    // a refresh of what is loaded pages by cursor too
    emit({ type: "change", kind: "usecases", name: "cases/uc-1" });
    await new Promise((r) => setTimeout(r, 300));
    await flush();
    expect(Math.max(...calls.filter((c) => c.tool === "list_use_cases").map((c) => c.body.limit ?? 50))).toBeLessThanOrEqual(100);
    expect($(".uc-tree-spacer").style.height).toBe(`${28 + 29 * 46 + 26}px`); // the 29 loaded rows survive the refresh
  });

  it("a failed flat page stops auto-paging and offers Retry", async () => {
    store = { personas, dimensions, objects, cases: Array.from({ length: 150 }, (_, i) => caseOf(i, "g//x")), failCursor: true };
    await import("./app.js");
    await flush();
    await openTab();
    await flush();
    $(".uc-tree").scrollTop = 99999; // the end of the 100 loaded rows: the list asks for the next page
    $(".uc-tree").dispatchEvent(new Event("scroll"));
    await flush();
    const failing = () => calls.filter((c) => c.tool === "list_use_cases" && c.body.cursor !== undefined).length;
    expect($(".uc-error-row").textContent).toContain("disk on fire");
    const afterFirst = failing();
    expect(afterFirst).toBe(1);
    await flush();
    expect(failing()).toBe(afterFirst); // no request loop
    const heightBefore = $(".uc-tree-spacer").style.height;
    store.failCursor = false;
    $(".uc-error-row button").click();
    await flush();
    expect($(".uc-error-row")).toBeNull();
    expect($(".uc-tree-spacer").style.height).not.toBe(heightBefore);
  });

  it("with truncated persona facets the persona menu still lists every persona of the pool", async () => {
    store = { personas, dimensions, objects, cases: [caseOf(1, "mapping/elements")], truncated: ["persona"] };
    await import("./app.js");
    await flush();
    await openTab();
    $$(".uc-filter-chip-main")
      .find((b) => b.textContent.startsWith("Persona"))
      .click();
    await flush();
    expect($$(".uc-menu .uc-menu-label").map((l) => l.textContent)).toEqual(["Dana", "Dex", "Medium project"]);
  });
});

describe("scale", () => {
  it("2,500 use cases: the list keeps a handful of rows in the DOM and asks the server for pages, never for everything", async () => {
    const groups = Array.from({ length: 25 }, (_, g) => `area-${String(g).padStart(2, "0")}/sub`);
    store = { personas, dimensions, objects, cases: Array.from({ length: 2500 }, (_, i) => caseOf(i, groups[i % 25])) };
    await import("./app.js");
    await flush();
    await openTab();
    expect($(".uc-result-text").textContent).toBe("2,500 use cases");
    expect($$("#usecases-view .uc-tree-window > *").length).toBeLessThan(40);
    expect($$("#usecases-view *").length).toBeLessThan(900); // the whole tab, detail included
    const requested = calls.filter((c) => c.tool === "list_use_cases").map((c) => c.body.limit ?? 50);
    expect(Math.max(...requested)).toBeLessThanOrEqual(100);
    const rowsFetched = calls.filter((c) => c.tool === "list_use_cases").reduce((sum, c) => sum + (c.body.limit ?? 50), 0);
    expect(rowsFetched).toBeLessThan(200);
  });
});
