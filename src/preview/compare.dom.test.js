// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCompareView } from "./compare.js";

const s = (name, variant_of, variant_kind = "state") => ({ name, tags: [], ...(variant_of ? { variant_of, variant_kind } : {}) });
const screens = [s("plain"), s("family"), s("a", "family"), s("a1", "a"), s("b", "family"), s("c", "family"), s("d", "family")];

const okMember = (screen, extra = {}) => ({
  screen,
  status: "ok",
  overlap: { shared: 5, base: 6, member: 5, ratio: 0.8 },
  added: [],
  removed: [],
  changed: [],
  counts: { added: 0, removed: 0, changed: 0 },
  ...extra,
});

function memoryStorage(init = {}) {
  const data = { ...init };
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v), removeItem: (k) => void delete data[k], data };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

let screenList;
let compare;
let deps;
let els;
let storage;

function setup({ members = [okMember("a")], storageInit } = {}) {
  document.body.innerHTML =
    '<div id="bar"></div><p id="hint" hidden></p><div id="canvas"><div id="wrap"><div id="columns"></div></div></div><aside id="panel"></aside>';
  els = {
    barEl: document.getElementById("bar"),
    hintEl: document.getElementById("hint"),
    canvasEl: document.getElementById("canvas"),
    columnsEl: document.getElementById("columns"),
    panelEl: document.getElementById("panel"),
  };
  storage = memoryStorage(storageInit);
  deps = {
    storage,
    getProject: () => "/p",
    getScreens: () => screenList,
    fetchRender: vi.fn(async (name) => ({ ok: true, html: `<div id="root">${name}</div>` })),
    fetchCompare: vi.fn(async (base, others) => ({
      ok: true,
      compare: { base, members: others.map((o) => members.find((m) => m.screen === o) ?? okMember(o)) },
    })),
    onAdd: vi.fn(),
    onChange: vi.fn(),
  };
  compare = createCompareView(els, deps);
  return compare;
}

/** jsdom never renders a srcdoc: give a column's iframe a fake document with fixed node rects and fire its load. */
function loadFrame(name, rects = {}) {
  const iframe = els.columnsEl.querySelector(`.compare-column[data-screen="${name}"] iframe`);
  const doc = {
    documentElement: { scrollWidth: 300, scrollHeight: 500 },
    getElementById: (id) => (id in rects ? { getBoundingClientRect: () => ({ left: rects[id][0], top: rects[id][1], width: rects[id][2], height: rects[id][3] }) } : null),
  };
  Object.defineProperty(iframe, "contentDocument", { configurable: true, value: doc });
  iframe.dispatchEvent(new Event("load"));
}

const chipNames = () => [...els.barEl.querySelectorAll(".compare-chip[data-screen]")].map((c) => c.dataset.screen);
const columnNames = () => [...els.columnsEl.querySelectorAll(".compare-column")].map((c) => c.dataset.screen);
const marks = (name) => [...els.columnsEl.querySelector(`.compare-column[data-screen="${name}"]`).querySelectorAll(".compare-mark")];

beforeEach(() => {
  screenList = screens;
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
});
afterEach(() => vi.unstubAllGlobals());

