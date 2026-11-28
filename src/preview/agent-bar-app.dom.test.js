// @vitest-environment jsdom
//
// CHR-1269 — the Agent bar in the real app (real index.html, stubbed daemon): the live status from the activity stream, Follow, a feed click, folding with the right column's panels, the offline state (the note field was removed in CHR-1293).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

const s = (name) => ({ name, tags: [], notes: "" });
let sources;
let screens;
let mockups;

const memoryStorage = new Map();
const storageStub = {
  getItem: (k) => memoryStorage.get(k) ?? null,
  setItem: (k, v) => void memoryStorage.set(k, String(v)),
  removeItem: (k) => void memoryStorage.delete(k),
  get length() { return memoryStorage.size; },
  key: (i) => [...memoryStorage.keys()][i] ?? null,
  clear: () => memoryStorage.clear(),
};

function stubDaemon() {
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  sources = [];
  vi.stubGlobal("EventSource", class { constructor() { sources.push(this); } close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (v) => v });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", async (url) => {
    const path = String(url).split("?")[0];
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens });
    if (path === "/api/mockups") return json({ mockups });
    if (path === "/api/design-system") return json({ component_definitions: [] });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [], threads: [] });
    if (path === "/api/tools/get_screen") return json({ nodes: [] });
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<div id="root">${path}</div>` };
    if (path.startsWith("/api/mockups/")) return json({ name: "m", variants: [] });
    return json({});
  });
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);
const emit = (event) => sources.at(-1).onmessage({ data: JSON.stringify(event) });
const activity = (tool, kind, target, extra = {}) => emit({ type: "activity", tool, kind, target, nodes: [], ok: true, at: Date.now(), ...extra });
const screenActivity = (name, tool = "get_screen", kind = "read") => activity(tool, kind, { kind: "screen", name });
const tab = (view) => $(`.view-tab[data-view="${view}"]`);
const rowButton = (name) => $(`#screen-list li[data-screen="${name}"] button.screen-item`);
const followState = () => (!$("#agent-follow-paused-row").hidden ? "paused" : $("#follow-switch").checked ? "following" : "off");
const key = (k) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const collapsed = () => $("#agent-bar").dataset.collapsed === "true";

async function boot() {
  localStorage.setItem("artisign.last-screen:/p", "a");
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
  screens = [s("a"), s("b")];
  mockups = [];
  stubDaemon();
});
afterEach(() => {
  for (const [type, fn, opts] of documentListeners) document.removeEventListener(type, fn, opts);
  document.addEventListener = nativeAddEventListener;
  vi.unstubAllGlobals();
});

describe("status and feed", () => {
  it("starts idle with the empty feed, then shows the latest activity and lists it newest first", async () => {
    await boot();
    expect($("#agent-status-text").textContent).toBe("Idle");
    expect($("#agent-status-detail").textContent).toBe("No agent call in this session yet");
    expect($("#agent-feed-empty").hidden).toBe(false);
    screenActivity("b", "write_html", "write");
    screenActivity("a");
    const rows = [...document.querySelectorAll("#agent-feed .agent-activity-text")].map((el) => el.textContent);
    expect(rows).toEqual(["Read a", "Wrote b"]);
    expect($("#agent-status-text").textContent).toBe("Reading a");
    expect($("#agent-status").dataset.look).toBe("active");
  });

  it("a failed call says so in plain words and is not a button", async () => {
    await boot();
    screenActivity("a", "patch_html", "write");
    activity("patch_html", "write", { kind: "screen", name: "b" }, { ok: false });
    const row = $("#agent-feed li:first-child .agent-activity");
    expect(row.dataset.variant).toBe("error");
    expect(row.textContent).toContain("Could not update b");
    expect(row.tagName).toBe("DIV");
  });

  it("a target that is gone is said, and the row is plain text", async () => {
    await boot();
    screenActivity("ghost");
    const row = $("#agent-feed li:first-child .agent-activity");
    expect(row.dataset.variant).toBe("deleted");
    expect(row.querySelector(".agent-activity-text").textContent).toBe("Read ghost, which no longer exists");
  });

  it("a click on a feed row pauses follow and opens that screen", async () => {
    localStorage.setItem("artisign.followEnabled", "true");
    await boot();
    expect(followState()).toBe("following");
    screenActivity("b");
    await flush();
    screenActivity("a", "get_node"); // a later call the human wants to leave behind
    await flush();
    const rowForB = [...document.querySelectorAll("button.agent-activity")].find((b) => b.textContent.includes("Read b"));
    rowForB.click();
    await flush();
    expect(followState()).toBe("paused");
    expect(rowButton("b").getAttribute("aria-current")).toBe("true");
    expect($("#agent-status-detail").textContent).toBe("You moved away, so the canvas stays where you are");
  });
});

describe("Follow", () => {
  it("the switch turns follow on and off", async () => {
    await boot();
    expect(followState()).toBe("off");
    $("#follow-switch").click();
    expect(followState()).toBe("following");
    $("#follow-switch").click();
    expect(followState()).toBe("off");
  });

  it("a human navigation pauses it, Resume takes it up again and jumps to the agent", async () => {
    localStorage.setItem("artisign.followEnabled", "true");
    await boot();
    screenActivity("b");
    await flush();
    tab("board").click();
    await flush();
    expect(followState()).toBe("paused");
    expect($("#follow-resume")).not.toBeNull();
    $("#follow-resume").click();
    await flush();
    expect(followState()).toBe("following");
    expect(rowButton("b").getAttribute("aria-current")).toBe("true");
  });

  it("W and R do what the switch and Resume do; W also turns a paused follow off", async () => {
    await boot();
    key("w");
    expect(followState()).toBe("following");
    tab("board").click(); // pauses
    expect(followState()).toBe("paused");
    key("r");
    expect(followState()).toBe("following");
    tab("screens").click();
    expect(followState()).toBe("paused");
    key("w");
    expect(followState()).toBe("off");
  });
});

