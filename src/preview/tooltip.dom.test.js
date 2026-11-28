// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initTooltips, placeTooltip, OPEN_DELAY, SKIP_DELAY } from "./tooltip.js";

describe("placeTooltip", () => {
  const tip = { width: 100, height: 24 };
  const viewport = { width: 1000, height: 600 };

  it("centres below the trigger", () => {
    const pos = placeTooltip({ left: 400, right: 428, top: 8, bottom: 36 }, tip, viewport);
    expect(pos).toEqual({ left: 364, top: 40 });
  });

  it("clamps at the right edge", () => {
    const pos = placeTooltip({ left: 960, right: 988, top: 8, bottom: 36 }, tip, viewport);
    expect(pos.left).toBe(1000 - 100 - 8);
  });

  it("clamps at the left edge", () => {
    expect(placeTooltip({ left: 0, right: 10, top: 8, bottom: 36 }, tip, viewport).left).toBe(8);
  });

  it("flips above when there is no room below", () => {
    const pos = placeTooltip({ left: 400, right: 428, top: 560, bottom: 588 }, tip, viewport);
    expect(pos.top).toBe(560 - 4 - 24);
  });

  it("end: right of the trigger, vertically centred; flipped to the left at the viewport edge", () => {
    expect(placeTooltip({ left: 10, right: 38, top: 100, bottom: 128 }, tip, viewport, "end")).toEqual({ left: 46, top: 102 });
    expect(placeTooltip({ left: 960, right: 988, top: 100, bottom: 128 }, tip, viewport, "end").left).toBe(960 - 8 - 100);
  });

  it("top: above the trigger, below when there is no room above", () => {
    expect(placeTooltip({ left: 400, right: 428, top: 560, bottom: 588 }, tip, viewport, "top").top).toBe(560 - 4 - 24);
    expect(placeTooltip({ left: 400, right: 428, top: 10, bottom: 38 }, tip, viewport, "top").top).toBe(42);
  });
});

