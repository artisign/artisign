// @vitest-environment jsdom
//
// CHR-1263 — comment pins on the mockup columns, end to end through app.js: pins in every column, one comment mode across them, the popover with the variant's letter, count chips in the headers, whole-variant threads, re-anchoring inside the thread's own variant.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

const MOCKUPS = [
  {
    name: "cart",
    title: "Cart options",
    variants: [
      { id: "a", title: "Sticky total" },
      { id: "b", title: "Summary sheet" },
    ],
  },
];
const TS = "2026-11-26T10:00:00.000Z";

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
let commentQueries;

function stubDaemon() {
  threadData = { comments: [], threads: [] };
  posts = [];
  commentQueries = [];
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url, init) => {
    const [path, query = ""] = String(url).split("?");
    if (path === "/api/comments" && init?.method === "POST") {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 201, json: async () => ({}), text: async () => "" };
    }
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens: [{ name: "one", tags: [], notes: "" }] });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: MOCKUPS });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") {
      commentQueries.push(query);
      return json(threadData);
    }
    if (path === "/api/tools/get_screen") return json({ nodes: [] });
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<div id="root">${path}</div>` };
    return json({});
  });
}

HTMLDialogElement.prototype.show ??= function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close ??= function () { this.removeAttribute("open"); };

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);

async function boot() {
  localStorage.setItem("artisign.last-screen:/p", "mockup:cart");
  await import("./app.js");
  await flush();
}

/** Puts each column's variant document in place and fires its load, as a real srcdoc render would. */
function loadColumns() {
  const docs = {};
  const frames = [...document.querySelectorAll(".mockup-column-frame")];
  frames.forEach((frame, i) => {
    frame.contentDocument.body.innerHTML = i === 0
      ? '<div id="a-card"><span id="a-price">1</span><em>plain</em></div><p>no id</p>'
      : '<div id="b-card"></div>';
    frame.dispatchEvent(new Event("load"));
    docs[["a", "b"][i]] = frame.contentDocument;
  });
  return docs;
}

beforeEach(() => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  stubDaemon();
});
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

const ref = (variant, id) => `mockup:cart#${variant}.${id}`;
function seedThreads() {
  threadData = {
    comments: [
      { id: "c1", mockup: "cart", variant: "a", node_id: ref("a", "a-card"), text: "Too heavy", author: "human", parent_id: null, resolved: false, ts: TS },
      { id: "c2", mockup: "cart", variant: "b", node_id: ref("b", "b-gone"), text: "Missing row", author: "agent", agent: "ux-agent", parent_id: null, resolved: false, ts: TS },
      { id: "c3", mockup: "cart", variant: "b", node_id: null, text: "Whole variant", author: "human", parent_id: null, resolved: false, ts: TS },
      { id: "c4", mockup: "cart", variant: "a", node_id: ref("a", "a-price"), text: "Done", author: "human", parent_id: null, resolved: true, ts: TS },
    ],
    threads: [
      { id: "c1", variant: "a", node_id: ref("a", "a-card"), author: "human", status: "open", detached: false, reply_count: 0 },
      { id: "c2", variant: "b", node_id: ref("b", "b-gone"), author: "agent", agent: "ux-agent", status: "open", detached: true, reply_count: 0 },
      { id: "c3", variant: "b", node_id: null, author: "human", status: "open", detached: false, reply_count: 0 },
      { id: "c4", variant: "a", node_id: ref("a", "a-price"), author: "human", status: "resolved", detached: false, reply_count: 0 },
    ],
  };
}

