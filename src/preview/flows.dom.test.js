// @vitest-environment jsdom
//
// CHR-1268 — flow mode: the outline on every linked element, the hover chip's target, the jump on a click, and the overlay's placement.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyFlowMode, updateFlowOverlay } from "./flows.js";

let doc;
beforeEach(() => {
  document.body.innerHTML = `<div id="root"><button id="buy" data-flow-target="checkout.pay"><span id="buy-label">Buy</span></button><a id="menu" data-flow-target="menu" data-flow-trigger="hover">Menu</a><p id="plain">Text</p></div>`;
  doc = document;
});

const over = (el, relatedTarget = null) => el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget }));
const out = (el, relatedTarget = null) => el.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget }));

describe("applyFlowMode", () => {
  it("outlines every linked element and removes the outline again", () => {
    const stop = applyFlowMode(doc, true, () => {});
    expect(doc.getElementById("buy").getAttribute("style")).toContain("outline: 2px solid");
    expect(doc.getElementById("plain").hasAttribute("style")).toBe(false);
    stop();
    expect(doc.getElementById("buy").hasAttribute("style")).toBe(false);
  });

  it("a click on a tap-linked element (or inside it) jumps to its target screen; a node ref jumps to its screen part", () => {
    const go = vi.fn();
    applyFlowMode(doc, true, go);
    doc.getElementById("buy-label").click();
    expect(go).toHaveBeenCalledWith("checkout");
    doc.getElementById("menu").click(); // a hover-triggered flow does not follow a click
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("hover reports the tap-linked element under the pointer and where it leads, and null when the pointer leaves it", () => {
    const hover = vi.fn();
    applyFlowMode(doc, true, () => {}, { onHover: hover });
    over(doc.getElementById("buy-label"));
    expect(hover).toHaveBeenLastCalledWith(doc.getElementById("buy"), "checkout");
    out(doc.getElementById("buy-label"), doc.getElementById("buy")); // into the element's own parent: still inside
    expect(hover).toHaveBeenCalledTimes(1);
    out(doc.getElementById("buy"), doc.getElementById("plain"));
    expect(hover).toHaveBeenLastCalledWith(null, "");
    hover.mockClear();
    over(doc.getElementById("menu")); // hover-triggered: no outline target for a click
    over(doc.getElementById("plain"));
    expect(hover).not.toHaveBeenCalled();
  });

  it("the cleanup hides the hover and stops listening", () => {
    const hover = vi.fn();
    const stop = applyFlowMode(doc, true, () => {}, { onHover: hover });
    stop();
    expect(hover).toHaveBeenLastCalledWith(null, "");
    hover.mockClear();
    over(doc.getElementById("buy"));
    expect(hover).not.toHaveBeenCalled();
  });

  it("does nothing when flow mode is off", () => {
    const stop = applyFlowMode(doc, false, () => {});
    expect(doc.getElementById("buy").hasAttribute("style")).toBe(false);
    stop();
  });
});

describe("updateFlowOverlay", () => {
  it("covers the element and names the target; null hides it", () => {
    const overlay = document.createElement("div");
    overlay.innerHTML = `<span id="flow-overlay-chip"><span id="flow-overlay-target"></span></span>`;
    document.body.append(overlay);
    const el = doc.getElementById("buy");
    el.getBoundingClientRect = () => ({ left: 10.4, top: 20.6, width: 100, height: 40 });
    updateFlowOverlay(overlay, el, "checkout");
    expect(overlay.hidden).toBe(false);
    expect([overlay.style.left, overlay.style.top, overlay.style.width, overlay.style.height]).toEqual(["10px", "21px", "100px", "40px"]);
    expect(overlay.querySelector("#flow-overlay-target").textContent).toBe("checkout");
    updateFlowOverlay(overlay, null, "");
    expect(overlay.hidden).toBe(true);
  });
});
