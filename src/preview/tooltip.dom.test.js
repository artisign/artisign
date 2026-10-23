// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTooltips, placeTooltip } from "./tooltip.js";

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
});

describe("initTooltips", () => {
  let dispose;
  let btn;

  beforeEach(() => {
    document.body.innerHTML = `<button id="b" aria-label="Flow mode" data-tooltip="Flow mode" data-shortcut="F"><span id="inner">x</span></button><button id="plain">y</button>`;
    btn = document.getElementById("b");
    dispose = initTooltips(document);
  });

  afterEach(() => dispose());

  const tip = () => document.getElementById("chrome-tooltip");

  it("is hidden and aria-hidden until a trigger is hovered", () => {
    expect(tip().hidden).toBe(true);
    expect(tip().getAttribute("aria-hidden")).toBe("true");
  });

  it("shows label and shortcut on hover, hides on leave", () => {
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tip().hidden).toBe(false);
    expect(tip().textContent).toContain("Flow mode");
    expect(tip().querySelector(".chrome-tooltip-key").textContent).toBe("F");
    btn.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    expect(tip().hidden).toBe(true);
  });

  it("stays shown when the pointer moves to a child of the trigger", () => {
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    btn.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.getElementById("inner") }));
    expect(tip().hidden).toBe(false);
  });

  it("shows on keyboard focus and hides on blur", () => {
    btn.focus();
    expect(tip().hidden).toBe(false);
    btn.blur();
    expect(tip().hidden).toBe(true);
  });

  it("hides on Escape", () => {
    btn.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tip().hidden).toBe(true);
  });

  it("hides the key slot without a shortcut and ignores plain buttons", () => {
    btn.removeAttribute("data-shortcut");
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tip().querySelector(".chrome-tooltip-key").hidden).toBe(true);
    document.getElementById("plain").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tip().hidden).toBe(false); // unchanged from btn, plain is not a trigger
  });

  it("refreshes its text when the trigger's tooltip changes on click", () => {
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    btn.dataset.tooltip = "Theme: Dark";
    btn.click();
    expect(tip().textContent).toContain("Theme: Dark");
  });

  it("stays dismissed after Escape until the pointer leaves the trigger", () => {
    const inner = document.getElementById("inner");
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tip().hidden).toBe(true);
    inner.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tip().hidden).toBe(true);
    btn.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tip().hidden).toBe(false);
  });

  it("keeps a hover-opened tooltip when focus leaves another element", () => {
    const plain = document.getElementById("plain");
    plain.focus();
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    plain.blur();
    expect(tip().hidden).toBe(false);
    btn.dataset.tooltip = "Changed";
    btn.click();
    expect(tip().textContent).toContain("Changed");
  });

  it("hides on scroll, on resize and when the trigger is removed", () => {
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    document.dispatchEvent(new Event("scroll"));
    expect(tip().hidden).toBe(true);
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    window.dispatchEvent(new Event("resize"));
    expect(tip().hidden).toBe(true);
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    btn.remove();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(tip().hidden).toBe(true);
  });

  it("is idempotent: a second init leaves one tooltip element and no stacked listeners", () => {
    const second = initTooltips(document);
    expect(document.querySelectorAll("#chrome-tooltip")).toHaveLength(1);
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tip().hidden).toBe(false);
    second();
    expect(document.querySelectorAll("#chrome-tooltip")).toHaveLength(0);
  });
});
