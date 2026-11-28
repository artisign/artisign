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
    expect($("#comment-count-badge").textContent).toBe("2");
    expect($("#comment-count-badge").hidden).toBe(false);
    expect($("#comments-tool-toggle").getAttribute("aria-label")).toBe("Comments, 2 open"); // the count is the Comments tool's badge
    expect($("#comments-tool-toggle").contains($("#comment-count-badge"))).toBe(true);
    expect($("#comment-mode-toggle").getAttribute("aria-label")).toBe("Comment");
  });

  it("the Comments tool carries no count without threads", async () => {
    await boot("one");
    loadFrame();
    expect($("#comment-count-badge").hidden).toBe(true);
    expect($("#comments-tool-toggle").getAttribute("aria-label")).toBe("Comments");
    expect(pins()).toEqual([]);
  });

  it("the Comment tool turns comment mode on and shows the banner; there is no floating canvas toolbar any more (CHR-1268)", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    expect($("#comment-toolbar")).toBeNull();
    $("#comment-mode-toggle").click();
    expect($("#comment-mode-toggle").getAttribute("aria-pressed")).toBe("true");
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

  it("the tool bar is one vertical toolbar and one tab stop, arrows walk down and up (the roving fallback where the browser has no focusgroup)", async () => {
    await boot("one");
    loadFrame();
    const bar = $("#tool-bar");
    expect([bar.getAttribute("role"), bar.getAttribute("aria-orientation"), bar.getAttribute("focusgroup")]).toEqual(["toolbar", "vertical", "toolbar wrap block"]);
    const all = [...document.querySelectorAll("#tool-bar-tools .tool-btn")];
    // The Board's own tools are in the bar but hidden here (CHR-1283), so they are neither a tab stop nor an arrow-key stop. Canvas tools first, then the panel tools (CHR-1288); no Design system button (CHR-1284).
    expect(all.filter((b) => b.hidden).map((b) => b.id)).toEqual(["board-clusters-toggle", "board-collapse-all-btn"]);
    const tools = all.filter((b) => !b.hidden);
    expect(tools.map((b) => b.id)).toEqual(["comment-mode-toggle", "inspect-mode-toggle", "flow-mode-toggle", "notes-tool-toggle", "comments-tool-toggle", "resolved-toggle"]);
    expect(document.getElementById("design-system-tool")).toBeNull();
    expect([...$("#tool-bar-tools").children].map((el) => el.id).filter(Boolean).indexOf("tool-group-sep")).toBe(5); // the divider sits after the canvas group
    expect(all.map((b) => b.tabIndex).filter((i) => i === 0)).toHaveLength(1);
    expect(tools.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    tools[0].focus();
    tools[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tools[5]); // wraps
    tools[5].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tools[0]);
    expect(tools.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
  });

  it("the Comments tool opens the thread list: detached first, then the log order; a row opens that thread's popover", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    expect($("#tool-panel").hidden).toBe(true);
    $("#comments-tool-toggle").click();
    expect($("#tool-panel").hidden).toBe(false);
    expect($("#tool-panel-title").textContent).toBe("Comments");
    expect($("#tool-panel-context").textContent).toBe("one");
    expect($("#comments-tool-toggle").getAttribute("aria-pressed")).toBe("true");
    expect($("#comments-count-open").textContent).toBe("2");
    expect($("#comments-count-resolved").textContent).toBe("1");
    const rows = [...document.querySelectorAll("#comments-list .comment-row")];
    expect(rows.map((r) => [r.dataset.thread, r.dataset.state, r.querySelector(".comment-row-node").textContent, r.querySelector(".comment-row-text").textContent])).toEqual([
      ["c2", "detached", "gone", "ux-agent: Old button"],
      ["c1", "open", "card-goal", "ux-agent: On it"], // the last message of the thread
    ]);
    expect(rows[0].querySelector(".comment-row-tag").textContent).toBe("Detached");
    rows[1].click();
    expect(popover().open).toBe(true);
    expect($(".comment-popover-header b").textContent).toBe("#1");
    expect(document.querySelector("#comments-list .comment-row.is-active").dataset.thread).toBe("c1");
    expect($("#comments-foot").textContent).toContain("Detached threads lost their element");
  });

  it("a row opens its thread even while another popover is open: the press does not close it first and rebuild the row away from the click", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    $("#comments-tool-toggle").click();
    pins()[0].click(); // #1 is open
    const row = $('#comments-list .comment-row[data-thread="c2"]');
    row.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(popover().open).toBe(true); // still there: the row is not an "outside" press
    expect($('#comments-list .comment-row[data-thread="c2"]')).toBe(row); // and the same element is still in the list
    row.click();
    expect($(".comment-popover-header b").textContent).toBe("#2");
    expect($("#comments-list .comment-row.is-active").dataset.thread).toBe("c2");
    expect($("#comments-list .comment-row.is-active").getAttribute("aria-current")).toBe("true");
    $(".comment-popover-header [aria-label=\"Close\"]")?.click();
    expect(document.querySelector("#comments-list .comment-row.is-active")).toBeNull();
  });

  it("Resolved lists the resolved threads and puts a check pin on each; Open takes them away again", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    $("#comments-tool-toggle").click();
    expect(pins().map((p) => p.dataset.state)).toEqual(["open", "detached"]);
    $("#comments-tab-resolved").click();
    expect($("#comments-tab-resolved").getAttribute("aria-selected")).toBe("true");
    expect([...document.querySelectorAll("#comments-list .comment-row")].map((r) => [r.dataset.thread, r.dataset.state])).toEqual([["c3", "resolved"]]);
    expect(pins().map((p) => p.dataset.state)).toEqual(["open", "detached", "resolved"]);
    expect(pins()[2].getAttribute("aria-label")).toBe("Comment 3 on card-goal, resolved");
    $("#comments-tab-open").click();
    expect(pins().map((p) => p.dataset.state)).toEqual(["open", "detached"]);
  });

  it("resolved pins show only while the Comments panel's Resolved tab is open: not after closing the panel, not after a reload", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    $("#comments-tool-toggle").click();
    $("#comments-tab-resolved").click();
    expect(pins().map((p) => p.dataset.state)).toContain("resolved");
    $("#tool-panel-close").click();
    expect(pins().map((p) => p.dataset.state)).toEqual(["open", "detached"]);
    $("#comments-tool-toggle").click(); // the tab is still Resolved
    expect(pins().map((p) => p.dataset.state)).toContain("resolved");
    $("#notes-tool-toggle").click(); // another panel replaces it
    expect(pins().map((p) => p.dataset.state)).not.toContain("resolved");
  });

  it("the Open | Resolved tabs are a tablist: arrows and Home/End move between them", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    $("#comments-tool-toggle").click();
    const key = (k) => $("#comments-tabs").dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    key("ArrowRight");
    expect([$("#comments-tab-resolved").getAttribute("aria-selected"), $("#comments-tab-resolved").tabIndex, document.activeElement.id]).toEqual(["true", 0, "comments-tab-resolved"]);
    key("ArrowLeft");
    expect([$("#comments-tab-open").getAttribute("aria-selected"), document.activeElement.id]).toEqual(["true", "comments-tab-open"]);
    key("End");
    expect($("#comments-tab-resolved").getAttribute("aria-selected")).toBe("true");
    key("Home");
    expect($("#comments-tab-open").getAttribute("aria-selected")).toBe("true");
  });

  it("resolving the last pin with the Comments panel open puts focus back on the Comments tool", async () => {
    seedThreads();
    threadData.threads = threadData.threads.filter((t) => t.id === "c1");
    threadData.comments = threadData.comments.filter((c) => c.id === "c1" || c.parent_id === "c1");
    await boot("one");
    loadFrame();
    $("#comments-tool-toggle").click();
    $("#comments-list .comment-row").click(); // opened from its row
    threadData.threads[0].status = "resolved";
    $('.comment-popover-header [aria-label="Resolve"]').click();
    await flush();
    expect(document.activeElement.id).toBe("comments-tool-toggle"); // the row went with the thread
  });

  it("resolving the last pin puts focus back on the Comment tool when no panel is open", async () => {
    seedThreads();
    threadData.threads = threadData.threads.filter((t) => t.id === "c1");
    threadData.comments = threadData.comments.filter((c) => c.id === "c1" || c.parent_id === "c1");
    await boot("one");
    loadFrame();
    pins()[0].click();
    threadData.threads[0].status = "resolved"; // what the daemon answers after the resolve
    $('.comment-popover-header [aria-label="Resolve"]').click();
    await flush();
    expect(pins()).toEqual([]);
    expect(document.activeElement.id).toBe("comment-mode-toggle");
  });

  it("leaving for the Design System view also ends inspect and flow mode (their tools are greyed out there)", async () => {
    await boot("one");
    loadFrame();
    $("#inspect-mode-toggle").click();
    $('[data-view="design-system"]').click();
    await flush();
    expect($("#inspect-mode-toggle").getAttribute("aria-pressed")).toBe("false");
    expect($("#tool-panel").hidden).toBe(true);
    $('[data-view="screens"]').click();
    await flush();
    $("#flow-mode-toggle").click();
    $('[data-view="design-system"]').click();
    await flush();
    expect($("#flow-mode-toggle").getAttribute("aria-pressed")).toBe("false");
  });

  it("Show resolved is a switch in the Screens view; its tooltip count is the Resolved tab's (CHR-1292)", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    const toggle = $("#resolved-toggle");
    expect(pins()).toHaveLength(2); // open and detached
    expect(toggle.dataset.tooltip).toBe("Show resolved comments (1)");
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(pins()).toHaveLength(3);
    expect($("#tool-toast").hidden).toBe(true);
    expect(toggle.dataset.tooltip).toBe("Hide resolved comments (1)");
    $("#comments-tool-toggle").click();
    expect($("#comments-count-resolved, #comments-tab-resolved").textContent).toContain("1"); // the tab counts the same threads
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(pins()).toHaveLength(2);
  });

  it("Show resolved with 0 resolved comments: the click still switches, the button shows it, a hint says why nothing appears (CHR-1292)", async () => {
    seedThreads();
    threadData.threads = threadData.threads.filter((t) => t.status !== "resolved");
    threadData.comments = threadData.comments.filter((c) => !c.resolved);
    await boot("one");
    loadFrame();
    const again = $("#resolved-toggle");
    expect(again.dataset.tooltip).toBe("Show resolved comments (0)");
    again.click();
    expect(again.getAttribute("aria-pressed")).toBe("true");
    expect($("#tool-toast").textContent).toBe("No resolved comments on this screen");
    expect($("#tool-toast").hidden).toBe(false);
  });

  it("the tool keys keep working while the tool bar is folded", async () => {
    await boot("one");
    loadFrame();
    $("#tool-bar-fold").click();
    expect($("#tool-bar").dataset.collapsed).toBe("true");
    const press = (k) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    press("c");
    expect($("#comment-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    press("n");
    expect($("#tool-panel-title").textContent).toBe("Notes");
    press("m");
    expect($("#tool-panel-title").textContent).toBe("Comments");
    press("f");
    expect($("#flow-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    press("d"); // CHR-1284: D is unassigned
    await flush();
    expect($('[data-view="design-system"]').getAttribute("aria-pressed")).not.toBe("true");
    press("3");
    await flush();
    expect($('[data-view="design-system"]').getAttribute("aria-pressed")).toBe("true");
  });

  it("closing the panel returns focus to its tool; Esc closes it after a mode; one panel at a time", async () => {
    seedThreads();
    await boot("one");
    loadFrame();
    $("#comments-tool-toggle").click();
    $("#tool-panel-close").click();
    expect($("#tool-panel").hidden).toBe(true);
    expect($("#comments-tool-toggle").getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe($("#comments-tool-toggle"));
    $("#comments-tool-toggle").click();
    $("#notes-tool-toggle").click(); // replaces it
    expect($("#tool-panel-title").textContent).toBe("Notes");
    expect([$("#comments-panel").hidden, $("#notes-panel").hidden]).toEqual([true, false]);
    expect([$("#comments-tool-toggle"), $("#notes-tool-toggle")].map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    escape();
    expect($("#tool-panel").hidden).toBe(true);
  });

  it("Inspect is the panel of inspect mode: mode and panel open and close together, and another panel ends the mode", async () => {
    await boot("one");
    loadFrame();
    $("#inspect-mode-toggle").click();
    expect($("#tool-panel-title").textContent).toBe("Inspect");
    expect($("#inspect-panel").hidden).toBe(false);
    $("#tool-panel-close").click();
    expect($("#inspect-mode-toggle").getAttribute("aria-pressed")).toBe("false");
    expect($("#tool-panel").hidden).toBe(true);
    $("#inspect-mode-toggle").click();
    $("#notes-tool-toggle").click();
    expect($("#inspect-mode-toggle").getAttribute("aria-pressed")).toBe("false");
    expect($("#tool-panel-title").textContent).toBe("Notes");
    $("#flow-mode-toggle").click(); // modes stay exclusive: flow does not touch the open Notes panel
    expect($("#tool-panel-title").textContent).toBe("Notes");
    $("#inspect-mode-toggle").click();
    expect($("#flow-mode-toggle").getAttribute("aria-pressed")).toBe("false");
    expect($("#tool-panel-title").textContent).toBe("Inspect");
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

describe("Notes panel (CHR-1268)", () => {
  it("shows the tag chips for a tagged screen with no notes, without an empty text band", async () => {
    await boot("two");
    $("#notes-tool-toggle").click();
    expect($("#notes-panel").hidden).toBe(false);
    expect($("#tool-panel-context").textContent).toBe("two");
    expect([...document.querySelectorAll("#notes-panel-chips .chrome-chip")].map((c) => c.textContent)).toEqual(["alpha", "beta"]);
    expect($("#notes-panel-text").hidden).toBe(true);
    expect($("#notes-panel-empty").hidden).toBe(true);
  });

  it("says so for a screen with neither notes, tags, tag notes nor use cases", async () => {
    await boot("one");
    $("#notes-tool-toggle").click();
    expect($("#notes-panel-empty").hidden).toBe(false);
  });
});