describe("initTooltips", () => {
  let dispose;
  let btn;
  let other;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div id="tools" data-tooltip-side="end"><button id="b" aria-label="Flow mode" data-tooltip="Flow mode" data-shortcut="F"><span id="inner">x</span></button><button id="o" aria-label="Inspect" data-tooltip="Inspect" aria-describedby="note">o</button></div><button id="plain">y</button><span id="note">n</span>`;
    btn = document.getElementById("b");
    other = document.getElementById("o");
    dispose = initTooltips(document);
  });

  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  const tip = () => document.getElementById("chrome-tooltip");
  const over = (el) => el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  const out = (el) => el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  const esc = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  it("is a hidden tooltip element until a trigger is hovered", () => {
    expect(tip().hidden).toBe(true);
    expect(tip().getAttribute("role")).toBe("tooltip");
    expect(tip().hasAttribute("aria-hidden")).toBe(false);
  });

  it("opens after the open delay, not before", () => {
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY - 1);
    expect(tip().hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tip().hidden).toBe(false);
    expect(tip().textContent).toContain("Flow mode");
    expect(tip().querySelector(".chrome-tooltip-key").textContent).toBe("F");
  });

  it("closes immediately on pointer leave, and leaving before the delay never opens it", () => {
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    out(btn);
    expect(tip().hidden).toBe(true);
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY - 100);
    out(btn);
    vi.advanceTimersByTime(1000);
    expect(tip().hidden).toBe(true);
  });

  it("skips the delay between neighbours: while one is up, and for the skip delay after it closed", () => {
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    out(btn);
    vi.advanceTimersByTime(SKIP_DELAY - 50);
    over(other);
    expect(tip().hidden).toBe(false); // at once
    expect(tip().textContent).toContain("Inspect");
    out(other);
    vi.advanceTimersByTime(SKIP_DELAY + 1);
    over(btn);
    expect(tip().hidden).toBe(true); // the skip window is over: the full delay again
    vi.advanceTimersByTime(OPEN_DELAY);
    expect(tip().hidden).toBe(false);
  });

  it("stays shown when the pointer moves to a child of the trigger", () => {
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    btn.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.getElementById("inner") }));
    expect(tip().hidden).toBe(false);
  });

  it("links the trigger with aria-describedby while shown and restores it after", () => {
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    expect(btn.getAttribute("aria-describedby")).toBe("chrome-tooltip");
    out(btn);
    expect(btn.hasAttribute("aria-describedby")).toBe(false);
    over(other);
    vi.advanceTimersByTime(OPEN_DELAY);
    expect(other.getAttribute("aria-describedby")).toBe("note chrome-tooltip");
    out(other);
    expect(other.getAttribute("aria-describedby")).toBe("note");
  });

  it("shows at once on keyboard focus (focus-visible) and hides on blur", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    btn.focus();
    expect(tip().hidden).toBe(false);
    btn.blur();
    expect(tip().hidden).toBe(true);
  });

  it("does not show on a pointer-driven focus (a click that focuses the button)", () => {
    // jsdom matches :focus-visible for every focus; a browser does not after a mouse click.
    const matches = btn.matches.bind(btn);
    btn.matches = (selector) => (selector === ":focus-visible" ? false : matches(selector));
    btn.focus();
    expect(tip().hidden).toBe(true);
  });

  it("closes on click and stays closed until the pointer leaves", () => {
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    btn.click();
    expect(tip().hidden).toBe(true);
    over(btn.firstElementChild);
    vi.advanceTimersByTime(1000);
    expect(tip().hidden).toBe(true);
    out(btn);
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    expect(tip().hidden).toBe(false);
  });

  it("hides on Escape, also while the delay is still running", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    btn.focus();
    esc();
    expect(tip().hidden).toBe(true);
    over(other);
    vi.advanceTimersByTime(OPEN_DELAY - 10);
    esc();
    vi.advanceTimersByTime(1000);
    expect(tip().hidden).toBe(true);
  });

  it("hides the key slot without a shortcut, ignores plain buttons and empty tooltips", () => {
    btn.removeAttribute("data-shortcut");
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    expect(tip().querySelector(".chrome-tooltip-key").hidden).toBe(true);
    over(document.getElementById("plain"));
    expect(tip().hidden).toBe(false); // unchanged from btn, plain is not a trigger
    out(btn);
    other.dataset.tooltip = "";
    over(other);
    vi.advanceTimersByTime(1000);
    expect(tip().hidden).toBe(true);
  });

  it("stays dismissed after Escape until the pointer leaves the trigger", () => {
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    esc();
    expect(tip().hidden).toBe(true);
    over(document.getElementById("inner"));
    vi.advanceTimersByTime(1000);
    expect(tip().hidden).toBe(true);
    out(btn);
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    expect(tip().hidden).toBe(false);
  });

  it("keeps a hover-opened tooltip when focus leaves another element", () => {
    const plain = document.getElementById("plain");
    plain.focus();
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    plain.blur();
    expect(tip().hidden).toBe(false);
  });

  it("hides on scroll, on resize and when the trigger is removed", () => {
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    document.dispatchEvent(new Event("scroll"));
    expect(tip().hidden).toBe(true);
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    window.dispatchEvent(new Event("resize"));
    expect(tip().hidden).toBe(true);
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    btn.remove();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(tip().hidden).toBe(true);
  });

  it("is idempotent: a second init leaves one tooltip element and no stacked listeners", () => {
    const second = initTooltips(document);
    expect(document.querySelectorAll("#chrome-tooltip")).toHaveLength(1);
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    expect(tip().hidden).toBe(false);
    second();
    expect(document.querySelectorAll("#chrome-tooltip")).toHaveLength(0);
  });

  it("shows a disabled trigger's tooltip by hit-testing the pointer, and hides when it leaves", () => {
    btn.disabled = true;
    // jsdom has no layout; elementFromPoint answers "the topmost element under the pointer".
    let under = btn.firstElementChild ?? btn;
    document.elementFromPoint = () => under;
    document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 20, clientY: 20 }));
    vi.advanceTimersByTime(OPEN_DELAY);
    expect(tip().hidden).toBe(false);
    expect(tip().textContent).toContain("Flow mode");
    under = document.body;
    document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 200, clientY: 200 }));
    expect(tip().hidden).toBe(true);
    delete document.elementFromPoint;
  });

  it("does not show a disabled trigger's tooltip while something else covers it", () => {
    btn.disabled = true;
    document.elementFromPoint = () => document.getElementById("plain");
    document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 20, clientY: 20 }));
    vi.advanceTimersByTime(1000);
    expect(tip().hidden).toBe(true);
    delete document.elementFromPoint;
  });

  it("asks placeTooltip for the side its container names (never over the hovered button)", () => {
    btn.getBoundingClientRect = () => ({ left: 10, right: 38, top: 100, bottom: 128 });
    over(btn);
    vi.advanceTimersByTime(OPEN_DELAY);
    // jsdom viewport 1024x768, tooltip size 0: "end" = right of the trigger (46), vertically centred (114).
    expect([tip().style.left, tip().style.top]).toEqual(["46px", "114px"]);
  });
});
