// @vitest-environment jsdom
//
// CHR-1269 — the Agent bar card on its own (the real index.html markup, no daemon): folding by the user and by a panel, the Follow switch, the feed, and the note field's behaviour.
import { describe, it, expect, beforeEach, vi } from "vitest";
import html from "./index.html?raw";
import { createAgentBar } from "./agent-bar.js";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k), map };
}

const NOW = 5_000_000;
const screenNote = { enabled: true, key: "screen:home", icon: "desktop_windows", scope: "On home", reason: "" };
const feedOf = (...events) => events.map((e, i) => ({ tool: "write_html", kind: "write", ok: true, target: { kind: "screen", name: "home" }, nodes: [], at: NOW - i * 1000, ...e }));

let storage;
let calls;
let bar;
let state;
const $ = (sel) => document.querySelector(sel);

function mount(over = {}) {
  document.body.innerHTML = bodyHtml;
  storage = storage ?? memoryStorage();
  calls = { follow: [], resume: 0, select: [], send: [] };
  bar = createAgentBar({
    barEl: $("#agent-bar"),
    storage,
    onFollow: (on) => calls.follow.push(on),
    onResume: () => calls.resume++,
    onSelect: (event) => calls.select.push(event),
    onSend: async (text, key) => {
      calls.send.push([text, key]);
      return over.sendResult ?? { ok: true };
    },
  });
  state = { feed: [], follow: { enabled: false, paused: false }, connected: true, now: NOW, exists: () => true, note: screenNote };
  bar.render(state);
}
const render = (patch = {}) => bar.render((state = { ...state, ...patch }));
const typeNote = (text) => {
  const field = $("#agent-note-field");
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
};
const enter = (init = {}) => {
  const evt = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  $("#agent-note-field").dispatchEvent(evt);
  return evt;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  storage = memoryStorage();
  mount();
});

describe("status and feed", () => {
  it("starts idle with the empty feed state", () => {
    expect($("#agent-status").dataset.look).toBe("idle");
    expect($("#agent-status-text").textContent).toBe("Idle");
    expect($("#agent-feed-empty").hidden).toBe(false);
    expect($("#agent-feed").hidden).toBe(true);
  });

  it("shows the newest entry as the agent's present, in the status and in the folded head", () => {
    render({ feed: feedOf({}) });
    expect($("#agent-status").dataset.look).toBe("active");
    expect($("#agent-status-text").textContent).toBe("Writing home");
    expect($("#agent-status-text b").textContent).toBe("home");
    expect($("#agent-bar-folded-text").textContent).toBe("Writing home");
    expect($("#agent-feed-empty").hidden).toBe(true);
  });

  it("hands a clicked row's event to onSelect", () => {
    const feed = feedOf({});
    render({ feed });
    $("button.agent-activity").click();
    expect(calls.select).toEqual([feed[0]]);
  });

  it("offline: the chip, the status and the dimmed feed say so", () => {
    render({ feed: feedOf({}), connected: false });
    expect($("#agent-bar").dataset.connection).toBe("offline");
    expect($("#connection-label").textContent).toBe("Offline");
    expect($("#agent-status-text").textContent).toBe("Waiting for the connection");
    expect($("#agent-status-detail").textContent).toBe("Last activity now");
  });
});

describe("Follow", () => {
  it("the switch is a native checkbox with role switch, labelled, and reports its change", () => {
    const sw = $("#follow-switch");
    expect([sw.tagName, sw.type, sw.getAttribute("role")]).toEqual(["INPUT", "checkbox", "switch"]);
    expect($("#follow-label").getAttribute("for")).toBe("follow-switch");
    expect($("#follow-label").textContent).toContain("Follow the agent");
    sw.click();
    expect(calls.follow).toEqual([true]);
  });

  it("reflects the follow state: on, off", () => {
    render({ follow: { enabled: true, paused: false } });
    expect($("#follow-switch").checked).toBe(true);
    render({ follow: { enabled: false, paused: false } });
    expect($("#follow-switch").checked).toBe(false);
  });

  it("paused: Resume takes the switch's place and resumes", () => {
    render({ follow: { enabled: true, paused: true }, feed: feedOf({}) });
    expect($("#agent-follow-row").hidden).toBe(true);
    expect($("#agent-follow-paused-row").hidden).toBe(false);
    expect($("#agent-follow-paused-row").textContent).toContain("Follow paused");
    expect($("#agent-status-detail").textContent).toBe("You moved away, so the canvas stays where you are");
    $("#follow-resume").click();
    expect(calls.resume).toBe(1);
  });
});

