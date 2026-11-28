// @vitest-environment jsdom
//
// CHR-1267 — the left floating card wired in app.js: the Screens | Mockups segmented control with counts, the find field and its hint, the tag toggle, the screen tree with viewport icons and the collapsible variant tree, the mockup tree, and the selection (teal row) following the open screen.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";
import { fakeSettings } from "./fake-settings.test-helper.js";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

const SCREENS = [
  { name: "home", tags: ["orders", "dashboard", "kpi"], notes: "" },
  { name: "home-empty", tags: ["orders"], notes: "", variant_of: "home", variant_kind: "state" },
  { name: "home-export", tags: ["export"], notes: "", variant_of: "home", variant_kind: "overlay" },
  { name: "checkout", tags: ["checkout"], notes: "" },
];
const VIEWPORTS = { home: 1280, "home-empty": 1280, "home-export": 1280, checkout: 390 };
const MOCKUPS = [
  { name: "onboarding-ideas", title: "Onboarding ideas", tags: ["ideas"], variants: [{ id: "tour", title: "Guided tour" }, { id: "list", title: "Checklist" }] },
  { name: "empty-states", tags: [], variants: [{ id: "a", title: "A" }] },
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
let screens;
let mockups;
let viewportFails;

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
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "<div style='width:390px;height:844px'></div>" });
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens });
    if (path === "/api/tools/get_project") {
      if (viewportFails) return { ok: false, status: 500, json: async () => ({}) };
      return json({ screens: screens.map((s) => ({ screen: s.name, viewport: { width: VIEWPORTS[s.name] ?? 390, height: 800, declared: true } })) });
    }
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [], threads: [] });
    if (path === "/api/tools/get_screen") return json({ nodes: [] });
    if (path.startsWith("/api/render/")) return json({});
    return json({});
  });
}

const flush = async () => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const all = $$;
const rowNames = () => $$("#screen-list .screen-item-row[data-screen]").map((r) => r.dataset.screen);

async function boot() {
  await import("./app.js");
  await flush();
}

beforeEach(() => {
  memoryStorage.clear();
  screens = SCREENS;
  mockups = MOCKUPS;
  viewportFails = false;
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  stubDaemon();
});
afterEach(() => vi.unstubAllGlobals());