describe("entering and leaving compare", () => {
  it("makes the family's main screen the locked reference and preselects the open variant", async () => {
    setup();
    expect(compare.enter("a1")).toBe(true);
    expect(compare.isOn()).toBe(true);
    expect(compare.state()).toMatchObject({ on: true, reference: "family", selected: ["a1"] });
    expect(chipNames()).toEqual(["family", "a1"]);
    const reference = els.barEl.querySelector(".compare-chip-reference");
    expect(reference.textContent).toContain("reference");
    expect(reference.querySelector("button")).toBeNull(); // locked: no remove control
    expect(columnNames()).toEqual(["family", "a1"]);
    expect(deps.onChange).toHaveBeenCalled();
    await flush();
    expect(deps.fetchCompare).toHaveBeenCalledWith("family", ["a1"]);
  });

  it("opened on the main screen itself preselects nothing and does not call the server", async () => {
    setup();
    compare.enter("family");
    await flush();
    expect(compare.state().selected).toEqual([]);
    expect(columnNames()).toEqual(["family"]);
    expect(els.hintEl.hidden).toBe(false);
    expect(els.hintEl.textContent).toBe("pick 1–3 screens");
    expect(deps.fetchCompare).not.toHaveBeenCalled();
  });

  it("refuses a screen whose family has no other screen", () => {
    setup();
    expect(compare.enter("plain")).toBe(false);
    expect(compare.isOn()).toBe(false);
    expect(deps.onChange).not.toHaveBeenCalled();
  });

  it("leaving returns the screen that was open on entry and clears the view", () => {
    setup();
    compare.enter("b");
    expect(compare.leave()).toBe("b");
    expect(compare.isOn()).toBe(false);
    expect(els.columnsEl.children).toHaveLength(0);
    expect(els.barEl.children).toHaveLength(0);
    expect(compare.leave()).toBeNull();
  });

  it("restores the selection stored for this reference, capped at three members", () => {
    setup({ storageInit: { "artisign.compareSelection:/p": JSON.stringify({ family: ["c", "d", "a", "b"] }) } });
    compare.enter("b");
    expect(compare.state().selected).toEqual(["b", "c", "d"]);
  });
});

describe("member selection", () => {
  it("toggle adds a chip and a column, capped at three members", async () => {
    setup();
    compare.enter("a");
    compare.toggle("b");
    compare.toggle("c");
    compare.toggle("d"); // fourth member: ignored
    expect(compare.state().selected).toEqual(["a", "b", "c"]);
    expect(chipNames()).toEqual(["family", "a", "b", "c"]);
    expect(columnNames()).toEqual(["family", "a", "b", "c"]);
    expect(els.barEl.querySelector(".compare-chip-add").disabled).toBe(true);
  });

  it("the chip's remove button unticks the member, and the reference cannot be toggled", () => {
    setup();
    compare.enter("a");
    compare.toggle("b");
    els.barEl.querySelector('.compare-chip[data-screen="a"] .compare-chip-remove').click();
    expect(compare.state().selected).toEqual(["b"]);
    compare.toggle("family");
    compare.toggle("plain");
    expect(compare.state().selected).toEqual(["b"]);
  });

  it("stores the selection per reference and tells the app on every change", () => {
    setup();
    compare.enter("a");
    deps.onChange.mockClear();
    compare.toggle("b");
    expect(JSON.parse(storage.data["artisign.compareSelection:/p"])).toEqual({ family: ["a", "b"] });
    expect(deps.onChange).toHaveBeenCalledTimes(1);
  });

  it("the + add chip asks the app to open the breadcrumb popover", () => {
    setup();
    compare.enter("a");
    els.barEl.querySelector(".compare-chip-add").click();
    expect(deps.onAdd).toHaveBeenCalled();
  });

  it("reports the family so the sidebar can limit its checkboxes to it", () => {
    setup();
    compare.enter("a");
    expect(compare.state().family).toEqual(["family", "a", "a1", "b", "c", "d"]);
    expect(compare.inFamily("d")).toBe(true);
    expect(compare.inFamily("plain")).toBe(false);
  });
});

