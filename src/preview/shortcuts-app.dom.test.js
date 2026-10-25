// @vitest-environment jsdom
//
// CHR-916 — the keyboard shortcuts wired in app.js end to end: the real index.html body, the real modules, a stubbed daemon. The mapping and the guards are unit-tested in shortcuts.test.js; this checks that a key runs the same code path as the click and that the guards hold in the real DOM.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

const SCREENS = [
  { name: "one", tags: [], notes: "" },
  { name: "two", tags: [], notes: "" },
];

const memoryStorage = new Map();
const storageStub = {
  getItem: (k) => memoryStorage.get(k) ?? null,
  setItem: (k, v) => void memoryStorage.set(k, String(v)),
  removeItem: (k) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
};

function stubDaemon() {
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url) => {
    const path = String(url).split("?")[0];
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens: SCREENS });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [] });
    if (path === "/api/tools/get_screen") return json({ nodes: [] });
    if (path === "/api/fs/dirs") return json({ path: "/home/u", parent: "/home", home: "/home/u", entries: [] });
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<div id="root" style="width:390px;height:844px"></div>` };
    return json({ entries: [], dirs: [] });
  });
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);
const pressed = (id) => document.getElementById(id).getAttribute("aria-pressed");

/** Dispatches a keydown on `target` and returns whether it was left un-prevented. */
function key(k, init = {}, target = document.body) {
  const evt = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(evt);
  return !evt.defaultPrevented;
}
const shift = (k, code) => key(k, { shiftKey: true, code });

async function boot() {
  memoryStorage.set("artisign.last-screen:/p", "one");
  await import("./app.js");
  await flush();
}

// app.js registers document-level listeners on import; drop them between tests so a previous boot's handlers do not also react.
let documentListeners = [];
const nativeAddEventListener = document.addEventListener.bind(document);

beforeEach(() => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  documentListeners = [];
  document.addEventListener = (type, fn, opts) => {
    documentListeners.push([type, fn, opts]);
    nativeAddEventListener(type, fn, opts);
  };
  stubDaemon();
});
afterEach(() => {
  for (const [type, fn, opts] of documentListeners) document.removeEventListener(type, fn, opts);
  document.addEventListener = nativeAddEventListener;
  vi.unstubAllGlobals();
});

describe("hints", () => {
  it("fills the tooltip key slots and the menu hints from the mapping (non-mac strings)", async () => {
    await boot();
    expect($("#flow-mode-toggle").dataset.shortcut).toBe("F");
    expect($("#theme-toggle").dataset.shortcut).toBe("T");
    expect($("#sidebar-context-collapse").dataset.shortcut).toBe("\\");
    expect($("#follow-toggle-toggle").dataset.shortcut).toBe("W");
    expect($('.zoom-button[data-zoom="fit"] .chrome-menu-hint').textContent).toBe("Shift+1");
    expect($('.zoom-step-button[data-zoom-step="out"] .chrome-menu-hint').textContent).toBe("−");
    expect($("#menu-action-open .chrome-menu-hint").textContent).toBe("O");
    expect($("#menu-label-open .chrome-menu-hint").textContent).toBe("P");
  });
});

describe("modes", () => {
  it("F / C / I switch modes exclusively, the same key leaves, Esc leaves the active mode", async () => {
    await boot();
    key("f");
    expect(pressed("flow-mode-toggle")).toBe("true");
    key("c");
    expect([pressed("flow-mode-toggle"), pressed("comment-mode-toggle")]).toEqual(["false", "true"]);
    expect($("#sidebar-context").dataset.collapsed).toBe("false"); // CHR-888: comment mode opens Context
    key("i");
    expect([pressed("comment-mode-toggle"), pressed("inspect-mode-toggle")]).toEqual(["false", "true"]);
    expect($("#inspector").dataset.collapsed).toBe("false"); // inspect opens Elements
    key("Escape");
    expect(pressed("inspect-mode-toggle")).toBe("false");
    key("f");
    key("f");
    expect(pressed("flow-mode-toggle")).toBe("false");
  });

  it("S toggles the status bar, W the follow toggle", async () => {
    await boot();
    key("s");
    expect(pressed("status-bar-toggle")).toBe("true");
    key("w");
    expect($("#follow-toggle").dataset.state).toBe("following");
    key("r"); // not paused: nothing to resume
    expect($("#follow-toggle").dataset.state).toBe("following");
    key("w");
    expect($("#follow-toggle").dataset.state).toBe("off");
  });
});

describe("guards", () => {
  it("does nothing while typing in a field, but the field keeps the key", async () => {
    await boot();
    const filter = $("#screen-filter-input");
    filter.focus();
    key("f", {}, filter);
    key("Escape", {}, filter);
    expect(pressed("flow-mode-toggle")).toBe("false");
  });

  it("does nothing with Ctrl, Cmd or Alt held", async () => {
    await boot();
    key("f", { ctrlKey: true });
    key("f", { metaKey: true });
    key("f", { altKey: true });
    expect(pressed("flow-mode-toggle")).toBe("false");
    expect(key("o", { metaKey: true })).toBe(true); // left to the browser
  });

  it("does nothing during IME composition", async () => {
    await boot();
    key("f", { isComposing: true });
    key("f", { keyCode: 229 });
    expect(pressed("flow-mode-toggle")).toBe("false");
  });

  it("does nothing while a dialog is open, except its own keys", async () => {
    await boot();
    $("#dialog-scrim").hidden = false;
    $("#open-project-dialog").hidden = false;
    key("f");
    key("3");
    expect(pressed("flow-mode-toggle")).toBe("false");
    expect($('[data-view="board"]').getAttribute("aria-pressed")).toBe("false");
  });

  it("while the zoom menu is open only the zoom keys act", async () => {
    await boot();
    $("#zoom-trigger").click();
    key("f");
    expect(pressed("flow-mode-toggle")).toBe("false");
    shift("%", "Digit5");
    expect($("#zoom-label").textContent).toBe("50%");
  });
});

describe("views, panels, filter, theme", () => {
  it("1 / 2 / 3 switch the view like the tabs", async () => {
    await boot();
    key("3");
    expect($('[data-view="board"]').getAttribute("aria-pressed")).toBe("true");
    expect($("#board-view").hidden).toBe(false);
    key("2");
    expect($('[data-view="design-system"]').getAttribute("aria-pressed")).toBe("true");
    key("1");
    expect($('[data-view="screens"]').getAttribute("aria-pressed")).toBe("true");
  });

  it("[ \\ ] toggle the three panels (and persist like the buttons)", async () => {
    await boot();
    key("[");
    expect($("#sidebar-screens").dataset.collapsed).toBe("true");
    expect(memoryStorage.get("artisign.sidebar-screens.collapsed")).toBe("true");
    key("\\");
    expect($("#sidebar-context").dataset.collapsed).toBe("false");
    key("]");
    expect($("#inspector").dataset.collapsed).toBe("false");
  });

  it("/ focuses the screen filter (opening a collapsed Screens panel) without typing the slash", async () => {
    memoryStorage.set("artisign.sidebar-screens.collapsed", "true");
    await boot();
    const notPrevented = key("/");
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe($("#screen-filter-input"));
    expect($("#sidebar-screens").dataset.collapsed).toBe("false");
  });

  it("T cycles System → Light → Dark", async () => {
    await boot();
    expect($("#theme-toggle").getAttribute("aria-label")).toBe("Theme: System");
    key("t");
    expect($("#theme-toggle").getAttribute("aria-label")).toBe("Theme: Light");
    key("t");
    expect($("#theme-toggle").getAttribute("aria-label")).toBe("Theme: Dark");
  });
});

describe("zoom", () => {
  it("Screens: Shift+digits pick the presets, + / - step along them", async () => {
    await boot();
    expect($("#zoom-label").textContent).toBe("Fit");
    shift("%", "Digit5");
    expect($("#zoom-label").textContent).toBe("50%");
    key("+", { shiftKey: true });
    expect($("#zoom-label").textContent).toBe("100%");
    key("=");
    expect($("#zoom-label").textContent).toBe("200%");
    key("+", { shiftKey: true }); // already the largest
    expect($("#zoom-label").textContent).toBe("200%");
    key("-");
    expect($("#zoom-label").textContent).toBe("100%");
    shift("!", "Digit1");
    expect($("#zoom-label").textContent).toBe("Fit");
    shift(")", "Digit0");
    expect($("#zoom-label").textContent).toBe("100%");
    shift("@", "Digit2");
    expect($("#zoom-label").textContent).toBe("200%");
  });

  it("is a no-op where there is no zoom control (Design System)", async () => {
    await boot();
    key("2");
    shift("%", "Digit5");
    key("1");
    expect($("#zoom-label").textContent).toBe("Fit");
  });

  it("Board: E / G toggle edges and clusters, +/- drive the slider, Shift+1 is Fit all", async () => {
    await boot();
    key("3");
    await flush();
    expect(pressed("board-edges-toggle")).toBe("true");
    key("e");
    expect(pressed("board-edges-toggle")).toBe("false");
    expect(pressed("board-clusters-toggle")).toBe("true");
    key("g");
    expect(pressed("board-clusters-toggle")).toBe("false");
    const before = Number($("#board-zoom-range").value);
    key("-");
    expect(Number($("#board-zoom-range").value)).toBeLessThan(before);
    shift("!", "Digit1");
    expect($("#board-fitall-btn")).not.toBeNull();
    // Board keys do nothing in Screens.
    key("1");
    key("e");
    expect(pressed("board-edges-toggle")).toBe("false");
  });
});

describe("project menu", () => {
  it("P opens the menu, O / N are its own keys, Esc closes it", async () => {
    await boot();
    key("p");
    expect($("#project-menu").hidden).toBe(false);
    key("f"); // not a menu key
    expect(pressed("flow-mode-toggle")).toBe("false");
    key("Escape");
    expect($("#project-menu").hidden).toBe(true);
    key("o"); // outside the menu O is nothing
    expect($("#dialog-scrim").hidden).toBe(true);
    key("p");
    key("n");
    expect($("#project-menu").hidden).toBe(true);
    expect($("#dialog-scrim").hidden).toBe(false);
    expect($("#init-project-dialog").hidden).toBe(false);
  });
});

describe("reference dialog", () => {
  it("? opens the list built from the mapping, ? or Esc closes it, and no other key acts meanwhile", async () => {
    await boot();
    expect($("#shortcuts-scrim").hidden).toBe(true);
    key("?", { shiftKey: true });
    expect($("#shortcuts-scrim").hidden).toBe(false);
    const rows = [...document.querySelectorAll("#shortcuts-dialog .shortcuts-row")].map((r) => [r.firstChild.textContent, r.lastChild.textContent]);
    expect(rows).toContainEqual(["Flow mode", "F"]);
    expect(rows).toContainEqual(["Fit", "Shift+1"]);
    expect(rows).toContainEqual(["Collapse all", "Shift+G"]);
    expect(rows).toContainEqual(["Close, leave mode", "Esc"]);
    key("f");
    expect(pressed("flow-mode-toggle")).toBe("false");
    key("Escape");
    expect($("#shortcuts-scrim").hidden).toBe(true);
    key("?", { shiftKey: true });
    key("?", { shiftKey: true });
    expect($("#shortcuts-scrim").hidden).toBe(true);
  });
});
