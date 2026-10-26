// @vitest-environment jsdom
//
// CHR-912 — the topbar and canvas bar wired in app.js: icon mode toggles with tooltips, the zoom dropdown, the Live chip, the variant-map toggle and the frame caption.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";
import { fakeSettings } from "./fake-settings.test-helper.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cwd } from "node:process";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

const GLYPH_ICON = /[\u{1F300}-\u{1FAFF}☀-➿＋▸▾⌂›⤴]/u;

const memoryStorage = new Map();
const storageStub = {
  getItem: (k) => memoryStorage.get(k) ?? null,
  setItem: (k, v) => void memoryStorage.set(k, String(v)),
  removeItem: (k) => void memoryStorage.delete(k),
  get length() { return memoryStorage.size; },
  key: (i) => [...memoryStorage.keys()][i] ?? null,
  clear: () => memoryStorage.clear(),
};

const SCREENS = [
  { name: "family", tags: [] },
  { name: "family-leave", tags: [], variant_of: "family", variant_kind: "overlay" },
];

let sources;
let renderOk;

let settings;

function stubDaemon() {
  settings = fakeSettings();
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  sources = [];
  vi.stubGlobal("EventSource", class { constructor() { sources.push(this); } close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url, init) => {
    const path = String(url).split("?")[0];
    const settingsRes = settings.handle(path, init);
    if (settingsRes) return settingsRes;
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "<div style='width:390px;height:844px'></div>" });
    if (path.startsWith("/api/render/")) {
      return { ok: renderOk, status: renderOk ? 200 : 500, json: async () => ({ message: "boom" }), text: async () => "<div style='width:390px;height:844px'></div>" };
    }
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens: SCREENS });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [] });
    return json({});
  });
}

const flush = async () => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);

async function boot() {
  await import("./app.js");
  await flush();
}

beforeEach(() => {
  memoryStorage.clear();
  renderOk = true;
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  stubDaemon();
});
afterEach(() => vi.unstubAllGlobals());

describe("topbar markup", () => {
  it("has no glyph icons and an accessible name plus tooltip on every icon toggle", async () => {
    await boot();
    expect($("#topbar").textContent.replaceAll(/[a-z_]+(?=\b)/g, "")).not.toMatch(GLYPH_ICON);
    for (const [id, label, icon, key] of [
      ["flow-mode-toggle", "Flow mode", "route", "F"],
      ["comment-mode-toggle", "Comment mode", "chat_bubble", "C"],
      ["inspect-mode-toggle", "Inspect mode", "frame_inspect", "I"],
      ["status-bar-toggle", "Status bar", "smartphone", "S"],
    ]) {
      const btn = document.getElementById(id);
      expect(btn.getAttribute("aria-label")).toBe(label);
      expect(btn.dataset.tooltip).toBe(label);
      expect(btn.querySelector(".icon").textContent).toBe(icon);
      expect(btn.dataset.shortcut).toBe(key); // filled from the shortcut mapping (CHR-916)
    }
  });
});

describe("zoom dropdown", () => {
  it("shows the current preset, selects another one, closes and persists", async () => {
    await boot();
    expect($("#zoom-label").textContent).toBe("Fit");
    expect($("#zoom-menu").hidden).toBe(true);
    $("#zoom-trigger").click();
    expect($("#zoom-menu").hidden).toBe(false);
    expect($("#zoom-trigger").getAttribute("aria-expanded")).toBe("true");
    $('.zoom-button[data-zoom="2"]').click();
    expect($("#zoom-menu").hidden).toBe(true);
    expect($("#zoom-label").textContent).toBe("200%");
    await flush();
    expect(settings.prefs["artisign.zoom"]).toBe("2");
    expect($('.zoom-button[data-zoom="2"]').getAttribute("aria-checked")).toBe("true");
    expect($('.zoom-button[data-zoom="2"] .chrome-menu-check').textContent).toBe("check");
    expect($('.zoom-button[data-zoom="fit"] .chrome-menu-check').textContent).toBe("");
  });

  it("restores the stored preset and closes on Escape", async () => {
    memoryStorage.set("artisign.zoom", "0.5");
    await boot();
    expect($("#zoom-label").textContent).toBe("50%");
    $("#zoom-trigger").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($("#zoom-menu").hidden).toBe(true);
  });
});

