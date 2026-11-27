// @vitest-environment jsdom
//
// CHR-1267 — the zoom pill's popover: native `popover="auto"` where the browser has the API, a toggled box with the same outside-click behaviour where it does not; the slider and the presets follow the zoom the pill targets.
import { describe, it, expect, beforeEach } from "vitest";
import { createZoomPill, scaleToPercent, MIN_ZOOM_PERCENT, MAX_ZOOM_PERCENT } from "./zoom-pill.js";

function build({ native }) {
  document.body.innerHTML = `
    <div id="pill"><button id="trigger" aria-expanded="false"><span id="label"></span></button><button id="fit" class="zoom-button" data-zoom="fit"></button></div>
    <div id="menu" popover="auto">
      <input id="range" type="range" min="5" max="200" />
      <button class="zoom-button" data-zoom="fit"></button>
      <button class="zoom-button" data-zoom="0.5"></button>
      <button class="zoom-button" data-zoom="1"></button>
    </div>`;
  const menuEl = document.getElementById("menu");
  const state = { open: false };
  if (native) {
    // jsdom has no Popover API: a stand-in with the same surface (matches(":popover-open"), show/hide firing `toggle`).
    menuEl.showPopover = () => {
      state.open = true;
      menuEl.dispatchEvent(new Event("toggle"));
    };
    menuEl.hidePopover = () => {
      state.open = false;
      menuEl.dispatchEvent(new Event("toggle"));
    };
    const matches = menuEl.matches.bind(menuEl);
    menuEl.matches = (selector) => (selector === ":popover-open" ? state.open : matches(selector));
  }
  if (native) {
    // The declared invoker: the browser toggles the popover on a click of the trigger (stand-in for that behaviour).
    document.getElementById("trigger").addEventListener("click", () => {
      if (!document.getElementById("trigger").hasAttribute("popovertarget")) return;
      if (state.open) menuEl.hidePopover();
      else menuEl.showPopover();
    });
  }
  const zooms = [];
  const pill = createZoomPill({
    pillEl: document.getElementById("pill"),
    triggerEl: document.getElementById("trigger"),
    menuEl,
    labelEl: document.getElementById("label"),
    rangeEl: document.getElementById("range"),
    presetEls: [...document.querySelectorAll(".zoom-button")],
    onZoom: (value) => zooms.push(value),
  });
  return { pill, state, zooms, menuEl, trigger: document.getElementById("trigger"), range: document.getElementById("range") };
}

describe("scaleToPercent", () => {
  it("rounds and clamps to the slider's range", () => {
    expect(scaleToPercent(0.9)).toBe(90);
    expect(scaleToPercent(0.004)).toBe(MIN_ZOOM_PERCENT);
    expect(scaleToPercent(9)).toBe(MAX_ZOOM_PERCENT);
  });
});

describe.each([
  ["native popover", true],
  ["fallback box", false],
])("%s", (_name, native) => {
  let ctx;
  beforeEach(() => {
    ctx = build({ native });
  });

  it("the % value toggles it and aria-expanded follows (a second click closes, it never reopens)", () => {
    ctx.trigger.click();
    expect(ctx.pill.isOpen()).toBe(true);
    expect(ctx.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(ctx.range);
    ctx.trigger.click();
    expect(ctx.pill.isOpen()).toBe(false);
    expect(ctx.trigger.getAttribute("aria-expanded")).toBe("false");
    ctx.trigger.click();
    expect(ctx.pill.isOpen()).toBe(true);
  });

  it("close() closes it and is a no-op when closed", () => {
    ctx.pill.close();
    ctx.trigger.click();
    ctx.pill.close();
    expect(ctx.pill.isOpen()).toBe(false);
    expect(ctx.trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("the slider asks for its value as a scale", () => {
    ctx.range.value = "37";
    ctx.range.dispatchEvent(new Event("input", { bubbles: true }));
    expect(ctx.zooms).toEqual([0.37]);
  });

  it("a preset in the popover closes it and gives the focus back to the % value", () => {
    ctx.trigger.click();
    document.querySelector('#menu .zoom-button[data-zoom="0.5"]').click();
    expect(ctx.pill.isOpen()).toBe(false);
    expect(document.activeElement).toBe(ctx.trigger);
  });

  it("sync shows the effective percentage, the slider position and the current preset", () => {
    ctx.pill.sync({ zoom: "fit", scale: 0.6234 });
    expect(document.getElementById("label").textContent).toBe("62%");
    expect(ctx.range.value).toBe("62");
    expect(ctx.range.getAttribute("aria-valuetext")).toBe("62%");
    const pressed = () => [...document.querySelectorAll(".zoom-button")].map((b) => b.getAttribute("aria-pressed"));
    expect(pressed()).toEqual(["true", "true", "false", "false"]); // both Fit buttons
    ctx.pill.sync({ zoom: 0.5, scale: 0.5 });
    expect(pressed()).toEqual(["false", "false", "true", "false"]);
    ctx.pill.sync({ zoom: 0.37, scale: 0.37 });
    expect(pressed()).toEqual(["false", "false", "false", "false"]); // a slider value is no preset
    expect(ctx.range.style.getPropertyValue("--fill")).toBe(`${((37 - 5) / 195) * 100}%`);
  });
});

describe("fallback box", () => {
  it("a press outside the pill and the box closes it; a press inside does not", () => {
    const ctx = build({ native: false });
    ctx.trigger.click();
    ctx.menuEl.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(ctx.pill.isOpen()).toBe(true);
    document.getElementById("pill").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(ctx.pill.isOpen()).toBe(true);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(ctx.pill.isOpen()).toBe(false);
  });
});

describe("native popover", () => {
  it("the trigger is the declared invoker, so the script never toggles it by hand", () => {
    const ctx = build({ native: true });
    expect(ctx.trigger.getAttribute("popovertarget")).toBe("menu");
    expect(build({ native: false }).trigger.hasAttribute("popovertarget")).toBe(false);
  });

  it("light dismiss and Escape close it without close(): the `toggle` event keeps aria-expanded right", () => {
    const ctx = build({ native: true });
    ctx.trigger.click();
    ctx.state.open = false; // the browser dismissed it
    ctx.menuEl.dispatchEvent(new Event("toggle"));
    expect(ctx.trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
