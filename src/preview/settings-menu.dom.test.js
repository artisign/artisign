// @vitest-environment jsdom
//
// CHR-926 — the settings menu in the topbar (theme, per-browser toggles, MCP setup, About) and the Connect AI tools dialog, wired in app.js.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";
import { fakeSettings } from "./fake-settings.test-helper.js";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

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

const SETUP = {
  command: "artisign setup",
  clients: [
    { name: "Claude Code", found: true, connected: false, manual: { kind: "command", text: "claude mcp add artisign -- npx -y artisign@9.9.9 mcp" } },
    { name: "Claude Desktop", found: true, connected: true, manual: { kind: "config", path: "~/Library/claude.json", text: "{}" } },
    { name: "Cursor", found: true, connected: false, manual: { kind: "config", path: "~/.cursor/mcp.json", text: '{"mcpServers":{}}' } },
    { name: "opencode", found: false, connected: false, manual: { kind: "command", text: "opencode mcp add artisign" } },
  ],
};

let settings;
let setupResponse; // null = the request fails
let setupCalls;
let writeText;

function stubDaemon() {
  settings = fakeSettings();
  setupResponse = SETUP;
  setupCalls = 0;
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.stubGlobal("fetch", async (url, init) => {
    const path = String(url).split("?")[0];
    const settingsRes = settings.handle(path, init);
    if (settingsRes) return settingsRes;
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "<div style='width:390px;height:844px'></div>" });
    if (path === "/api/about") return json({ version: "9.9.9" });
    if (path === "/api/setup") {
      setupCalls++;
      if (!setupResponse) throw new Error("down");
      return json(setupResponse);
    }
    if (path.startsWith("/api/render/")) return json({});
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
const $$ = (sel) => [...document.querySelectorAll(sel)];
const trigger = () => $("#settings-trigger");
const menu = () => $("#settings-menu");
const row = (name) => $(`.settings-toggle-row[data-setting="${name}"]`);
const press = (key, target = document.activeElement) => {
  const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(evt);
  return evt;
};

async function boot() {
  await import("./app.js");
  await flush();
}

async function openMenu() {
  trigger().click();
  await flush();
}

beforeEach(() => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  document.documentElement.removeAttribute("data-theme");
  stubDaemon();
});
afterEach(() => {
  // Every test imports a fresh app.js whose document listeners outlive it; an Escape closes the menu or dialog this one left open, so its capture handler cannot swallow the next test's keys.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  vi.unstubAllGlobals();
});

describe("settings trigger", () => {
  it("sits after the Live chip, and the interim theme toggle is gone", async () => {
    await boot();
    expect($("#theme-toggle")).toBeNull();
    const chip = $("#connection-status");
    expect(chip.nextElementSibling.id).toBe("settings-controls");
    expect(trigger().getAttribute("aria-label")).toBe("Settings");
    expect(trigger().dataset.tooltip).toBe("Settings");
    expect(trigger().querySelector(".icon").textContent).toBe("settings");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(menu().hidden).toBe(true);
  });
});

describe("opening and closing", () => {
  it("opens on click with focus on the current theme, and closes on a second click", async () => {
    await boot();
    trigger().click();
    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement.dataset.themePref).toBe("system");
    trigger().click();
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes it and returns focus to the trigger", async () => {
    await boot();
    await openMenu();
    press("Escape");
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("a press outside closes it", async () => {
    await boot();
    await openMenu();
    $("#sidebar-screens").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu().hidden).toBe(true);
  });

  it("a press inside does not", async () => {
    await boot();
    await openMenu();
    menu().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu().hidden).toBe(false);
  });
});