describe("Live chip", () => {
  it("reads Live when connected and Offline with the retry tooltip when the stream drops", async () => {
    await boot();
    const source = sources.at(-1);
    source.onopen();
    expect($("#connection-status-label").textContent).toBe("Live");
    expect($("#connection-status").dataset.tooltip).toBe("Live reload: connected");
    source.onerror();
    expect($("#connection-status-label").textContent).toBe("Offline");
    expect($("#connection-status").classList.contains("disconnected")).toBe(true);
    expect($("#connection-status").dataset.tooltip).toBe("Live reload disconnected, retrying");
    source.onopen();
    expect($("#connection-status-label").textContent).toBe("Live");
    expect($("#connection-status").classList.contains("disconnected")).toBe(false);
  });
});

describe("variant map toggle", () => {
  it("is shown on a variant screen, defaults to a visible map and persists the choice", async () => {
    memoryStorage.set("artisign.lastSelection", JSON.stringify({ screen: "family-leave" }));
    await boot();
    const toggle = $("#variant-bar .variant-map-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-label")).toBe("Variant map");
    expect(toggle.dataset.tooltip).toBe("Variant map");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect($("#variant-map").hidden).toBe(false);
    toggle.click();
    expect($("#variant-map").hidden).toBe(true);
    expect($("#variant-bar .variant-map-toggle").getAttribute("aria-pressed")).toBe("false");
    await flush();
    expect(settings.prefs["artisign.variantMap"]).toBe("false");
    $("#variant-bar .variant-map-toggle").click();
    expect($("#variant-map").hidden).toBe(false);
    await flush();
    expect(settings.prefs["artisign.variantMap"]).toBe("true");
  });

  it("starts hidden when the stored pref says so", async () => {
    memoryStorage.set("artisign.variantMap", "false");
    memoryStorage.set("artisign.lastSelection", JSON.stringify({ screen: "family-leave" }));
    await boot();
    expect($("#variant-map").hidden).toBe(true);
  });
});

describe("mockup column header", () => {
  it("counter-scales against the row zoom so it keeps its native size", () => {
    const css = readFileSync(resolve(cwd(), "src/preview/style.css"), "utf8");
    const rule = /\.mockup-column-head\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("width: calc(100% * var(--zoom, 1))");
    expect(rule).toContain("transform: scale(calc(1 / var(--zoom, 1)))");
  });
});

describe("frame caption", () => {
  it("names the rendered screen and its size once the frame has loaded", async () => {
    await boot();
    expect($("#frame-caption").hidden).toBe(true); // nothing has rendered yet
    $("#screen-frame").dispatchEvent(new Event("load")); // jsdom does not run srcdoc documents
    expect($("#frame-caption").hidden).toBe(false);
    expect($("#frame-caption").textContent).toBe("family \u00B7 390 \u00D7 844");
  });

  it("stays hidden when the render failed", async () => {
    renderOk = false;
    await boot();
    $("#screen-frame").dispatchEvent(new Event("load"));
    expect($("#frame-caption").hidden).toBe(true);
  });
});