const pins = () => [...document.querySelectorAll(".comment-pin")];
const chips = (column) => [...document.querySelectorAll(".mockup-column")[column].querySelectorAll(".comment-count-chip")];
const popover = () => $(".comment-popover");
const enter = (el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

describe("mockup comments", () => {
  it("reads the mockup's threads and shows one pin per open thread in every column, numbered across the mockup", async () => {
    seedThreads();
    await boot();
    loadColumns();
    expect(commentQueries.at(-1)).toContain("mockup=cart");
    expect(pins().map((p) => [p.textContent, p.dataset.variant, p.dataset.state, p.getAttribute("aria-label")])).toEqual([
      ["1", "a", "open", "Comment 1 on A, a-card"],
      ["2", "b", "detached", "Comment 2 on B, b-gone, detached"],
      ["3", "b", "open", "Comment 3 on B"],
    ]);
    expect($("#mockup-comment-layer").contains(pins()[0])).toBe(true);
    expect($("#comment-count-badge").textContent).toBe("3");
    expect($("#comment-count-badge").hidden).toBe(false);
  });

  it("each column header carries its count chips; the Resolved tab adds the resolved one", async () => {
    seedThreads();
    await boot();
    loadColumns();
    expect(chips(0).map((c) => [c.dataset.kind, c.getAttribute("aria-label")])).toEqual([["open", "1 open comment"]]);
    expect(chips(1).map((c) => [c.dataset.kind, c.getAttribute("aria-label")])).toEqual([
      ["open", "1 open comment"],
      ["detached", "1 detached comment"],
    ]);
    $("#comments-tool-toggle").click();
    $("#comments-tab-resolved").click();
    expect(chips(0).map((c) => c.dataset.kind)).toEqual(["open", "resolved"]);
    expect(pins().map((p) => p.dataset.state)).toContain("resolved");
  });

  it("a pin opens its thread with the variant's letter in the header; a chip opens its first thread", async () => {
    seedThreads();
    await boot();
    loadColumns();
    pins()[0].click();
    expect(popover().open).toBe(true);
    expect($(".comment-popover-header .comment-variant-badge").textContent).toBe("A");
    expect($(".comment-popover-node").textContent).toBe("a-card");
    chips(1)[1].click(); // detached chip of column B
    expect($(".comment-popover-alert").textContent).toContain("b-gone no longer exists in variant B");
    expect(chips(1)[1].getAttribute("aria-expanded")).toBe("true");
  });

  it("comment mode spans all columns: a click picks the nearest authored id, none gives a whole-variant thread, and the post names mockup and variant", async () => {
    await boot();
    const docs = loadColumns();
    expect($("#comment-mode-toggle").getAttribute("aria-disabled")).toBeNull();
    $("#comment-mode-toggle").click();
    expect($("#comment-banner").dataset.placement).toBe("bottom");
    docs.a.querySelector("em").click();
    expect($(".comment-popover-node").textContent).toBe("a-card");
    expect($(".comment-popover-header .comment-variant-badge").textContent).toBe("A");
    const input = $(".comment-popover-input");
    input.value = "Shorter";
    enter(input);
    await flush();
    expect(posts).toEqual([{ mockup: "cart", variant: "a", node_id: "a-card", text: "Shorter" }]);
    docs.a.querySelector("p").click();
    expect($(".comment-popover-node").textContent).toBe("variant");
    const second = $(".comment-popover-input");
    second.value = "General";
    enter(second);
    await flush();
    expect(posts.at(-1)).toEqual({ mockup: "cart", variant: "a", node_id: null, text: "General" });
    docs.b.getElementById("b-card").click();
    expect($(".comment-popover-header .comment-variant-badge").textContent).toBe("B");
  });

  it("re-anchors only inside the thread's own variant", async () => {
    seedThreads();
    await boot();
    const docs = loadColumns();
    pins()[1].click();
    $(".comment-popover-alert button").click();
    docs.a.getElementById("a-card").click(); // another variant: ignored
    await flush();
    expect(posts).toEqual([]);
    docs.b.getElementById("b-card").click();
    await flush();
    expect(posts).toEqual([{ action: "reanchor", comment_id: "c2", mockup: "cart", variant: "b", node_id: "b-card" }]);
  });

  it("never writes into the variant documents", async () => {
    seedThreads();
    await boot();
    const docs = loadColumns();
    const before = docs.a.documentElement.outerHTML;
    $("#comment-mode-toggle").click();
    pins()[0].click();
    docs.a.getElementById("a-card").dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(docs.a.documentElement.outerHTML).toBe(before);
  });

  it("a count chip still opens its thread while another popover is open (pointerdown first, then click)", async () => {
    seedThreads();
    await boot();
    loadColumns();
    pins()[0].click();
    expect(popover().open).toBe(true);
    const chip = chips(1)[1]; // detached chip of column B
    chip.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    expect(document.contains(chip)).toBe(true); // not rebuilt by the press
    chip.click();
    expect($(".comment-popover-alert").textContent).toContain("b-gone");
  });

  it("the banner names any variant on a mockup and keeps the screen text on a screen", async () => {
    await boot();
    loadColumns();
    $("#comment-mode-toggle").click();
    expect($("#comment-banner").textContent).toContain("click an element in any variant to start a thread");
  });

  it("dims the other columns while a re-anchor pick waits", async () => {
    seedThreads();
    await boot();
    loadColumns();
    expect(document.querySelectorAll(".comment-dim")).toHaveLength(0);
    pins()[1].click();
    $(".comment-popover-alert button").click();
    expect(document.querySelectorAll("#mockup-comment-layer .comment-dim")).toHaveLength(1); // A dims, B (the thread's own) does not
  });

  it("a thread whose variant is gone stays reachable as a detached pin in the first column and counts in its detached chip", async () => {
    seedThreads();
    threadData.comments.push({ id: "c9", mockup: "cart", variant: "gone", node_id: ref("gone", "x"), text: "Orphan", author: "human", parent_id: null, resolved: false, ts: TS });
    threadData.threads.push({ id: "c9", variant: "gone", node_id: ref("gone", "x"), author: "human", status: "open", detached: true, reply_count: 0 });
    await boot();
    const docs = loadColumns();
    const orphan = pins().find((p) => p.dataset.variant === "gone");
    expect(orphan.dataset.state).toBe("detached");
    expect(chips(0).map((c) => c.getAttribute("aria-label"))).toEqual(["1 open comment", "1 detached comment"]);
    orphan.click();
    expect(popover().open).toBe(true);
    $(".comment-popover-alert button").click();
    docs.b.getElementById("b-card").click(); // any frame takes it
    await flush();
    expect(posts).toEqual([{ action: "reanchor", comment_id: "c9", mockup: "cart", variant: "b", node_id: "b-card" }]);
  });
});
