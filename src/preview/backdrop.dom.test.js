// @vitest-environment jsdom
//
// CHR-940: the inert backdrop layer contributes no selectable, commentable or flow targets. The fixture has the shape the renderer emits (render.ts): the layer is anonymous — no `id`, no `data-flow-*` — but keeps the other screen's `data-unresolved-*` markers. Being `inert` + `pointer-events:none`, a click on the backdrop area lands on the overlay root, which is what these tests click.
import { describe, it, expect, vi } from "vitest";
import { applyFlowMode } from "./flows.js";
import { commentTarget } from "./comment-canvas.js";
import { applyInspectMode } from "./inspector.js";
import { findDiagnostics } from "./warnings.js";

function makeDoc(rootAttrs = "") {
  const doc = document.implementation.createHTMLDocument("t");
  doc.body.innerHTML = `
    <div id="sheet-root" data-backdrop="checkout" ${rootAttrs}>
      <div data-backdrop-layer inert style="position:absolute; inset:0; overflow:hidden; pointer-events:none; z-index:-1">
        <div data-backdrop="nested">
          <button class="bd-btn">Backdrop</button>
          <span data-unresolved-token="color.x">x</span>
        </div>
      </div>
      <div id="scrim" data-flow-target="checkout"></div>
      <div id="sheet"><button id="own-btn">Own</button><i id="own-bad" data-unresolved-token="color.y"></i></div>
    </div>`;
  return doc;
}

const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

describe("backdrop layer", () => {
  it("flow mode: the layer adds no flow sources, an own scrim still navigates, a backdrop-area click does nothing", () => {
    const doc = makeDoc();
    const onNavigate = vi.fn();
    const cleanup = applyFlowMode(doc, true, onNavigate);
    click(doc.getElementById("sheet-root")); // where a click on the backdrop area lands
    expect(onNavigate).not.toHaveBeenCalled();
    expect(doc.querySelector(".bd-btn").getAttribute("style")).toBeNull();
    click(doc.getElementById("scrim"));
    expect(onNavigate).toHaveBeenCalledWith("checkout");
    cleanup();
  });

  it("comment mode: the layer has nothing to anchor to, own nodes and the root do", () => {
    const doc = makeDoc();
    expect(commentTarget(doc, doc.getElementById("own-btn"))?.id).toBe("own-btn");
    expect(commentTarget(doc, doc.getElementById("sheet-root"))?.id).toBeNull();
    // A node inside the inert layer resolves to the overlay root, never to the other screen's content.
    expect(commentTarget(doc, doc.querySelector(".bd-btn"))?.id).toBeNull();
  });

  it("inspect mode: own nodes stay selectable, the backdrop area behaves like the empty root", () => {
    const doc = makeDoc();
    const handlers = { getModelIds: () => new Set(["own-btn"]), onSelect: vi.fn(), onDeselect: vi.fn(), onScroll: vi.fn() };
    const cleanup = applyInspectMode(doc, true, handlers);
    click(doc.getElementById("sheet-root"));
    expect(handlers.onSelect).not.toHaveBeenCalled();
    expect(handlers.onDeselect).toHaveBeenCalledOnce();
    click(doc.getElementById("own-btn"));
    expect(handlers.onSelect).toHaveBeenCalledWith("own-btn", "own-btn");
    cleanup();
  });

  it("diagnostics: markers inside the layer are skipped, a dangling backdrop on the root is counted", () => {
    expect(findDiagnostics(makeDoc()).map((el) => el.id)).toEqual(["own-bad"]);
    expect(findDiagnostics(makeDoc("data-unresolved-backdrop")).map((el) => el.id)).toEqual(["sheet-root", "own-bad"]);
  });
});