describe("zoom menu vs the other floating things", () => {
  it("Escape closes only the zoom menu: inspect mode's own Escape does not also fire", async () => {
    await boot();
    const inspect = $("#inspect-mode-toggle");
    inspect.disabled = false;
    inspect.click();
    expect(inspect.getAttribute("aria-pressed")).toBe("true");
    $("#zoom-trigger").click();
    const reachedBubble = vi.fn();
    document.addEventListener("keydown", reachedBubble);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.removeEventListener("keydown", reachedBubble);
    expect($("#zoom-menu").hidden).toBe(true);
    expect(reachedBubble).not.toHaveBeenCalled();
    expect(inspect.getAttribute("aria-pressed")).toBe("true");
  });

  it("opening the zoom menu closes the project menu, and the project menu's trigger closes the zoom menu", async () => {
    await boot();
    $("#project-picker-trigger").click();
    expect($("#project-menu").hidden).toBe(false);
    $("#zoom-trigger").click();
    expect($("#project-menu").hidden).toBe(true);
    expect($("#zoom-menu").hidden).toBe(false);
    // The project trigger stops click propagation, so only a pointerdown capture hears it.
    $("#project-picker-trigger").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect($("#zoom-menu").hidden).toBe(true);
  });
});

describe("topbar dividers", () => {
  const visibleKinds = () =>
    [...$("#topbar").children]
      .filter((el) => !el.closest("[hidden]") && !el.hidden && !el.classList.contains("topbar-spacer"))
      .flatMap((el) => (el.id === "canvas-controls" ? [...el.children].filter((c) => !c.hidden) : [el]))
      .map((el) => (el.classList.contains("chrome-divider-v") ? "|" : "x"));

  it("has the approved dividers per view and never one at an edge or two side by side", async () => {
    await boot();
    // title picker | tabs | follow flow comment inspect [| zoom status] | theme live
    const expected = {
      screens: "xx|x|xxxx|xx|xx",
      "design-system": "xx|x|xxxx|xx",
      board: "xx|x|xxxx|xx",
    };
    for (const view of ["screens", "design-system", "board"]) {
      $(`.view-tab[data-view="${view}"]`).click();
      await flush();
      const kinds = visibleKinds().join("");
      expect(kinds, view).toBe(expected[view]);
      expect(kinds, view).not.toMatch(/\|\||^\||\|$/);
    }
  });
});

describe("daemon-stored preferences (CHR-924)", () => {
  it("carries this browser's localStorage prefs over once and applies them", async () => {
    memoryStorage.set("artisign.zoom", "0.5");
    memoryStorage.set("uxd.variantMap", "false");
    await boot();
    expect(settings.imports).toEqual([{ "artisign.zoom": "0.5", "artisign.variantMap": "false" }]);
    expect(settings.migrated).toBe(true);
    expect($("#zoom-label").textContent).toBe("50%");
    expect(memoryStorage.get("artisign.zoom")).toBe("0.5"); // localStorage is left alone
  });

  it("does not import once the daemon settings are migrated, and the daemon value wins", async () => {
    settings = fakeSettings({ prefs: { "artisign.zoom": "2" }, migrated: true });
    memoryStorage.set("artisign.zoom", "0.5");
    await boot();
    expect(settings.imports).toEqual([]);
    expect($("#zoom-label").textContent).toBe("200%");
  });

  it("sends a pref written through a UI control to the daemon", async () => {
    await boot();
    settings.saves.length = 0;
    $("#zoom-trigger").click();
    $('.zoom-button[data-zoom="2"]').click();
    await flush();
    expect(settings.saves.some((c) => c["artisign.zoom"] === "2")).toBe(true);
  });

  it("keeps the theme in localStorage as a pre-paint mirror of the daemon value", async () => {
    settings = fakeSettings({ prefs: { "artisign.theme": "dark" }, migrated: true });
    await boot();
    expect(memoryStorage.get("artisign.theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    $("#settings-trigger").click();
    $('.settings-seg-button[data-theme-pref="light"]').click();
    await flush();
    expect(memoryStorage.get("artisign.theme")).toBe("light");
    expect(settings.prefs["artisign.theme"]).toBe("light");
  });

  it("runs on defaults when the settings request fails", async () => {
    const ok = fetch;
    vi.stubGlobal("fetch", async (url, init) => {
      if (String(url).startsWith("/api/settings")) throw new Error("down");
      return ok(url, init);
    });
    await boot();
    expect($("#zoom-label").textContent).toBe("Fit");
  });
});
