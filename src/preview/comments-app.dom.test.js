// @vitest-environment jsdom
//
// End to end through app.js: the right panel's collapse label (CHR-913), the Notes panel for a tag-only screen, and the canvas comments (CHR-1248: pins, popover, comment mode, the sidebar count row).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

const SCREENS = [
  { name: "one", tags: [], notes: "" },
  { name: "two", tags: ["alpha", "beta"], notes: "" },
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

let threadData;
let posts;

function stubDaemon() {
  threadData = { comments: [], threads: [] };
  posts = [];
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url, init) => {
    const path = String(url).split("?")[0];
    if (path === "/api/comments" && init?.method === "POST") {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 201, json: async () => ({}), text: async () => "" };
    }
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens: SCREENS });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json(threadData);
    if (path === "/api/tools/get_screen") return json({ nodes: [] });
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<div id="root">${path}</div>` };
    return json({});
  });
}

// jsdom has no HTMLDialogElement.show()/close(); the comment popover is a non-modal <dialog>.
HTMLDialogElement.prototype.show ??= function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close ??= function () { this.removeAttribute("open"); };

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);

async function boot(lastScreen) {
  localStorage.setItem("artisign.last-screen:/p", lastScreen);
  await import("./app.js");
  await flush();
}

beforeEach(() => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  stubDaemon();
});
// app.js registers document-level listeners on import; drop them between tests so a previous boot's handlers do not also react.
let documentListeners = [];
const nativeAddEventListener = document.addEventListener.bind(document);
beforeEach(() => {
  documentListeners = [];
  document.addEventListener = (type, fn, opts) => {
    documentListeners.push([type, fn, opts]);
    nativeAddEventListener(type, fn, opts);
  };
});
afterEach(() => {
  for (const [type, fn, opts] of documentListeners) document.removeEventListener(type, fn, opts);
  document.addEventListener = nativeAddEventListener;
  vi.unstubAllGlobals();
});

describe("right panel collapse button", () => {
  it("names the active tab in label and tooltip, also after collapse and expand", async () => {
    memoryStorage.set("artisign.inspector.collapsed", "false");
    await boot("one");
    const btn = $("#inspector-collapse");
    const names = () => [btn.getAttribute("aria-label"), btn.dataset.tooltip];
    expect(names()).toEqual(["Collapse Elements panel", "Collapse Elements panel"]);
    $("#panel-tab-activity").click();
    expect(names()).toEqual(["Collapse Activity panel", "Collapse Activity panel"]);
    btn.click();
    expect(names()).toEqual(["Expand Activity panel", "Expand Activity panel"]);
    btn.click();
    expect(names()).toEqual(["Collapse Activity panel", "Collapse Activity panel"]);
    $("#panel-tab-elements").click();
    expect(names()).toEqual(["Collapse Elements panel", "Collapse Elements panel"]);
  });
});

const TS = "2026-11-26T10:00:00.000Z";
function seedThreads() {
  threadData = {
    comments: [
      { id: "c1", screen: "one", node_id: "one.card-goal", text: "Clamp the goal text", author: "human", parent_id: null, resolved: false, ts: TS },
      { id: "r1", screen: "one", node_id: "one.card-goal", text: "On it", author: "agent", agent: "ux-agent", parent_id: "c1", resolved: false, ts: TS },
      { id: "c2", screen: "one", node_id: "one.gone", text: "Old button", author: "agent", agent: "ux-agent", parent_id: null, resolved: false, ts: TS },
      { id: "c3", screen: "one", node_id: "one.card-goal", text: "Done earlier", author: "human", parent_id: null, resolved: true, ts: TS },
    ],
    threads: [
      { id: "c1", node_id: "one.card-goal", author: "human", status: "open", detached: false, reply_count: 1 },
      { id: "c2", node_id: "one.gone", author: "agent", agent: "ux-agent", status: "open", detached: true, reply_count: 0 },
      { id: "c3", node_id: "one.card-goal", author: "human", status: "resolved", detached: false, reply_count: 0 },
    ],
  };
}

/** Puts a screen document into the frame and fires its load, as a real srcdoc render would. */
function loadFrame() {
  const frame = $("#screen-frame");
  frame.contentDocument.body.innerHTML = '<div id="root"><p id="card-goal">Goal</p><p id="card-trigger"><span>Trigger</span></p></div>';
  frame.dispatchEvent(new Event("load"));
  return frame.contentDocument;
}

const pins = () => [...document.querySelectorAll(".comment-pin")];
const popover = () => $(".comment-popover");
const enter = (el, init = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
const escape = (el = document.body) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

describe("canvas comments", () => {
  it("shows one numbered pin per open thread, kind and detached state, with an accessible name", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    expect(pins().map((p) => [p.textContent, p.dataset.kind, p.dataset.state, p.getAttribute("aria-label")])).toEqual([
      ["1", "human", "open", "Comment 1 on card-goal"],
      ["2", "agent", "detached", "Comment 2 on gone, detached"],
    ]);
    expect(pins().every((p) => p.tagName === "BUTTON")).toBe(true);
    expect($("#comments-row-label").textContent).toBe("2 open comments");
    expect($("#comments-row-hint").textContent).toBe("1 detached · shown on canvas");
  });

  it("the sidebar row reads No open comments without threads", async () => {
    await boot("one");
    loadFrame();
    expect($("#comments-row-label").textContent).toBe("No open comments");
    expect($("#comments-row-hint").hidden).toBe(true);
    expect(pins()).toEqual([]);
  });

  it("the sidebar row turns comment mode on and focuses the first pin", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    $("#comments-row").click();
    expect($("#comment-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(pins()[0]);
    expect($("#comment-banner").hidden).toBe(false);
  });

  it("a pin opens its thread: messages with author, kind badge and time; one popover at a time", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    pins()[0].click();
    expect(popover().open).toBe(true);
    expect($(".comment-popover-header b").textContent).toBe("#1");
    expect($(".comment-popover-node").textContent).toBe("card-goal");
    const metas = [...document.querySelectorAll(".comment-message-meta")].map((m) => [m.querySelector("b").textContent, m.querySelector(".comment-badge").textContent]);
    expect(metas).toEqual([["You", "Human"], ["ux-agent", "Agent"]]);
    expect(pins()[0].dataset.active).toBe("true");
    expect($(".comment-target-outline").hidden).toBe(false);
    pins()[1].click();
    expect(document.querySelectorAll(".comment-popover:not([hidden])")).toHaveLength(1);
    expect($(".comment-popover-header b").textContent).toBe("#2");
    expect($(".comment-popover-alert").hidden).toBe(false); // the detached thread offers Pick element
  });

  it("Enter sends a reply, Shift+Enter does not; Esc closes and returns focus to the pin", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    pins()[0].click();
    const input = $(".comment-popover-input");
    input.value = "Two lines";
    enter(input, { shiftKey: true });
    expect(posts).toEqual([]);
    enter(input);
    await flush();
    expect(posts).toEqual([{ parent_id: "c1", text: "Two lines" }]);
    escape(input);
    expect(popover().open).toBe(false);
    expect(document.activeElement).toBe(pins()[0]);
  });

  it("Resolve posts a bare resolve; Delete asks twice", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    pins()[0].click();
    $('.comment-popover-header [aria-label="Resolve"]').click();
    await flush();
    expect(posts.at(-1)).toEqual({ parent_id: "c1", text: "", resolved: true });
    expect(document.activeElement).toBe(pins()[0]); // focus lands on a pin, not on <body>
    pins()[0].click();
    $('.comment-popover-header [aria-label="More actions"]').click();
    const del = [...document.querySelectorAll(".comment-popover-menu .chrome-menu-item")].find((b) => b.textContent.includes("Delete"));
    del.click();
    expect(posts.at(-1)).not.toHaveProperty("action");
    [...document.querySelectorAll(".comment-popover-menu .chrome-menu-item")].find((b) => b.textContent.includes("Click again")).click();
    await flush();
    expect(posts.at(-1)).toEqual({ action: "delete", comment_id: "c1" });
  });

  it("comment mode: a click on an element opens an empty popover anchored to its nearest id, and posts a new thread", async () => {
    await boot("one");
    const doc = loadFrame();
    $("#comment-mode-toggle").click();
    doc.querySelector("#card-trigger span").click(); // no id of its own: the nearest ancestor with one
    expect(popover().open).toBe(true);
    expect(popover().dataset.mode).toBe("new");
    expect($(".comment-popover-node").textContent).toBe("card-trigger");
    const input = $(".comment-popover-input");
    input.value = "Shorter copy";
    enter(input);
    await flush();
    expect(posts).toEqual([{ screen: "one", node_id: "card-trigger", text: "Shorter copy" }]);
    expect(popover().open).toBe(false);
    doc.getElementById("root").click(); // the screen root is a screen-level thread
    expect($(".comment-popover-node").textContent).toBe("screen");
  });

  it("Esc closes the popover first, the next one leaves comment mode", async () => {
    await boot("one");
    const doc = loadFrame();
    $("#comment-mode-toggle").click();
    doc.getElementById("card-goal").click();
    escape();
    expect(popover().open).toBe(false);
    expect($("#comment-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    escape();
    expect($("#comment-mode-toggle").getAttribute("aria-pressed")).toBe("false");
  });

  it("re-anchors a detached thread to the picked element", async () => {
    seedThreads();
    await boot("one");
    const doc = loadFrame();
    pins()[1].click();
    $(".comment-popover-alert button").click();
    expect($("#comment-banner").textContent).toContain("move #2");
    doc.getElementById("card-trigger").click();
    await flush();
    expect(posts).toEqual([{ action: "reanchor", comment_id: "c2", screen: "one", node_id: "card-trigger" }]);
  });

  it("the toolbar is one tab stop with arrow-key movement", async () => {
    await boot("one");
    loadFrame();
    const tools = ["#comment-tool-select", "#comment-tool-comment", "#comment-tool-resolved", "#comment-tool-hide"].map($);
    expect(tools.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);
    tools[0].focus();
    tools[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tools[3]);
    expect(tools.map((b) => b.tabIndex)).toEqual([-1, -1, -1, 0]);
  });

  it("the toolbar shows resolved pins muted, and hides pins without leaving the mode", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    $("#comment-tool-comment").click();
    $("#comment-tool-resolved").click();
    expect(pins().map((p) => p.dataset.state)).toEqual(["open", "detached", "resolved"]);
    expect(pins()[2].getAttribute("aria-label")).toBe("Comment 3 on card-goal, resolved");
    $("#comment-tool-hide").click();
    expect(pins()).toEqual([]);
    expect($("#comment-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    $("#comment-tool-select").click();
    expect($("#comment-mode-toggle").getAttribute("aria-pressed")).toBe("false");
  });

  it("never writes into the screen document", async () => {
    seedThreads();
    await boot("one");
    const doc = loadFrame();
    const before = doc.body.innerHTML;
    $("#comment-mode-toggle").click();
    pins()[0].click();
    doc.getElementById("card-goal").dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    expect(doc.body.innerHTML).toBe(before);
  });
});

describe("Notes panel", () => {
  it("shows the tag chips for a tagged screen with no notes, without an empty text band", async () => {
    await boot("two");
    expect($("#notes-panel").hidden).toBe(false);
    expect([...document.querySelectorAll("#notes-panel-chips .chrome-chip")].map((c) => c.textContent)).toEqual(["alpha", "beta"]);
    expect($("#notes-panel-text").hidden).toBe(true);
  });

  it("stays hidden for a screen with neither notes nor tags", async () => {
    await boot("one");
    expect($("#notes-panel").hidden).toBe(true);
  });
});
