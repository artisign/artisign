// @vitest-environment jsdom
//
// CHR-1295, CHR-1296 — the Board's pointer overlays: moves and clicks on a tile's overlay become hits in the tile under the pointer; anything else is not the tool's.
import { describe, it, expect, beforeEach } from "vitest";
import { createBoardPicker } from "./board-pick.js";

let canvas;
let overlay;
let control;
let events;
let el;
let picker;

const doc = () => ({ elementFromPoint: (x, y) => ({ at: [x, y], ...el }) });
const frames = () => [{ screen: "one", rect: () => ({ left: 100, top: 50, width: 200, height: 400 }), layoutWidth: () => 400, doc }];
const ptr = (target, type, x, y) => target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));

beforeEach(() => {
  document.body.innerHTML = '<div id="canvas"><div class="tile"><div class="pick"></div><button class="control">pin</button></div></div>';
  canvas = document.getElementById("canvas");
  overlay = canvas.querySelector(".pick");
  control = canvas.querySelector(".control");
  events = [];
  el = { id: "btn" };
  picker = createBoardPicker({
    containerEl: canvas,
    targetSelector: ".pick",
    frames,
    onHover: (hit, element) => events.push(["hover", hit?.screen ?? null, element?.at ?? null]),
    onPick: (hit, element) => events.push(["pick", hit?.screen ?? null, element?.at ?? null]),
  });
});

describe("the pointer overlays", () => {
  it("are switched by the canvas's data-pick, so the tools own the pointer only while active", () => {
    picker.setActive(true);
    expect(canvas.dataset.pick).toBe("true");
    picker.setActive(false);
    expect(canvas.dataset.pick).toBe("false");
  });

  it("report the element under the pointer in the tile's own pixels, on a move and on a click", () => {
    ptr(overlay, "pointermove", 150, 100);
    ptr(overlay, "click", 150, 100);
    expect(events).toEqual([
      ["hover", "one", [100, 100]],
      ["pick", "one", [100, 100]],
    ]);
  });

  it("ignore a click on a tile's own control (it keeps its own behaviour) and report the pointer leaving the overlay as no tile", () => {
    ptr(overlay, "pointermove", 150, 100);
    events.length = 0;
    ptr(control, "click", 150, 100);
    expect(events).toEqual([]);
    ptr(control, "pointermove", 150, 100);
    expect(events).toEqual([["hover", null, null]]);
  });

  it("report a click that lands on no tile as a pick on nothing", () => {
    ptr(overlay, "click", 20, 20);
    expect(events).toEqual([["pick", null, null]]);
  });

  it("report leaving the board as no tile", () => {
    ptr(overlay, "pointermove", 150, 100);
    canvas.dispatchEvent(new MouseEvent("pointerleave"));
    expect(events.at(-1)).toEqual(["hover", null, null]);
  });

  it("ask again about the last pointer position after a scroll moved the tiles under it", () => {
    picker.setActive(true);
    ptr(overlay, "pointermove", 150, 100);
    events.length = 0;
    el = { id: "other" };
    picker.refresh();
    expect(events).toEqual([["hover", "one", [100, 100]]]);
  });

  it("do not ask while no tool is active, or before the pointer was ever over a tile", () => {
    picker.refresh();
    picker.setActive(true);
    picker.refresh();
    expect(events).toEqual([]);
  });
});