describe("offline", () => {
  it("the Live chip turns into Offline, the status waits for the connection, and everything comes back with the stream", async () => {
    await boot();
    screenActivity("a", "write_html", "write");
    sources.at(-1).onerror();
    expect($("#connection").dataset.state).toBe("offline");
    expect($("#agent-status-text").textContent).toBe("Waiting for the connection");
    expect($("#agent-status-detail").textContent).toBe("Last activity now");
    expect($("#agent-bar").dataset.connection).toBe("offline");
    sources.at(-1).onopen();
    expect($("#connection").dataset.state).toBe("live");
    expect($("#agent-status-text").textContent).toBe("Writing a");
  });
});

describe("folding with the right column", () => {
  it("folds above an open tool panel and comes back when it closes", async () => {
    await boot();
    expect(collapsed()).toBe(false);
    $("#comments-tool-toggle").click();
    expect(collapsed()).toBe(true);
    expect($("#agent-bar").dataset.panelFold).toBe("true");
    expect($("#tool-panel").hidden).toBe(false);
    $("#tool-panel-close").click();
    expect(collapsed()).toBe(false);
  });

  it("stays folded while one panel replaces another, and every panel folds it", async () => {
    await boot();
    for (const id of ["#notes-tool-toggle", "#inspect-mode-toggle", "#comments-tool-toggle"]) {
      $(id).click();
      expect(collapsed()).toBe(true);
    }
    $("#comments-tool-toggle").click(); // toggles the panel off
    expect(collapsed()).toBe(false);
  });

  it("Flow mode leaves it open", async () => {
    await boot();
    $("#flow-mode-toggle").click();
    expect($("#flow-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(collapsed()).toBe(false);
  });

  it("the user's fold is remembered, the ] key does it, and it survives a panel opening and closing", async () => {
    await boot();
    key("]");
    expect(collapsed()).toBe(true);
    $("#notes-tool-toggle").click();
    $("#tool-panel-close").click();
    expect(collapsed()).toBe(true);
    key("]");
    expect(collapsed()).toBe(false);
  });

  it("] does nothing while a panel holds it folded", async () => {
    await boot();
    $("#notes-tool-toggle").click();
    key("]");
    $("#notes-tool-toggle").click();
    expect(collapsed()).toBe(false); // no stored fold came out of the key
  });

  it("the panel opening on a screen shows the folded status in the head", async () => {
    await boot();
    screenActivity("a", "write_html", "write");
    $("#comments-tool-toggle").click();
    expect($("#agent-bar-folded-status").hidden).toBe(false);
    expect($("#agent-bar-folded-text").textContent).toBe("Writing a");
  });
});

describe("the Design System view and Use Cases (no Agent bar there)", () => {
  const topFollow = () => (!$("#topbar-follow-paused").hidden ? "paused" : $("#topbar-follow-switch").checked ? "following" : "off");

  it("follow on, a component write switches to the Design System view: the top bar shows the follow state and the Live chip, and Offline when the stream drops", async () => {
    localStorage.setItem("artisign.followEnabled", "true");
    await boot();
    activity("write_html", "write", { kind: "component", name: "btn" });
    await flush();
    expect($("#app").dataset.shellView).toBe("design-system");
    expect(topFollow()).toBe("following");
    expect($("#topbar-connection-label").textContent).toBe("Live");
    sources.at(-1).onerror();
    expect($("#topbar-connection-label").textContent).toBe("Offline");
    expect($("#topbar-connection").dataset.tooltip).toBe("Live reload disconnected, retrying");
    sources.at(-1).onopen();
    expect($("#topbar-connection-label").textContent).toBe("Live");
  });

  it("a human move there pauses follow: Resume in the top bar, and W and R act on the top bar's controls", async () => {
    localStorage.setItem("artisign.followEnabled", "true");
    await boot();
    tab("design-system").click();
    await flush();
    expect(topFollow()).toBe("paused");
    key("r");
    expect(topFollow()).toBe("following");
    key("w");
    expect(topFollow()).toBe("off");
    key("w");
    expect(topFollow()).toBe("following");
    $("#topbar-follow-switch").click();
    expect(topFollow()).toBe("off");
  });

  it("] folds nothing there and stores nothing: back in Screens the bar is as it was", async () => {
    await boot();
    for (const view of ["design-system", "usecases"]) {
      tab(view).click();
      await flush();
      key("]");
      expect(collapsed()).toBe(false);
    }
    tab("screens").click();
    await flush();
    expect(collapsed()).toBe(false);
    key("]"); // and in Screens it still works
    expect(collapsed()).toBe(true);
  });
});

describe("no note field (CHR-1293)", () => {
  it("the Agent bar has no input, send button or scope line in any view", async () => {
    await boot();
    expect($("#agent-bar textarea, #agent-bar input[type=text]")).toBeNull();
    expect($("#agent-note")).toBeNull();
    expect($("#agent-note-field")).toBeNull();
    expect($("#agent-note-send")).toBeNull();
    expect($("#agent-bar").textContent).not.toMatch(/note for the agent/i);
  });
});

describe("where it shows", () => {
  it("the Design System view and Use Cases have no right column: the shell says so for the stylesheet", async () => {
    await boot();
    for (const view of ["design-system", "usecases", "board", "screens"]) {
      tab(view).click();
      await flush();
      expect($("#app").dataset.shellView).toBe(view);
    }
  });
});