describe("diff marks", () => {
  const sample = okMember("a", {
    added: ["new-card"],
    changed: ["title"],
    removed: [{ id: "old-card", parent: "list" }, { id: "gone", parent: "list" }],
  });

  async function enterAndLoad() {
    setup({ members: [sample] });
    compare.enter("a");
    await flush();
    loadFrame("family", { "old-card": [10, 20, 100, 30], list: [5, 15, 200, 300], title: [0, 0, 50, 10] });
    loadFrame("a", { "new-card": [11, 21, 101, 31], title: [1, 2, 51, 11] });
  }

  it("outlines added and changed nodes in the member column with a badge, none in the reference", async () => {
    await enterAndLoad();
    const found = marks("a").filter((m) => m.dataset.kind !== "removed");
    expect(found.map((m) => [m.dataset.kind, m.dataset.id, m.querySelector(".compare-mark-badge").textContent])).toEqual([
      ["added", "new-card", "+ added"],
      ["changed", "title", "~ changed"],
    ]);
    expect(found[0].style.left).toBe("11px");
    expect(found[0].style.height).toBe("31px");
    expect(marks("family")).toHaveLength(0);
  });

  it("draws a removed node as a ghost at its rect in the reference, else at its parent's rect", async () => {
    await enterAndLoad();
    const ghosts = marks("a").filter((m) => m.dataset.kind === "removed");
    expect(ghosts.map((g) => g.dataset.id)).toEqual(["old-card", "gone"]);
    expect(ghosts[0].style.left).toBe("10px"); // own rect in the reference column
    expect(ghosts[0].style.width).toBe("100px");
    expect(ghosts[1].style.left).toBe("5px"); // "gone" is unknown in the reference: the parent's rect
    expect(ghosts[1].style.width).toBe("200px");
    expect(ghosts[0].querySelector(".compare-mark-badge").textContent).toBe("− removed");
  });

  it("lists one signed row per node id with its member", async () => {
    await enterAndLoad();
    const rows = [...els.panelEl.querySelectorAll(".compare-diff-row")];
    expect(rows.map((r) => [r.querySelector(".compare-diff-sign").textContent, r.dataset.id, r.dataset.member])).toEqual([
      ["+", "new-card", "a"],
      ["~", "title", "a"],
      ["−", "old-card", "a"],
      ["−", "gone", "a"],
    ]);
    expect(els.panelEl.querySelector(".compare-summary h3").textContent).toBe("vs. reference family");
    expect(els.panelEl.querySelector(".compare-summary-row").textContent).toContain("4 nodes");
    expect(els.columnsEl.querySelector('.compare-column[data-screen="a"] .compare-label-note').textContent).toBe("4 diffs");
    expect(els.columnsEl.querySelector('.compare-column[data-screen="family"] .compare-label-note').textContent).toBe("reference");
  });

  it("the Diff checkbox hides outlines, badges and the list but keeps the columns", async () => {
    await enterAndLoad();
    const box = els.barEl.querySelector(".compare-diff-toggle");
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(marks("a")).toHaveLength(0);
    expect(els.panelEl.querySelector(".compare-diff-list")).toBeNull();
    expect(columnNames()).toEqual(["family", "a"]);
    expect(storage.data["artisign.compareDiff"]).toBe("false");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(marks("a").length).toBeGreaterThan(0);
  });

  it("a click on a row highlights the node in every column that has it; a second click clears", async () => {
    await enterAndLoad();
    const row = (id) => els.panelEl.querySelector(`.compare-diff-row[data-id="${id}"]`);
    const highlights = (name) => [...els.columnsEl.querySelector(`.compare-column[data-screen="${name}"]`).querySelectorAll(".compare-highlight")];

    row("title").click(); // changed: exists in both columns
    expect(highlights("family")).toHaveLength(1);
    expect(highlights("a")).toHaveLength(1);
    expect(marks("a").find((m) => m.dataset.id === "title").classList.contains("highlighted")).toBe(true);
    expect(row("title").getAttribute("aria-pressed")).toBe("true");

    row("old-card").click(); // removed: the reference node plus the ghost
    expect(highlights("family")).toHaveLength(1);
    expect(highlights("a")).toHaveLength(0);
    expect(marks("a").find((m) => m.dataset.id === "old-card").classList.contains("highlighted")).toBe(true);

    row("old-card").click();
    expect(els.columnsEl.querySelectorAll(".compare-highlight")).toHaveLength(0);
  });
});

