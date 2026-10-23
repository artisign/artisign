// @vitest-environment jsdom
//
// CHR-912 — the topbar and canvas bar wired in app.js: icon mode toggles with tooltips, the zoom dropdown, the Live chip, the variant-map toggle and the frame caption.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";
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
  clear: () => memoryStorage.clear(),
};

const SCREENS = [
  { name: "family", tags: [] },
  { name: "family-leave", tags: [], variant_of: "family", variant_kind: "overlay" },
];

let sources;

function stubDaemon() {
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  sources = [];
  vi.stubGlobal("EventSource", class { constructor() { sources.push(this); } close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url) => {
    const path = String(url).split("?")[0];
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "<div style='width:390px;height:844px'></div>" });
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
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  stubDaemon();
});
afterEach(() => vi.unstubAllGlobals());

describe("topbar markup", () => {
  it("has no glyph icons and an accessible name plus tooltip on every icon toggle", async () => {
    await boot();
    expect($("#topbar").textContent.replaceAll(/[a-z_]+(?=\b)/g, "")).not.toMatch(GLYPH_ICON);
    for (const [id, label, icon] of [
      ["flow-mode-toggle", "Flow mode", "route"],
      ["comment-mode-toggle", "Comment mode", "chat_bubble"],
      ["inspect-mode-toggle", "Inspect mode", "frame_inspect"],
      ["status-bar-toggle", "Status bar", "smartphone"],
    ]) {
      const btn = document.getElementById(id);
      expect(btn.getAttribute("aria-label")).toBe(label);
      expect(btn.dataset.tooltip).toBe(label);
      expect(btn.querySelector(".icon").textContent).toBe(icon);
      expect(btn.dataset.shortcut).toBe(""); // hints arrive with the shortcut ticket
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
    expect(memoryStorage.get("artisign.zoom")).toBe("2");
    expect($('.zoom-button[data-zoom="2"]').getAttribute("aria-pressed")).toBe("true");
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
    expect(memoryStorage.get("artisign.variantMap")).toBe("false");
    $("#variant-bar .variant-map-toggle").click();
    expect($("#variant-map").hidden).toBe(false);
    expect(memoryStorage.get("artisign.variantMap")).toBe("true");
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
