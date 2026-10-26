// @vitest-environment jsdom
//
// CHR-916 — the keyboard shortcuts wired in app.js end to end: the real index.html body, the real modules, a stubbed daemon. The mapping and the guards are unit-tested in shortcuts.test.js; this checks that a key runs the same code path as the click and that the guards hold in the real DOM.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";
import { fakeSettings } from "./fake-settings.test-helper.js";

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
  get length() { return memoryStorage.size; },
  key: (i) => [...memoryStorage.keys()][i] ?? null,
  clear: () => memoryStorage.clear(),
};

let settings;

function stubDaemon() {
  settings = fakeSettings();
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url, init) => {
    const path = String(url).split("?")[0];
    const settingsRes = settings.handle(path, init);
    if (settingsRes) return settingsRes;
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens: SCREENS });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [] });
    if (path === "/api/tools/get_screen") return json({ nodes: [{ id: "root", tag: "div" }, { id: "child", tag: "div" }] });
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
    await flush();
    expect(settings.prefs["artisign.sidebar-screens.collapsed"]).toBe("true");
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

  it("T cycles System → Light → Dark (the settings menu's theme control, CHR-926)", async () => {
    await boot();
    const checked = () => $('.settings-seg-button[aria-checked="true"]')?.dataset.themePref;
    $("#settings-trigger").click();
    expect(checked()).toBe("system");
    $("#settings-trigger").click(); // close: while a menu is open only its own keys act
    key("t");
    await flush();
    expect(settings.prefs["artisign.theme"]).toBe("light");
    key("t");
    await flush();
    expect(settings.prefs["artisign.theme"]).toBe("dark");
    $("#settings-trigger").click();
    expect(checked()).toBe("dark");
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
    const fitAll = vi.fn();
    const hundred = vi.fn();
    $("#board-fitall-btn").addEventListener("click", fitAll);
    $("#board-100-btn").addEventListener("click", hundred);
    shift("!", "Digit1");
    expect(fitAll).toHaveBeenCalledTimes(1);
    shift(")", "Digit0");
    expect(hundred).toHaveBeenCalledTimes(1);
    // Board keys do nothing in Screens.
    key("1");
    shift("!", "Digit1"); // in Screens that is the zoom preset, not Fit all
    expect(fitAll).toHaveBeenCalledTimes(1);
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

describe("Escape consumed by an overlay does not also leave the mode", () => {
  it("closing the project menu keeps the active mode", async () => {
    await boot();
    key("f");
    key("p");
    expect($("#project-menu").hidden).toBe(false);
    key("Escape");
    expect($("#project-menu").hidden).toBe(true);
    expect(pressed("flow-mode-toggle")).toBe("true");
    key("Escape"); // nothing open any more: this one leaves
    expect(pressed("flow-mode-toggle")).toBe("false");
  });

  it("closing a project dialog keeps the active mode", async () => {
    await boot();
    key("c");
    key("p");
    key("o");
    expect($("#dialog-scrim").hidden).toBe(false);
    key("Escape");
    expect($("#dialog-scrim").hidden).toBe(true);
    expect(pressed("comment-mode-toggle")).toBe("true");
  });

  it("a visible tooltip does not consume Escape: it hides and the same Escape leaves the mode", async () => {
    await boot();
    $("#flow-mode-toggle").click();
    // Chrome focuses a clicked toggle, so its tooltip is up while the mode is on.
    $("#flow-mode-toggle").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect($("#chrome-tooltip").hidden).toBe(false);
    key("Escape");
    expect($("#chrome-tooltip").hidden).toBe(true);
    expect(pressed("flow-mode-toggle")).toBe("false");
  });

  it("closing the zoom menu keeps the active mode", async () => {
    await boot();
    key("i");
    $("#zoom-trigger").click();
    key("Escape");
    expect($("#zoom-menu").hidden).toBe(true);
    expect(pressed("inspect-mode-toggle")).toBe("true");
  });
});

/** The screen frame's document with an element to click, as after a render (jsdom does not load srcdoc itself). */
function frameDoc() {
  const doc = $("#screen-frame").contentDocument;
  doc.body.innerHTML = '<div id="root" style="width:390px"><div id="child">child</div><input id="field"></div>';
  $("#screen-frame").dispatchEvent(new Event("load"));
  return doc;
}
function frameKey(doc, k, init = {}, target = doc.body) {
  const evt = new doc.defaultView.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(evt);
  return evt;
}

describe("keys pressed inside the screen frame", () => {
  it("run the same shortcuts, but not while typing in a field of the screen", async () => {
    await boot();
    const doc = frameDoc();
    frameKey(doc, "f");
    expect(pressed("flow-mode-toggle")).toBe("true");
    frameKey(doc, "f", {}, doc.getElementById("field"));
    expect(pressed("flow-mode-toggle")).toBe("true"); // typing guard on the frame's own target
    frameKey(doc, "f", { ctrlKey: true });
    expect(pressed("flow-mode-toggle")).toBe("true");
    frameKey(doc, "f");
    expect(pressed("flow-mode-toggle")).toBe("false");
  });

  it("inspect's own Escape (deselect) has priority; a second Escape leaves the mode", async () => {
    await boot();
    const doc = frameDoc();
    await flush(); // entries
    key("i");
    doc.getElementById("child").click();
    expect($(".inspector-entry-focused")).not.toBeNull();
    frameKey(doc, "Escape");
    expect($(".inspector-entry-focused")).toBeNull();
    expect(pressed("inspect-mode-toggle")).toBe("true");
    frameKey(doc, "Escape");
    expect(pressed("inspect-mode-toggle")).toBe("false");
  });
});

describe("Escape in a text field", () => {
  it("clears inspect's focused element but does not leave the mode", async () => {
    await boot();
    const doc = frameDoc();
    await flush();
    key("i");
    doc.getElementById("child").click();
    expect($(".inspector-entry-focused")).not.toBeNull();
    const filter = $("#screen-filter-input");
    filter.focus();
    key("Escape", {}, filter);
    expect($(".inspector-entry-focused")).toBeNull();
    expect(pressed("inspect-mode-toggle")).toBe("true");
  });

  it("does nothing to comment mode or the compose form", async () => {
    await boot();
    frameDoc();
    key("c");
    $("#comment-add").click();
    const input = $("#comment-body-input");
    input.focus();
    key("Escape", {}, input);
    expect(pressed("comment-mode-toggle")).toBe("true");
    expect($("#comment-compose").hidden).toBe(false);
  });
});

describe("zoom steps", () => {
  it("step from the effective Fit scale and never zoom the wrong way", async () => {
    await boot();
    const holder = $("#screen-holder");
    holder.style.setProperty("--zoom", "0.35");
    key("-");
    expect($("#zoom-label").textContent).toBe("Fit"); // already below 50%: out does nothing
    key("+", { shiftKey: true });
    expect($("#zoom-label").textContent).toBe("50%");
    shift("!", "Digit1");
    holder.style.setProperty("--zoom", "0.8");
    key("-");
    expect($("#zoom-label").textContent).toBe("50%");
    shift("!", "Digit1");
    holder.style.setProperty("--zoom", "0.8");
    $('.zoom-step-button[data-zoom-step="in"]').click(); // the menu item takes the same path
    expect($("#zoom-label").textContent).toBe("100%");
  });

  it("a preset key does not move keyboard focus", async () => {
    await boot();
    const flow = $("#flow-mode-toggle");
    flow.focus();
    shift("%", "Digit5");
    expect($("#zoom-label").textContent).toBe("50%");
    await flush();
    expect(settings.prefs["artisign.zoom"]).toBe("0.5");
    expect(document.activeElement).toBe(flow);
  });
});

describe("reference dialog focus", () => {
  it("opens without focusing the close button (no tooltip pops up)", async () => {
    await boot();
    key("?", { shiftKey: true });
    expect(document.activeElement).toBe($("#shortcuts-dialog"));
    expect($("#chrome-tooltip").hidden).toBe(true);
    key("Escape");
  });
});

describe("zoom preset keys and the zoom menu", () => {
  it("close an open zoom menu like the button click (focus to the trigger), but leave focus alone when it was closed", async () => {
    await boot();
    $("#zoom-trigger").click();
    expect($("#zoom-menu").hidden).toBe(false);
    shift("@", "Digit2");
    expect($("#zoom-label").textContent).toBe("200%");
    expect($("#zoom-menu").hidden).toBe(true);
    expect(document.activeElement).toBe($("#zoom-trigger"));
    const flow = $("#flow-mode-toggle");
    flow.focus();
    shift("%", "Digit5");
    expect(document.activeElement).toBe(flow);
  });
});

describe("IME in a text field", () => {
  it("Escape during composition does not clear inspect's focused element", async () => {
    await boot();
    const doc = frameDoc();
    await flush();
    key("i");
    doc.getElementById("child").click();
    const filter = $("#screen-filter-input");
    filter.focus();
    key("Escape", { isComposing: true }, filter);
    key("Escape", { keyCode: 229 }, filter);
    expect($(".inspector-entry-focused")).not.toBeNull();
    key("Escape", {}, filter);
    expect($(".inspector-entry-focused")).toBeNull();
  });
});

describe("a top-document overlay and the screen frame", () => {
  it("a click inside the frame closes an open project menu and zoom menu like an outside click", async () => {
    await boot();
    const doc = frameDoc();
    key("p");
    expect($("#project-menu").hidden).toBe(false);
    doc.getElementById("child").dispatchEvent(new doc.defaultView.Event("pointerdown", { bubbles: true }));
    doc.getElementById("child").click();
    expect($("#project-menu").hidden).toBe(true);
    $("#zoom-trigger").click();
    expect($("#zoom-menu").hidden).toBe(false);
    doc.getElementById("child").dispatchEvent(new doc.defaultView.Event("pointerdown", { bubbles: true }));
    expect($("#zoom-menu").hidden).toBe(true);
  });

  it("Escape from the frame closes the open overlay and nothing else", async () => {
    await boot();
    const doc = frameDoc();
    key("f");
    key("p");
    frameKey(doc, "Escape");
    expect($("#project-menu").hidden).toBe(true);
    expect(pressed("flow-mode-toggle")).toBe("true");
    $("#zoom-trigger").click();
    frameKey(doc, "Escape");
    expect($("#zoom-menu").hidden).toBe(true);
    expect(pressed("flow-mode-toggle")).toBe("true");
    frameKey(doc, "Escape"); // nothing open: leaves the mode
    expect(pressed("flow-mode-toggle")).toBe("false");
  });

  it("O / N from the frame still act while the project menu is open (the menu's own keys)", async () => {
    await boot();
    const doc = frameDoc();
    key("p");
    frameKey(doc, "n");
    expect($("#project-menu").hidden).toBe(true);
    expect($("#dialog-scrim").hidden).toBe(false);
  });
});