describe("folding", () => {
  const folded = () => $("#agent-bar").dataset.collapsed === "true";

  it("the chevron folds and unfolds, remembered per viewer", () => {
    expect(folded()).toBe(false);
    $("#agent-bar-fold").click();
    expect([folded(), $("#agent-bar-fold").getAttribute("aria-expanded"), $("#agent-bar-fold").getAttribute("aria-label")]).toEqual([true, "false", "Unfold Agent bar"]);
    expect($("#agent-bar-folded-status").hidden).toBe(false);
    expect(storage.map.get("artisign.agent-bar.collapsed")).toBe("true");
    mount(); // a reload
    expect(folded()).toBe(true);
    $("#agent-bar-fold").click();
    expect(folded()).toBe(false);
  });

  it("folds by itself while a panel is open, unfolds when it closes, and stores nothing for it", () => {
    bar.setPanelOpen(true);
    expect([folded(), $("#agent-bar").dataset.panelFold]).toEqual([true, "true"]);
    expect(storage.map.has("artisign.agent-bar.collapsed")).toBe(false);
    bar.setPanelOpen(false);
    expect([folded(), $("#agent-bar").dataset.panelFold]).toEqual([false, "false"]);
  });

  it("while a panel holds it folded, the chevron is aria-disabled, says why, and does nothing", () => {
    bar.setPanelOpen(true);
    const fold = $("#agent-bar-fold");
    expect(fold.getAttribute("aria-disabled")).toBe("true");
    expect(fold.getAttribute("aria-label")).toBe("Agent bar is folded while a panel is open");
    fold.click();
    expect(folded()).toBe(true);
    bar.setPanelOpen(false);
    expect(folded()).toBe(false); // the click did not stick as a user fold
    expect(fold.hasAttribute("aria-disabled")).toBe(false);
  });

  it("a bar the user folded stays folded after the panel closes", () => {
    $("#agent-bar-fold").click();
    bar.setPanelOpen(true);
    bar.setPanelOpen(false);
    expect(folded()).toBe(true);
  });

  it("focus inside the body that folds away moves to the chevron, not to the page", () => {
    $("#agent-note-field").focus();
    bar.setPanelOpen(true);
    expect(document.activeElement).toBe($("#agent-bar-fold"));
  });
});

