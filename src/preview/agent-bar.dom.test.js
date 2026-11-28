// @vitest-environment jsdom
//
// CHR-1269 — the Agent bar card on its own (the real index.html markup, no daemon): folding by the user and by a panel, the Follow switch, the feed.
import { describe, it, expect, beforeEach, vi } from "vitest";
import html from "./index.html?raw";
import { createAgentBar, feedHasMoreBelow } from "./agent-bar.js";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k), map };
}

const NOW = 5_000_000;
const feedOf = (...events) => events.map((e, i) => ({ tool: "write_html", kind: "write", ok: true, target: { kind: "screen", name: "home" }, nodes: [], at: NOW - i * 1000, ...e }));

let storage;
let calls;
let bar;
let state;
const $ = (sel) => document.querySelector(sel);

function mount() {
  document.body.innerHTML = bodyHtml;
  storage = storage ?? memoryStorage();
  calls = { follow: [], resume: 0, select: [] };
  bar = createAgentBar({
    barEl: $("#agent-bar"),
    topbarEl: $("#topbar-agent"),
    storage,
    onFollow: (on) => calls.follow.push(on),
    onResume: () => calls.resume++,
    onSelect: (event) => calls.select.push(event),
  });
  state = { feed: [], follow: { enabled: false, paused: false }, connected: true, now: NOW, exists: () => true };
  bar.render(state);
}
const render = (patch = {}) => bar.render((state = { ...state, ...patch }));

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
    $("#follow-switch").focus();
    bar.setPanelOpen(true);
    expect(document.activeElement).toBe($("#agent-bar-fold"));
  });
});

describe("the card", () => {
  it("is named by its title and its grip moves it with the arrow keys", () => {
    expect($("#agent-bar").getAttribute("aria-labelledby")).toBe("agent-bar-title");
    expect($("#agent-bar-title").textContent).toBe("Agent");
    const spy = vi.spyOn($("#agent-bar"), "getBoundingClientRect").mockReturnValue({ left: 700, top: 78, width: 248, height: 700, right: 948, bottom: 778 });
    $("#agent-bar-grip").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect($("#agent-bar").style.left).toBe("684px");
    expect(storage.map.get("artisign.agent-bar.position")).toBe("700,78");
    spy.mockRestore();
  });
});

describe("live regions", () => {
  it("only the two status lines and the Live chip are live regions, not the box holding the switch and Resume", () => {
    expect($("#agent-status").hasAttribute("role")).toBe(false);
    expect($("#agent-status-now").getAttribute("role")).toBe("status");
    expect($("#agent-status-detail").getAttribute("role")).toBe("status");
    expect($("#agent-status-now").contains($("#follow-switch"))).toBe(false);
    expect($("#connection").getAttribute("role")).toBe("status");
  });

  it("a re-render with identical state does not touch them (a screen reader would repeat every replaced text node)", () => {
    render({ feed: feedOf({}), follow: { enabled: true, paused: false } });
    const regions = ["#connection", "#agent-status-now", "#agent-status-detail", "#agent-bar-folded-status", "#topbar-connection"].map((sel) => $(sel));
    const observer = new MutationObserver(() => {});
    for (const el of regions) observer.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
    render({});
    render({ now: NOW + 1000 }); // the 15 s timer: same words
    expect(observer.takeRecords()).toEqual([]);
    render({ connected: false }); // a real change still lands
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    observer.disconnect();
  });
});

describe("the top bar's own Live chip and Follow control (Design System view, Use Cases)", () => {
  it("mirror the Agent bar's state: Live and Offline with the tooltip, the switch, the paused row with Resume", () => {
    expect($("#topbar-connection-label").textContent).toBe("Live");
    render({ connected: false });
    expect($("#topbar-connection-label").textContent).toBe("Offline");
    expect($("#topbar-connection").dataset.state).toBe("offline");
    expect($("#topbar-connection").dataset.tooltip).toBe("Live reload disconnected, retrying");
    render({ connected: true, follow: { enabled: true, paused: false } });
    expect($("#topbar-follow-switch").checked).toBe(true);
    expect($("#topbar-follow-paused").hidden).toBe(true);
    render({ follow: { enabled: true, paused: true } });
    expect($("#topbar-follow-on").hidden).toBe(true);
    expect($("#topbar-follow-paused").hidden).toBe(false);
  });

  it("their controls report like the Agent bar's", () => {
    $("#topbar-follow-switch").click();
    expect(calls.follow).toEqual([true]);
    render({ follow: { enabled: true, paused: true } });
    $("#topbar-follow-resume").click();
    expect(calls.resume).toBe(1);
  });
});

describe("the feed's bottom fade", () => {
  it("is the pure rule: only while rows run on below", () => {
    expect(feedHasMoreBelow({ scrollTop: 0, clientHeight: 300, scrollHeight: 300 })).toBe(false); // not overflowing
    expect(feedHasMoreBelow({ scrollTop: 0, clientHeight: 300, scrollHeight: 500 })).toBe(true);
    expect(feedHasMoreBelow({ scrollTop: 100, clientHeight: 300, scrollHeight: 500 })).toBe(true);
    expect(feedHasMoreBelow({ scrollTop: 200, clientHeight: 300, scrollHeight: 500 })).toBe(false); // at the end
    expect(feedHasMoreBelow({ scrollTop: 199.6, clientHeight: 300, scrollHeight: 500 })).toBe(false); // sub-pixel rounding
  });

  it("data-fade follows the list: on when it overflows, off at the end and when it does not overflow", () => {
    const feed = $("#agent-feed");
    const geometry = (scrollTop, scrollHeight) => {
      Object.defineProperty(feed, "scrollTop", { configurable: true, value: scrollTop, writable: true });
      Object.defineProperty(feed, "clientHeight", { configurable: true, value: 300 });
      Object.defineProperty(feed, "scrollHeight", { configurable: true, value: scrollHeight });
    };
    geometry(0, 300);
    render({ feed: feedOf({}) });
    expect(feed.dataset.fade).toBe("false");
    geometry(0, 600);
    render({ feed: feedOf({}, {}) });
    expect(feed.dataset.fade).toBe("true");
    geometry(300, 600);
    feed.dispatchEvent(new Event("scroll"));
    expect(feed.dataset.fade).toBe("false");
    geometry(100, 600);
    feed.dispatchEvent(new Event("scroll"));
    expect(feed.dataset.fade).toBe("true");
  });
});