describe("menu structure and keyboard", () => {
  it("uses the ARIA menu roles: radios for the theme, checkboxes for the switches", async () => {
    await boot();
    expect(menu().getAttribute("role")).toBe("menu");
    expect($$(".settings-seg-button").map((b) => b.getAttribute("role"))).toEqual(["menuitemradio", "menuitemradio", "menuitemradio"]);
    expect($$(".settings-toggle-row").map((b) => b.getAttribute("role"))).toEqual(Array(5).fill("menuitemcheckbox"));
    expect($("#settings-mcp").getAttribute("role")).toBe("menuitem");
  });

  it("Up and Down walk the rows with the theme control as one stop; Home and End jump", async () => {
    await boot();
    await openMenu();
    const order = ["follow", "clusters", "edges", "variant-map", "sidebar-tags"];
    for (const name of order) {
      press("ArrowDown");
      expect(document.activeElement).toBe(row(name));
    }
    press("ArrowDown");
    expect(document.activeElement).toBe($("#settings-mcp"));
    press("ArrowDown"); // What's New, in About once the version is known (CHR-928)
    expect(document.activeElement).toBe($("#settings-whats-new"));
    press("ArrowDown"); // wraps to the theme control
    expect(document.activeElement.dataset.themePref).toBe("system");
    press("ArrowUp");
    expect(document.activeElement).toBe($("#settings-whats-new"));
    press("Home");
    expect(document.activeElement.dataset.themePref).toBe("system");
    press("End");
    expect(document.activeElement).toBe($("#settings-whats-new"));
  });

  it("Left and Right move between the theme segments, Down leaves from the focused one", async () => {
    await boot();
    await openMenu();
    press("ArrowRight");
    expect(document.activeElement.dataset.themePref).toBe("light");
    press("ArrowRight");
    expect(document.activeElement.dataset.themePref).toBe("dark");
    press("ArrowRight");
    expect(document.activeElement.dataset.themePref).toBe("dark");
    press("ArrowDown");
    expect(document.activeElement).toBe(row("follow"));
    press("ArrowUp");
    expect(document.activeElement.dataset.themePref).toBe("system"); // the checked one is the stop on re-entry
  });

  it("keeps a single tab stop", async () => {
    await boot();
    await openMenu();
    const stops = () => $$("#settings-menu button").filter((b) => b.tabIndex === 0);
    expect(stops()).toEqual([document.activeElement]);
    press("ArrowDown");
    expect(stops()).toEqual([row("follow")]);
    press("ArrowUp");
    press("ArrowRight");
    expect(stops()).toEqual([document.activeElement]);
  });
});