describe("segmented control", () => {
  it("counts the screens and the mockups and switches the list; the selected segment is aria-selected", async () => {
    await boot();
    expect([$("#nav-count-screens").textContent, $("#nav-count-mockups").textContent]).toEqual(["4", "2"]);
    expect($("#nav-tab-screens").getAttribute("aria-selected")).toBe("true");
    expect($("#screen-list").hidden).toBe(false);
    expect($("#mockup-list").hidden).toBe(true);
    $("#nav-tab-mockups").click();
    expect($("#nav-tab-mockups").getAttribute("aria-selected")).toBe("true");
    expect($("#screen-list").hidden).toBe(true);
    expect($("#mockup-list").hidden).toBe(false);
    expect($$("#mockup-list .mockup-item").map((b) => b.dataset.mockupName)).toEqual(["onboarding-ideas", "empty-states"]);
  });

  it("the list area is the tab panel of the chosen segment", async () => {
    await boot();
    expect($("#nav-scroll").getAttribute("role")).toBe("tabpanel");
    expect($("#nav-scroll").getAttribute("aria-labelledby")).toBe("nav-tab-screens");
    expect($("#nav-tab-screens").getAttribute("aria-controls")).toBe("nav-scroll");
    $("#nav-tab-mockups").click();
    expect($("#nav-scroll").getAttribute("aria-labelledby")).toBe("nav-tab-mockups");
  });

  it("is a roving tablist: arrows and Home / End move between the segments", async () => {
    await boot();
    expect([$("#nav-tab-screens").tabIndex, $("#nav-tab-mockups").tabIndex]).toEqual([0, -1]);
    $("#nav-tab-screens").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect($("#nav-tab-mockups").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe($("#nav-tab-mockups"));
    $("#nav-tab-mockups").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    expect($("#nav-tab-screens").getAttribute("aria-selected")).toBe("true");
  });

  it("selecting a mockup switches to Mockups, selecting a screen switches back", async () => {
    await boot();
    $("#nav-tab-mockups").click();
    $(".mockup-item").click();
    await flush();
    expect($("#nav-tab-mockups").getAttribute("aria-selected")).toBe("true");
    // The open mockup's tree opens and its first variant carries the selection.
    expect($(".mockup-variant-item").getAttribute("aria-current")).toBe("true");
    $("#nav-tab-screens").click();
    $('.screen-item-row[data-screen="checkout"] .screen-item').click();
    await flush();
    expect($("#nav-tab-screens").getAttribute("aria-selected")).toBe("true");
    expect($('.screen-item-row[data-screen="checkout"] .screen-item').getAttribute("aria-selected")).toBe("true");
    expect($(".mockup-item").getAttribute("aria-current")).toBe("false");
  });

  it("opens on Mockups when the last open item was a mockup", async () => {
    memoryStorage.set("artisign.last-screen:/p", "mockup:empty-states");
    await boot();
    expect($("#nav-tab-mockups").getAttribute("aria-selected")).toBe("true");
    expect($('.mockup-variant-item[aria-current="true"]')).not.toBeNull();
  });
});

describe("screen tree", () => {
  it("shows the roots with a viewport icon (desktop or mobile) and the variant count, variants collapsed", async () => {
    await boot();
    expect(rowNames()).toEqual(["home", "checkout"]);
    const icon = (name) => $(`.screen-item-row[data-screen="${name}"] .kind-icon`);
    expect([icon("home").textContent, icon("home").dataset.viewport]).toEqual(["desktop_windows", "desktop"]);
    expect([icon("checkout").textContent, icon("checkout").dataset.viewport]).toEqual(["smartphone", "mobile"]);
    expect($('.screen-item-row[data-screen="home"] .screen-item-total').textContent).toBe("2");
    expect($("#screen-list").getAttribute("role")).toBe("tree");
  });

  it("falls back to the phone icon for every screen when the sizes cannot be read", async () => {
    viewportFails = true;
    await boot();
    expect($$("#screen-list .kind-icon").map((i) => i.textContent)).toEqual(["smartphone", "smartphone"]);
  });

  it("the chevron expands a screen's variants (viewport icon for a state, its own glyph for an overlay) and remembers it", async () => {
    await boot();
    $('.screen-item-row[data-screen="home"] .screen-item-toggle').click();
    expect(rowNames()).toEqual(["home", "home-empty", "home-export", "checkout"]);
    expect($('.screen-item-row[data-screen="home-empty"] .kind-icon').textContent).toBe("desktop_windows");
    expect($('.screen-item-row[data-screen="home-export"] .kind-icon').textContent).toBe("web_asset");
    await flush();
    expect(JSON.parse(settings.prefs["artisign.sidebarExpanded:/p"])).toContain("home");
  });

  it("the open screen is the selected row, and opening a variant reveals it under its screen", async () => {
    memoryStorage.set("artisign.last-screen:/p", "home-empty");
    await boot();
    expect(rowNames()).toEqual(["home", "home-empty", "home-export", "checkout"]);
    const selected = $$("#screen-list .screen-item[aria-selected='true']");
    expect(selected.map((b) => b.closest("li").dataset.screen)).toEqual(["home-empty"]);
    expect(selected[0].getAttribute("aria-level")).toBe("2");
  });

  it("shows tag chips with +N, and the tag toggle hides and shows all of them", async () => {
    await boot();
    expect($$('.screen-item-row[data-screen="home"] .tag-chip').map((c) => c.textContent)).toEqual(["orders", "dashboard", "+1"]);
    const toggle = $("#screen-tags-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Show tags");
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect($("#screen-list .tag-chip")).toBeNull();
    expect(toggle.getAttribute("aria-label")).toBe("Show tags"); // the label stays the same in both states
    await flush();
    expect(settings.prefs["artisign.sidebarTags"]).toBe("false");
  });
});

describe("find field", () => {
  const type = (value) => {
    const input = $("#screen-filter-input");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("filters by name or tag, says what it matched, and the clear button resets it", async () => {
    await boot();
    expect($("#screen-filter-hint").textContent).toBe("");
    expect($("#screen-filter-clear").hidden).toBe(true);
    type("export");
    expect(rowNames()).toEqual(["home", "home-export"]); // the match and its path as context
    expect($("#screen-filter-hint").textContent).toBe("1 match, 1 for context, of 4 screens");
    expect($("#screen-filter-clear").hidden).toBe(false);
    type("checkout");
    expect(rowNames()).toEqual(["checkout"]);
    $("#screen-filter-clear").click();
    expect($("#screen-filter-input").value).toBe("");
    expect(rowNames()).toEqual(["home", "checkout"]);
    expect($("#screen-filter-clear").hidden).toBe(true);
    expect(document.activeElement).toBe($("#screen-filter-input"));
  });

  it("also filters the mockup list by name, title or tag, with its own hint", async () => {
    await boot();
    $("#nav-tab-mockups").click();
    type("ideas");
    expect($$("#mockup-list .mockup-item").map((b) => b.dataset.mockupName)).toEqual(["onboarding-ideas"]);
    expect($("#screen-filter-hint").textContent).toBe("1 of 2 mockups");
  });

  it("says so when nothing matches, and when there is nothing yet", async () => {
    await boot();
    type("zzz");
    expect($("#screen-list .nav-empty").textContent).toBe("No screens match “zzz”.");
    type("");
    screens = [];
    mockups = [];
    vi.resetModules();
    document.body.innerHTML = bodyHtml;
    await boot();
    expect($("#screen-list .nav-empty").textContent).toContain("No screens yet.");
  });
});

describe("mockup tree", () => {
  it("shows the stacked-layers icon, tags, the variant count and a collapsible variant tree; a variant row opens its mockup", async () => {
    await boot();
    $("#nav-tab-mockups").click();
    const row = $('.mockup-item[data-mockup-name="onboarding-ideas"]');
    expect(row.querySelector(".kind-icon").textContent).toBe("layers");
    expect(row.querySelector(".mockup-item-name").textContent).toBe("Onboarding ideas");
    expect(row.querySelector(".screen-item-total").textContent).toBe("2");
    expect([...row.querySelectorAll(".tag-chip")].map((c) => c.textContent)).toEqual(["ideas"]);
    expect($(".mockup-variant-item")).toBeNull();
    $(".mockup-item-row .screen-item-toggle").click();
    expect($$("#mockup-list .mockup-variant-item .screen-item-name").map((n) => n.textContent)).toEqual(["Guided tour", "Checklist"]);
    $(".mockup-variant-item").click();
    await flush();
    expect($('.mockup-item[data-mockup-name="onboarding-ideas"]').getAttribute("aria-current")).toBe("false");
    expect($(".mockup-variant-item").getAttribute("aria-current")).toBe("true");
  });

  it("a variant row selects that variant (aria-selected, aria-current), and the canvas column follows", async () => {
    await boot();
    $("#nav-tab-mockups").click();
    $(".mockup-item-row .screen-item-toggle").click();
    const [guided, checklist] = all("#mockup-list .mockup-variant-item");
    checklist.click();
    await flush();
    expect(all("#mockup-list .mockup-variant-item").map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(all("#mockup-view .mockup-column").map((c) => c.classList.contains("is-selected"))).toEqual([false, true]);
    expect($("#mockup-view .mockup-column.is-selected").getAttribute("aria-current")).toBe("true");
    guided.click();
    await flush();
    expect(all("#mockup-list .mockup-variant-item").map((r) => r.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(all("#mockup-view .mockup-column").map((c) => c.classList.contains("is-selected"))).toEqual([true, false]);
  });

  it("another mockup opens on its first variant, and the selection is never persisted", async () => {
    await boot();
    $("#nav-tab-mockups").click();
    $(".mockup-item-row .screen-item-toggle").click();
    all("#mockup-list .mockup-variant-item")[1].click();
    await flush();
    all("#mockup-list .mockup-item")[1].click();
    await flush();
    all("#mockup-list .mockup-item")[0].click();
    await flush();
    // Both trees are open now: Onboarding ideas' two variants, then Empty states' single one.
    expect(all("#mockup-list .mockup-variant-item").map((r) => r.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect([...memoryStorage.values()].some((v) => String(v).includes("list"))).toBe(false);
  });
});
