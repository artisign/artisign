// @vitest-environment jsdom
//
// CHR-912 / CHR-1267 — the floating top groups and the zoom pill wired in app.js: icon mode toggles with tooltips, the zoom pill and its popover, the Live chip, the variant breadcrumb and the frame label.
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
  { name: "solo", tags: [] },
  { name: "cart", tags: [] },
  { name: "cart-clear", tags: [], variant_of: "cart", variant_kind: "overlay" },
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
  it("has no glyph icons and an accessible name, a title (no interest invokers in jsdom) and the key on every tool", async () => {
    await boot();
    expect($("#topbar").textContent.replaceAll(/[a-z_]+(?=\b)/g, "")).not.toMatch(GLYPH_ICON);
    for (const sel of ["#tool-bar", "#canvas-controls"]) expect($(sel).textContent.replaceAll(/[a-z_]+(?=\b)/g, "")).not.toMatch(GLYPH_ICON);
    for (const [id, label, icon, key] of [
      ["comment-mode-toggle", "Comment", "add_comment", "C"],
      ["inspect-mode-toggle", "Inspect", "frame_inspect", "I"],
      ["notes-tool-toggle", "Notes", "description", "N"],
      ["comments-tool-toggle", "Comments", "chat_bubble", "M"],
      ["flow-mode-toggle", "Flow", "route", "F"],
      ["design-system-tool", "Design system", "palette", "D"],
    ]) {
      const btn = document.getElementById(id);
      expect(btn.getAttribute("aria-label"), id).toBe(label);
      expect(btn.querySelector(".icon").textContent, id).toBe(icon);
      expect(btn.dataset.shortcut, id).toBe(key); // filled from the shortcut mapping (CHR-916)
      expect(btn.title, id).toBe(key ? `${label} (${key})` : label); // the baseline tooltip where interest invokers are missing
    }
    expect(document.getElementById("status-bar-toggle")).toBeNull(); // no status bar, no More menu (CHR-1268)
    expect(document.getElementById("more-tool-toggle")).toBeNull();
  });
});

const zoomOpen = () => $("#zoom-menu").hasAttribute("data-open"); // jsdom has no Popover API, so the fallback toggles data-open