describe("theme", () => {
  it("applies live, is stored by the daemon, mirrored for the pre-paint script, and the menu stays open", async () => {
    await boot();
    await openMenu();
    $('.settings-seg-button[data-theme-pref="dark"]').click();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect($('.settings-seg-button[data-theme-pref="dark"]').getAttribute("aria-checked")).toBe("true");
    expect($('.settings-seg-button[data-theme-pref="system"]').getAttribute("aria-checked")).toBe("false");
    expect(menu().hidden).toBe(false);
    expect(memoryStorage.get("artisign.theme")).toBe("dark");
    await flush();
    expect(settings.prefs["artisign.theme"]).toBe("dark");
    $('.settings-seg-button[data-theme-pref="light"]').click();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("opens on the stored theme", async () => {
    settings = fakeSettings({ prefs: { "artisign.theme": "dark" }, migrated: true });
    await boot();
    await openMenu();
    expect(document.activeElement.dataset.themePref).toBe("dark");
  });
});

describe("toggles", () => {
  it("show the current state when the menu opens", async () => {
    settings = fakeSettings({ prefs: { "artisign.boardClusters": "false", "artisign.sidebarTags": "false", "artisign.followEnabled": "true" }, migrated: true });
    await boot();
    await openMenu();
    expect($$(".settings-toggle-row").map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false", "true", "true", "false"]);
  });

  it("Follow agent by default does what the Follow pill does", async () => {
    await boot();
    await openMenu();
    row("follow").click();
    expect(row("follow").getAttribute("aria-checked")).toBe("true");
    expect($("#follow-toggle-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(menu().hidden).toBe(false);
    await flush();
    expect(settings.prefs["artisign.followEnabled"]).toBe("true");
    $("#follow-toggle-toggle").click(); // and the other way round, seen on the next open
    trigger().click();
    trigger().click();
    expect(row("follow").getAttribute("aria-checked")).toBe("false");
  });

  it("Board clusters and Board edges drive the toolbar buttons", async () => {
    await boot();
    await openMenu();
    row("clusters").click();
    expect($("#board-clusters-toggle").getAttribute("aria-pressed")).toBe("false");
    expect($("#board-clusters-toggle").textContent).toBe("Clusters: Off");
    row("edges").click();
    expect($("#board-edges-toggle").getAttribute("aria-pressed")).toBe("false");
    expect($("#board-edges-toggle").textContent).toBe("Edges: Off");
    await flush();
    expect(settings.prefs["artisign.boardClusters"]).toBe("false");
    expect(settings.prefs["artisign.boardEdgesVisible"]).toBe("false");
    expect(menu().hidden).toBe(false);
  });

  it("changes made with the toolbar buttons show in the menu", async () => {
    await boot();
    $("#board-edges-toggle").click();
    await openMenu();
    expect(row("edges").getAttribute("aria-checked")).toBe("false");
  });

  it("Variant map hides and shows the map and the bar's own button follows", async () => {
    await boot();
    expect($("#variant-map").hidden).toBe(false);
    await openMenu();
    row("variant-map").click();
    expect($("#variant-map").hidden).toBe(true);
    expect($("#variant-bar .variant-map-toggle").getAttribute("aria-pressed")).toBe("false");
    await flush();
    expect(settings.prefs["artisign.variantMap"]).toBe("false");
    row("variant-map").click();
    expect($("#variant-map").hidden).toBe(false);
    expect($("#variant-bar .variant-map-toggle").getAttribute("aria-pressed")).toBe("true");
  });

  it("Tags in sidebar drives the Tags button", async () => {
    await boot();
    await openMenu();
    row("sidebar-tags").click();
    expect($("#screen-tags-toggle").getAttribute("aria-pressed")).toBe("false");
    await flush();
    expect(settings.prefs["artisign.sidebarTags"]).toBe("false");
  });

  it("Space and Enter toggle (a click on the focused button)", async () => {
    await boot();
    await openMenu();
    press("ArrowDown");
    row("follow").click();
    expect(row("follow").getAttribute("aria-checked")).toBe("true");
  });
});

describe("MCP setup row and About", () => {
  it("shows N of M connected once the status is read, and the version", async () => {
    await boot();
    await openMenu();
    expect($("#settings-mcp-sub").hidden).toBe(false);
    expect($("#settings-mcp-sub").textContent).toBe("1 of 4 connected");
    expect($("#settings-about").hidden).toBe(false);
    expect($("#settings-version").textContent).toBe("Artisign 9.9.9");
  });

  it("leaves the subline off while loading and when the status fails", async () => {
    setupResponse = null;
    await boot();
    trigger().click();
    expect($("#settings-mcp-sub").hidden).toBe(true);
    await flush();
    expect($("#settings-mcp-sub").hidden).toBe(true);
    expect($("#settings-mcp-sub").textContent).toBe("");
  });

  it("reads the status again on every open", async () => {
    await boot();
    await openMenu();
    trigger().click();
    await openMenu();
    expect(setupCalls).toBe(2);
  });

  it("Connect AI tools closes the menu and opens the dialog; focus goes back to the trigger afterwards", async () => {
    await boot();
    await openMenu();
    $("#settings-mcp").click();
    expect(menu().hidden).toBe(true);
    expect($("#mcp-scrim").hidden).toBe(false);
    await flush();
    $("#mcp-done").click();
    expect($("#mcp-scrim").hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });
});

describe("Connect AI tools dialog", () => {
  async function openDialog() {
    await boot();
    await openMenu();
    $("#settings-mcp").click();
    await flush();
  }
  const clientRow = (name) => $$(".mcp-client").find((c) => c.querySelector(".mcp-client-name").textContent === name);

  it("shows the command, one row per tool in order, status chips and the summary", async () => {
    await openDialog();
    expect($("#mcp-command .mcp-code-text").textContent).toBe("artisign setup");
    expect($$(".mcp-client-name").map((n) => n.textContent)).toEqual(["Claude Code", "Claude Desktop", "Cursor", "opencode"]);
    expect($$(".mcp-status").map((c) => c.textContent.replace("check", ""))).toEqual(["Not connected", "Connected", "Not connected", "Not installed"]);
    expect($("#mcp-summary").textContent).toBe("1 of 4 connected");
  });

  it("expands tools that are not connected, with the command or the config and its path", async () => {
    await openDialog();
    const code = clientRow("Claude Code");
    expect(code.querySelector(".mcp-client-row").getAttribute("aria-expanded")).toBe("true");
    expect(code.querySelector(".mcp-manual").hidden).toBe(false);
    expect(code.querySelector(".mcp-hint").textContent).toBe("Run in a terminal:");
    expect(code.querySelector(".mcp-code-text").textContent).toBe("claude mcp add artisign -- npx -y artisign@9.9.9 mcp");
    const cursor = clientRow("Cursor");
    expect(cursor.querySelector(".mcp-hint").textContent).toBe("Add this to ~/.cursor/mcp.json:");
    expect(cursor.querySelector(".mcp-path").textContent).toBe("~/.cursor/mcp.json");
    expect(cursor.querySelector(".mcp-code-text").textContent).toBe('{"mcpServers":{}}');
  });

  it("a connected tool has nothing to expand; a tool that is not installed is collapsed but can be opened", async () => {
    await openDialog();
    const desktop = clientRow("Claude Desktop");
    expect(desktop.querySelector("button.mcp-client-row")).toBeNull();
    expect(desktop.querySelector(".mcp-manual")).toBeNull();
    const missing = clientRow("opencode");
    const head = missing.querySelector(".mcp-client-row");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(missing.querySelector(".mcp-manual").hidden).toBe(true);
    head.click();
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(missing.querySelector(".mcp-manual").hidden).toBe(false);
    head.click();
    expect(missing.querySelector(".mcp-manual").hidden).toBe(true);
  });

  it("a not-connected row can be collapsed", async () => {
    await openDialog();
    const code = clientRow("Claude Code");
    code.querySelector(".mcp-client-row").click();
    expect(code.querySelector(".mcp-manual").hidden).toBe(true);
  });

  it("copies the command and the snippets, showing a check mark for a moment", async () => {
    await openDialog();
    const copy = $("#mcp-command button");
    copy.click();
    await flush();
    expect(writeText).toHaveBeenLastCalledWith("artisign setup");
    expect(copy.querySelector(".icon").textContent).toBe("check");
    clientRow("Cursor").querySelector(".mcp-manual button").click();
    await flush();
    expect(writeText).toHaveBeenLastCalledWith('{"mcpServers":{}}');
  });

  it("tolerates a clipboard that refuses", async () => {
    await openDialog();
    writeText.mockRejectedValueOnce(new Error("denied"));
    const copy = $("#mcp-command button");
    copy.click();
    await flush();
    expect(copy.querySelector(".icon").textContent).toBe("content_copy");
  });

  it("says so when the status cannot be read, and still offers the command", async () => {
    setupResponse = null;
    await openDialog();
    expect($("#mcp-clients").textContent).toContain("Could not read the tool status");
    expect($("#mcp-command .mcp-code-text").textContent).toBe("artisign setup");
  });

  it("closes with Escape, the close button, a scrim click and Done; focus returns to the settings trigger", async () => {
    await openDialog();
    press("Escape");
    expect($("#mcp-scrim").hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
    for (const close of [() => $("#mcp-close").click(), () => $("#mcp-scrim").click(), () => $("#mcp-done").click()]) {
      trigger().click();
      $("#settings-mcp").click();
      expect($("#mcp-scrim").hidden).toBe(false);
      close();
      expect($("#mcp-scrim").hidden).toBe(true);
      expect(document.activeElement).toBe(trigger());
    }
  });

  it("is modal: single-key shortcuts do nothing while it is open", async () => {
    await openDialog();
    press("t", document.body);
    $("#mcp-done").click();
    await openMenu();
    expect(document.activeElement.dataset.themePref).toBe("system"); // T did not cycle the theme
  });

  it("reads the status again each time it opens", async () => {
    await openDialog();
    const calls = setupCalls;
    $("#mcp-done").click();
    trigger().click();
    $("#settings-mcp").click();
    await flush();
    expect(setupCalls).toBeGreaterThan(calls);
  });
});