describe("the note field", () => {
  it("is labelled, scoped, and sends on the button with the scope it showed", async () => {
    expect($("#agent-note-field").getAttribute("placeholder")).toBe("Leave a note for the agent");
    expect($("#agent-note-scope-text").textContent).toBe("On home");
    typeNote("  Make the button smaller  ");
    $("#agent-note-send").click();
    await flush();
    expect(calls.send).toEqual([["Make the button smaller", "screen:home"]]);
    expect($("#agent-note-field").value).toBe("");
  });

  it("Enter sends, Shift+Enter does not, and an Enter that confirms an IME conversion does not", async () => {
    typeNote("one");
    expect(enter({ shiftKey: true }).defaultPrevented).toBe(false); // a new line
    enter({ isComposing: true });
    enter({ keyCode: 229 });
    await flush();
    expect(calls.send).toEqual([]);
    expect(enter().defaultPrevented).toBe(true);
    await flush();
    expect(calls.send).toEqual([["one", "screen:home"]]);
  });

  it("sends nothing when empty, and send is aria-disabled until there is text", async () => {
    expect($("#agent-note-send").getAttribute("aria-disabled")).toBe("true");
    $("#agent-note-send").click();
    enter();
    await flush();
    expect(calls.send).toEqual([]);
    typeNote("hi");
    expect($("#agent-note-send").getAttribute("aria-disabled")).toBe("false");
  });

  it("a failed send keeps the text and says what went wrong", async () => {
    mount({ sendResult: { ok: false, message: "screen not found" } });
    typeNote("hello");
    $("#agent-note-send").click();
    await flush();
    expect($("#agent-note-field").value).toBe("hello");
    expect($("#agent-note-error").hidden).toBe(false);
    expect($("#agent-note-error").textContent).toBe("Could not send the note: screen not found");
    typeNote("hello again");
    expect($("#agent-note-error").hidden).toBe(true);
  });

  it("is off with a reason where no single screen can take it: read-only, aria-disabled, still focusable, nothing sent", async () => {
    render({ note: { enabled: false, key: "board", icon: "grid_view", scope: "On the Board, 5 screens", reason: "Not available on the Board" } });
    const field = $("#agent-note-field");
    expect([field.readOnly, field.getAttribute("aria-disabled"), field.disabled, field.placeholder]).toEqual([true, "true", false, "Not available on the Board"]);
    expect($("#agent-note-reason").textContent).toBe("Not available on the Board");
    expect($("#agent-note-scope-text").textContent).toBe("On the Board, 5 screens");
    field.focus();
    expect(document.activeElement).toBe(field);
    enter();
    $("#agent-note-send").click();
    await flush();
    expect(calls.send).toEqual([]);
  });

  it("each scope keeps its own unsent text: a note typed for one screen never lands on the next one", async () => {
    typeNote("for home");
    render({ note: { ...screenNote, key: "screen:cart", scope: "On cart" } }); // follow moved the open screen
    expect($("#agent-note-field").value).toBe("");
    typeNote("for cart");
    render({ note: screenNote });
    expect($("#agent-note-field").value).toBe("for home");
    $("#agent-note-send").click();
    await flush();
    expect(calls.send).toEqual([["for home", "screen:home"]]);
  });

  it("a note sent for one screen does not clear what is typed on another by the time the answer comes", async () => {
    let finish;
    document.body.innerHTML = bodyHtml;
    bar = createAgentBar({ barEl: $("#agent-bar"), storage, onFollow() {}, onResume() {}, onSelect() {}, onSend: () => new Promise((r) => (finish = r)) });
    bar.render(state);
    typeNote("for home");
    $("#agent-note-send").click();
    bar.render({ ...state, note: { ...screenNote, key: "screen:cart", scope: "On cart" } });
    typeNote("for cart");
    finish({ ok: true });
    await flush();
    expect($("#agent-note-field").value).toBe("for cart");
    bar.render(state);
    expect($("#agent-note-field").value).toBe(""); // home's text was sent and is gone
  });

  it("reset() drops every draft (a new project)", () => {
    typeNote("draft");
    render({ note: { ...screenNote, key: "screen:cart", scope: "On cart" } });
    bar.reset();
    render({ note: screenNote });
    expect($("#agent-note-field").value).toBe("");
  });

  it("announces a sent note politely", async () => {
    typeNote("x");
    $("#agent-note-send").click();
    await flush();
    expect($("#agent-bar-live").textContent).toBe("Note sent");
    expect($("#agent-bar-live").getAttribute("aria-live")).toBe("polite");
  });
});

describe("the card", () => {
  it("is named by its title and its grip moves it with the arrow keys", () => {
    expect($("#agent-bar").getAttribute("aria-labelledby")).toBe("agent-bar-title");
    expect($("#agent-bar-title").textContent).toBe("Agent");
    const spy = vi.spyOn($("#agent-bar"), "getBoundingClientRect").mockReturnValue({ left: 800, top: 78, width: 248, height: 700, right: 1048, bottom: 778 });
    $("#agent-bar-grip").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect($("#agent-bar").style.left).toBe("784px");
    expect(storage.map.get("artisign.agent-bar.position")).toBe("800,78");
    spy.mockRestore();
  });
});