describe("zoom pill", () => {
  it("shows the effective zoom as a percentage, picks a preset from the popover, closes and persists", async () => {
    await boot();
    expect($("#zoom-label").textContent).toBe("100%");
    expect($('#zoom-fit').getAttribute("aria-pressed")).toBe("true"); // Fit is the default
    expect(zoomOpen()).toBe(false);
    $("#zoom-trigger").click();
    expect(zoomOpen()).toBe(true);
    expect($("#zoom-trigger").getAttribute("aria-expanded")).toBe("true");
    $('#zoom-menu .zoom-button[data-zoom="2"]').click();
    expect(zoomOpen()).toBe(false);
    expect($("#zoom-label").textContent).toBe("200%");
    expect($("#zoom-range").value).toBe("200");
    await flush();
    expect(settings.prefs["artisign.zoom"]).toBe("2");
    expect($('#zoom-menu .zoom-button[data-zoom="2"]').getAttribute("aria-pressed")).toBe("true");
    expect($('#zoom-menu .zoom-button[data-zoom="fit"]').getAttribute("aria-pressed")).toBe("false");
    expect($("#zoom-fit").getAttribute("aria-pressed")).toBe("false");
  });

  it("the slider sets any zoom between 5% and 200%, continuously, and persists it", async () => {
    await boot();
    expect($("#zoom-range").min).toBe("5");
    expect($("#zoom-range").max).toBe("200");
    $("#zoom-range").value = "37";
    $("#zoom-range").dispatchEvent(new Event("input", { bubbles: true }));
    expect($("#zoom-label").textContent).toBe("37%");
    expect($("#zoom-fit").getAttribute("aria-pressed")).toBe("false");
    await flush();
    expect(settings.prefs["artisign.zoom"]).toBe("0.37");
  });

  it("− and + step along the zoom ladder and the Fit button goes back to fitting", async () => {
    memoryStorage.set("artisign.zoom", "1");
    await boot();
    expect($("#zoom-label").textContent).toBe("100%");
    $("#zoom-in").click();
    expect($("#zoom-label").textContent).toBe("125%");
    $("#zoom-out").click();
    $("#zoom-out").click();
    expect($("#zoom-label").textContent).toBe("75%");
    $("#zoom-fit").click();
    expect($("#zoom-fit").getAttribute("aria-pressed")).toBe("true");
    await flush();
    expect(settings.prefs["artisign.zoom"]).toBe("fit");
  });

  it("restores the stored zoom and closes the popover on Escape", async () => {
    memoryStorage.set("artisign.zoom", "0.5");
    await boot();
    expect($("#zoom-label").textContent).toBe("50%");
    $("#zoom-trigger").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(zoomOpen()).toBe(false);
  });

  it("a press outside the pill and the popover closes it", async () => {
    await boot();
    $("#zoom-trigger").click();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(zoomOpen()).toBe(false);
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

describe("variant breadcrumb", () => {
  it("floats above a variant screen with the compare toggle, and the variant map is gone (CHR-1267)", async () => {
    memoryStorage.set("artisign.last-screen:/p", "cart-clear");
    await boot();
    expect($("#variant-bar").hidden).toBe(false);
    expect($("#variant-bar .compare-seg")).not.toBeNull();
    expect($("#variant-bar .variant-map-toggle")).toBeNull();
    expect($("#variant-map")).toBeNull();
    expect($("#variant-bar .crumb-group.on").dataset.screen).toBe("cart-clear");
  });

  it("a plain screen has no breadcrumb", async () => {
    await boot();
    expect($("#variant-bar").hidden).toBe(true);
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

describe("frame label", () => {
  it("names the rendered screen, its viewport icon and its size once the frame has loaded", async () => {
    await boot();
    expect($("#frame-caption").hidden).toBe(true); // nothing has rendered yet
    $("#screen-frame").dispatchEvent(new Event("load")); // jsdom does not run srcdoc documents
    expect($("#frame-caption").hidden).toBe(false);
    expect($("#frame-caption .frame-label-icon").textContent).toBe("smartphone");
    expect($("#frame-caption .frame-label-name").textContent).toBe("solo");
    expect($("#frame-caption .frame-label-detail").textContent).toBe("390 \u00D7 844");
  });

  it("gives way to the breadcrumb on a variant screen", async () => {
    memoryStorage.set("artisign.last-screen:/p", "cart-clear");
    await boot();
    $("#screen-frame").dispatchEvent(new Event("load"));
    expect($("#frame-caption").hidden).toBe(true);
    expect($("#variant-bar").hidden).toBe(false);
  });

  it("stays hidden when the render failed", async () => {
    renderOk = false;
    await boot();
    $("#screen-frame").dispatchEvent(new Event("load"));
    expect($("#frame-caption").hidden).toBe(true);
  });
});

describe("zoom popover vs the other floating things", () => {
  it("Escape closes only the zoom popover: inspect mode's own Escape does not also fire", async () => {
    await boot();
    const inspect = $("#inspect-mode-toggle");
    inspect.disabled = false;
    inspect.click();
    expect(inspect.getAttribute("aria-pressed")).toBe("true");
    $("#zoom-trigger").click();
    expect(zoomOpen()).toBe(true);
    const reachedBubble = vi.fn();
    document.addEventListener("keydown", reachedBubble);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.removeEventListener("keydown", reachedBubble);
    expect(zoomOpen()).toBe(false);
    expect(reachedBubble).not.toHaveBeenCalled();
    expect(inspect.getAttribute("aria-pressed")).toBe("true");
  });

  it("opening the zoom popover closes the project menu, and the project menu's trigger closes the zoom popover", async () => {
    await boot();
    $("#project-picker-trigger").click();
    expect($("#project-menu").hidden).toBe(false);
    $("#zoom-trigger").click();
    expect($("#project-menu").hidden).toBe(true);
    expect(zoomOpen()).toBe(true);
    // The project trigger stops click propagation, so only a pointerdown capture hears it.
    $("#project-picker-trigger").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(zoomOpen()).toBe(false);
  });
});

describe("floating top groups (CHR-1267)", () => {
  it("is three floating groups: brand + project picker, the view tabs, status + settings", async () => {
    await boot();
    expect([...$("#topbar").children].map((el) => el.id)).toEqual(["topbar-brand", "view-tabs", "topbar-end"]);
    expect([...$("#topbar").children].every((el) => el.classList.contains("float-pill"))).toBe(true);
    expect($("#topbar-brand").contains($("#project-picker-trigger"))).toBe(true);
    expect($("#topbar-end").contains($("#settings-trigger"))).toBe(true);
    expect([...document.querySelectorAll("#view-tabs .view-tab")].map((t) => t.dataset.view)).toEqual(["screens", "board", "design-system", "usecases"]);
  });

  it("keeps the interim mode tools and the zoom pill out of the top bar, and the Context and Elements panels are gone", async () => {
    await boot();
    expect($("#topbar #comment-mode-toggle")).toBeNull();
    expect($("#topbar #canvas-controls")).toBeNull();
    expect($("#sidebar-context")).toBeNull();
    expect($("#inspector")).toBeNull();
    expect($("#variant-map")).toBeNull();
  });
});

describe("daemon-stored preferences (CHR-924)", () => {
  it("carries this browser's localStorage prefs over once and applies them", async () => {
    memoryStorage.set("artisign.zoom", "0.5");
    memoryStorage.set("uxd.sidebarTags", "false");
    await boot();
    expect(settings.imports).toEqual([{ "artisign.zoom": "0.5", "artisign.sidebarTags": "false" }]);
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
    $('#zoom-menu .zoom-button[data-zoom="2"]').click();
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
    expect($("#zoom-fit").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Use Cases tab beta badge (CHR-1165)", () => {
  it("puts a Beta badge inside the tab button, named 'Use Cases, Beta', without extra focus stops or aria-label", async () => {
    await boot();
    const tab = $('.view-tab[data-view="usecases"]');
    const badge = tab.querySelector(":scope > .chrome-badge");
    expect(badge).not.toBeNull();
    expect(badge.querySelector(".visually-hidden").textContent).toBe(", ");
    expect(tab.textContent).toBe("Use Cases, Beta");
    expect(tab.hasAttribute("aria-label")).toBe(false);
    expect(tab.querySelector("button, a, [tabindex]")).toBeNull();
    expect(document.querySelectorAll("#view-tabs .chrome-badge")).toHaveLength(1);
  });
});
