// @vitest-environment jsdom
//
// CHR-920 end to end through app.js: the project menu as an ARIA menu with arrow keys and focus return, the dialogs' markup and focus round trip, the shortcut reference's focus trap.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

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
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "alpha" }, { root: "/q", name: "beta" }], recent: ["/r/gamma"] });
    if (path === "/api/projects/open") return json({ active: "/r/gamma", open: [{ root: "/r/gamma", name: "gamma" }], recent: [] });
    if (path === "/api/screens") return json({ screens: [{ name: "one", tags: [], notes: "" }] });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [] });
    if (path === "/api/fs/dirs") return json({ path: "/home/u", parent: null, home: "/home/u", entries: [] });
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<div id="root"></div>` };
    return json({});
  });
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);
const keydown = (target, key, init = {}) => {
  const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(evt);
  return evt;
};

let documentListeners = [];
const nativeAddEventListener = document.addEventListener.bind(document);

beforeEach(async () => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  documentListeners = [];
  document.addEventListener = (type, fn, opts) => {
    documentListeners.push([type, fn, opts]);
    nativeAddEventListener(type, fn, opts);
  };
  stubDaemon();
  await import("./app.js");
  await flush();
});
afterEach(() => {
  for (const [type, fn, opts] of documentListeners) document.removeEventListener(type, fn, opts);
  document.addEventListener = nativeAddEventListener;
  vi.unstubAllGlobals();
});

describe("project menu", () => {
  const rows = () => [...document.querySelectorAll("#project-menu button.chrome-menu-item")];

  it("is an ARIA menu: roles, the current project checked, opening focuses the first actionable row", () => {
    const trigger = $("#project-picker-trigger");
    expect($("#project-menu").getAttribute("role")).toBe("menu");
    trigger.focus();
    trigger.click();
    expect($("#project-menu").hidden).toBe(false);
    expect(rows().map((r) => r.title || r.id)).toEqual(["/p", "/q", "/r/gamma", "menu-action-open", "menu-action-init"]);
    expect(document.activeElement).toBe(rows()[0]);
    const current = $("#project-menu [aria-current]");
    expect(current).toBe(rows()[0]); // the current project is a row like the others
    expect([current.getAttribute("role"), current.getAttribute("aria-checked")]).toEqual(["menuitemradio", "true"]);
    expect(rows()[1].getAttribute("role")).toBe("menuitemradio");
    expect(rows()[1].getAttribute("aria-checked")).toBe("false");
    expect($("#menu-action-open").getAttribute("role")).toBe("menuitem");
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    // The shortcut hint in the group label is decoration.
    expect($("#menu-label-open .chrome-menu-hint").getAttribute("aria-hidden")).toBe("true");
  });

  it("↑/↓/Home/End move through the rows, Escape closes and returns focus to the trigger", () => {
    const trigger = $("#project-picker-trigger");
    trigger.click();
    keydown(document.activeElement, "ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
    keydown(document.activeElement, "End");
    expect(document.activeElement).toBe(rows()[4]);
    keydown(document.activeElement, "ArrowDown");
    expect(document.activeElement).toBe(rows()[0]);
    keydown(document.activeElement, "ArrowUp");
    expect(document.activeElement).toBe(rows()[4]);
    keydown(document.activeElement, "Home");
    expect(document.activeElement).toBe(rows()[0]);
    keydown(document.activeElement, "Escape");
    expect($("#project-menu").hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("tabbing out of the menu closes it without pulling focus back", () => {
    $("#project-picker-trigger").click();
    const outside = $("#flow-mode-toggle");
    // A pointer press or a programmatic focus move elsewhere is not a tab-out ...
    outside.focus();
    $("#project-menu").dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
    expect($("#project-menu").hidden).toBe(false);
    // ... a keyboard Tab is.
    const row = document.querySelector("#project-menu button.chrome-menu-item");
    row.focus();
    keydown(row, "Tab");
    outside.focus();
    expect($("#project-menu").hidden).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  it("mouse behaviour is unchanged: clicking Open project... opens the dialog", () => {
    $("#project-picker-trigger").click();
    $("#menu-action-open").click();
    expect($("#project-menu").hidden).toBe(true);
    expect($("#dialog-scrim").hidden).toBe(false);
  });
});

describe("zoom menu", () => {
  const rows = () => [...document.querySelectorAll("#zoom-menu button")];

  it("is an ARIA menu: opening focuses the current level, arrows move, Escape and a keyboard Tab close it", () => {
    const trigger = $("#zoom-trigger");
    expect($("#zoom-menu").getAttribute("role")).toBe("menu");
    trigger.focus();
    trigger.click();
    expect(rows().map((r) => r.getAttribute("role"))).toEqual(["menuitemradio", "menuitemradio", "menuitemradio", "menuitemradio", "menuitem", "menuitem"]);
    expect(rows().map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false", null, null]);
    expect(document.activeElement).toBe(rows()[0]); // Fit is the current level
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    keydown(document.activeElement, "ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
    keydown(document.activeElement, "End");
    expect(document.activeElement).toBe(rows()[5]);
    keydown(document.activeElement, "Escape");
    expect($("#zoom-menu").hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    trigger.click();
    const outside = $("#flow-mode-toggle");
    keydown(document.activeElement, "Tab");
    outside.focus();
    expect($("#zoom-menu").hidden).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  it("picking a level checks it and the next open starts on it", () => {
    $("#zoom-trigger").click();
    rows()[2].click();
    expect($("#zoom-menu").hidden).toBe(true);
    expect(rows()[2].getAttribute("aria-checked")).toBe("true");
    $("#zoom-trigger").click();
    expect(document.activeElement).toBe(rows()[2]);
  });
});

describe("choosing a project row", () => {
  const rows = () => [...document.querySelectorAll("#project-menu button.chrome-menu-item")];

  it.each([
    ["an open project", 1],
    ["a recent project", 2],
    ["the current project", 0],
  ])("%s closes the menu and focuses the trigger", async (_name, index) => {
    const trigger = $("#project-picker-trigger");
    trigger.click();
    rows()[index].focus();
    rows()[index].click();
    expect($("#project-menu").hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    await flush(); // let the switch / open request finish inside the stubs
  });
});

describe("project dialogs", () => {
  it("are modal dialogs with a name; the focus round trip starts and ends on the trigger", async () => {
    for (const id of ["open-project-dialog", "init-project-dialog"]) {
      const dialog = document.getElementById(id);
      expect(dialog.getAttribute("role")).toBe("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(document.getElementById(dialog.getAttribute("aria-labelledby")).textContent).toMatch(/project/i);
    }
    const trigger = $("#project-picker-trigger");
    trigger.focus();
    trigger.click();
    $("#menu-action-open").click(); // the menu closes and hands focus to the trigger, the dialog remembers it
    await flush();
    expect(document.activeElement).toBe($("#open-project-dialog .quick-chip"));
    keydown(document.activeElement, "Escape");
    expect($("#dialog-scrim").hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    trigger.click();
    $("#menu-action-init").click();
    await flush();
    expect(document.activeElement).toBe($("#init-name-input"));
    $("#init-project-dialog .btn-cancel").click();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("shortcut reference", () => {
  it("is a modal dialog whose Tab stays inside", () => {
    const flow = $("#flow-mode-toggle");
    flow.focus();
    keydown(document.body, "?", { shiftKey: true });
    const dialog = $("#shortcuts-dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);
    const close = $("#shortcuts-close");
    close.focus(); // where the browser's own Tab takes focus from the dialog
    const tab = keydown(close, "Tab"); // the close button is the only control: Tab wraps onto itself
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    expect(keydown(close, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    keydown(close, "Escape");
    expect($("#shortcuts-scrim").hidden).toBe(true);
    expect(document.activeElement).toBe(flow);
  });
});