describe("low_overlap", () => {
  const low = okMember("a", { status: "low_overlap", overlap: { shared: 2, base: 18, member: 9, ratio: 0.11 } });

  it("renders the column unmarked with a banner, no rows, and the percentage on the chip", async () => {
    setup({ members: [low] });
    compare.enter("a");
    await flush();
    loadFrame("family");
    loadFrame("a");
    const banner = els.columnsEl.querySelector('.compare-column[data-screen="a"] .compare-banner');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toBe("Too few shared node ids with the reference (2 of 18) — diff unavailable");
    expect(marks("a")).toHaveLength(0);
    expect(els.panelEl.querySelectorAll(".compare-diff-row")).toHaveLength(0);
    expect(els.barEl.querySelector('.compare-chip[data-screen="a"] .compare-chip-overlap').textContent).toBe("11%");
    expect(els.panelEl.querySelector(".compare-summary-row").textContent).toContain("unavailable");
  });
});

describe("staying current", () => {
  it("a change to a compared screen reloads its column and refetches the diff", async () => {
    setup();
    compare.enter("a");
    await flush();
    deps.fetchRender.mockClear();
    deps.fetchCompare.mockClear();
    compare.screenChanged("a");
    await flush();
    expect(deps.fetchRender).toHaveBeenCalledTimes(1);
    expect(deps.fetchRender).toHaveBeenCalledWith("a");
    expect(deps.fetchCompare).toHaveBeenCalledTimes(1);
    compare.screenChanged("b"); // not compared
    compare.screenChanged("plain");
    await flush();
    expect(deps.fetchCompare).toHaveBeenCalledTimes(1);
  });

  it("a change to the reference reloads the reference column", async () => {
    setup();
    compare.enter("a");
    await flush();
    deps.fetchRender.mockClear();
    compare.screenChanged("family");
    expect(deps.fetchRender).toHaveBeenCalledWith("family");
  });

  it("a deleted member falls out of the selection; a deleted reference leaves compare", async () => {
    setup();
    compare.enter("a");
    compare.toggle("b");
    screenList = screens.filter((x) => x.name !== "a");
    compare.reconcile();
    expect(compare.state().selected).toEqual(["b"]);
    expect(columnNames()).toEqual(["family", "b"]);
    screenList = screens.filter((x) => x.name !== "family");
    compare.reconcile();
    expect(compare.isOn()).toBe(false);
  });

  it("ignores a stale diff response", async () => {
    setup();
    let resolveFirst;
    deps.fetchCompare.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    compare.enter("a");
    compare.toggle("b"); // second fetch resolves immediately
    await flush();
    resolveFirst({ ok: true, compare: { base: "family", members: [okMember("a", { added: ["stale"] })] } });
    await flush();
    expect(els.panelEl.querySelector('.compare-diff-row[data-id="stale"]')).toBeNull();
  });
});

describe("zoom", () => {
  it("defaults to Fit, is shared by all columns, and is stored per browser", () => {
    setup();
    compare.enter("a");
    const pressed = () => [...els.barEl.querySelectorAll(".compare-zoom-button")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.zoom);
    expect(pressed()).toEqual(["fit"]);
    els.barEl.querySelector('.compare-zoom-button[data-zoom="1.5"]').click();
    expect(pressed()).toEqual(["1.5"]);
    expect(storage.data["artisign.compareZoom"]).toBe("1.5");
    expect(els.columnsEl.style.transform).toBe("scale(1.5)");
    expect(compare.getZoom()).toBe(1.5);
  });

  it("reads the stored zoom on creation", () => {
    setup({ storageInit: { "artisign.compareZoom": "1" } });
    expect(compare.getZoom()).toBe(1);
  });
});

describe("a hidden compare view", () => {
  it("holds renders back until show(), since a hidden iframe measures 0x0", async () => {
    setup();
    let visible = false;
    deps.isVisible = () => visible;
    compare = createCompareView(els, deps);
    compare.enter("a");
    await flush();
    expect(deps.fetchRender).not.toHaveBeenCalled();
    compare.screenChanged("a"); // an SSE reload while hidden waits too
    await flush();
    expect(deps.fetchRender).not.toHaveBeenCalled();
    visible = true;
    compare.show();
    await flush();
    expect(deps.fetchRender.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "family"]);
    compare.show(); // nothing left to run
    await flush();
    expect(deps.fetchRender).toHaveBeenCalledTimes(2);
  });
});
