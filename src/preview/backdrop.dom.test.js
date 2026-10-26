// @vitest-environment jsdom
//
// CHR-940: nothing inside the inert backdrop layer is hit-testable, pickable, commentable or a flow source. jsdom has no layout, so a "point covered only by the backdrop" is modelled as a click whose target sits inside `[data-backdrop-layer]` (what elementFromPoint would return without pointer-events:none).
import { describe, it, expect, vi } from "vitest";
import { applyFlowMode } from "./flows.js";
import { applyCommentMode } from "./comments.js";
import { applyInspectMode } from "./inspector.js";
import { findDiagnostics } from "./warnings.js";
import { inBackdrop } from "./backdrop.js";

function makeDoc() {
  const doc = document.implementation.createHTMLDocument("t");
  doc.body.innerHTML = `
    <div id="sheet-root" data-backdrop="checkout">
      <div data-backdrop-layer inert>
        <div data-backdrop="nested">
          <button id="bd-btn" data-flow-target="elsewhere">Backdrop</button>
          <span id="bd-text" data-unresolved-token="color.x">x</span>
          <p class="bd-plain">plain</p>
        </div>
      </div>
      <div id="scrim" data-flow-target="checkout"></div>
      <div id="sheet"><button id="own-btn">Own</button><i id="own-bad" data-unresolved-token="color.y"></i></div>
    </div>`;
  return doc;
}

const click = (doc, el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

describe("backdrop layer", () => {
  it("inBackdrop is true only inside the layer", () => {
    const doc = makeDoc();
    expect(inBackdrop(doc.getElementById("bd-btn"))).toBe(true);
    expect(inBackdrop(doc.querySelector(".bd-plain"))).toBe(true);
    expect(inBackdrop(doc.getElementById("own-btn"))).toBe(false);
    expect(inBackdrop(doc.getElementById("sheet-root"))).toBe(false);
  });

  it("flow mode: clicking the backdrop does nothing, an own scrim still navigates", () => {
    const doc = makeDoc();
    const onNavigate = vi.fn();
    const cleanup = applyFlowMode(doc, true, onNavigate);
    click(doc, doc.getElementById("bd-btn"));
    click(doc, doc.querySelector(".bd-plain"));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(doc.getElementById("bd-btn").getAttribute("style")).toBeNull(); // no flow outline
    click(doc, doc.getElementById("scrim"));
    expect(onNavigate).toHaveBeenCalledWith("checkout");
    cleanup();
  });

  it("comment mode: backdrop clicks select nothing, own nodes and the root still do", () => {
    const doc = makeDoc();
    const onSelect = vi.fn();
    const cleanup = applyCommentMode(doc, true, new Set(["bd-btn", "own-btn"]), onSelect);
    click(doc, doc.getElementById("bd-btn"));
    click(doc, doc.querySelector(".bd-plain"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(doc.getElementById("bd-btn").getAttribute("style")).toBeNull(); // no open-thread marker
    expect(doc.getElementById("own-btn").getAttribute("style")).toContain("outline");
    click(doc, doc.getElementById("own-btn"));
    expect(onSelect).toHaveBeenLastCalledWith("own-btn");
    click(doc, doc.getElementById("sheet-root"));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    cleanup();
  });

  it("inspect mode: backdrop clicks neither select nor deselect, own nodes stay selectable", () => {
    const doc = makeDoc();
    const handlers = { getModelIds: () => new Set(["own-btn"]), onSelect: vi.fn(), onDeselect: vi.fn(), onScroll: vi.fn() };
    const cleanup = applyInspectMode(doc, true, handlers);
    click(doc, doc.getElementById("bd-btn"));
    click(doc, doc.querySelector(".bd-plain"));
    expect(handlers.onSelect).not.toHaveBeenCalled();
    expect(handlers.onDeselect).not.toHaveBeenCalled();
    click(doc, doc.getElementById("own-btn"));
    expect(handlers.onSelect).toHaveBeenCalledWith("own-btn", "own-btn");
    cleanup();
  });

  it("diagnostic cycling skips markers inside the backdrop", () => {
    const doc = makeDoc();
    expect(findDiagnostics(doc).map((el) => el.id)).toEqual(["own-bad"]);
  });
});
