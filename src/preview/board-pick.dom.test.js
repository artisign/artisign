// @vitest-environment jsdom
//
// CHR-1295, CHR-1296 — the Board's pointer layer: moves and clicks become hits in the tile under the pointer.
import { describe, it, expect, beforeEach } from "vitest";
import { createBoardPicker } from "./board-pick.js";

let layer;
let events;
let el;
let picker;

const doc = () => ({ elementFromPoint: (x, y) => ({ at: [x, y], ...el }) });
const frames = () => [{ screen: "one", rect: () => ({ left: 100, top: 50, width: 200, height: 400 }), layoutWidth: () => 400, doc }];
const ptr = (type, x, y) => layer.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));

beforeEach(() => {
  document.body.innerHTML = '<div id="layer" data-active="false"></div>';
  layer = document.getElementById("layer");
  events = [];
  el = { id: "btn" };
  picker = createBoardPicker({
    layerEl: layer,
    frames,
    onHover: (hit, element) => events.push(["hover", hit?.screen ?? null, element?.at ?? null]),
    onPick: (hit, element) => events.push(["pick", hit?.screen ?? null, element?.at ?? null]),
  });
});

describe("the pointer layer", () => {
  it("takes the pointer only while a tool is active", () => {
    expect(layer.dataset.active).toBe("false");
    picker.setActive(true);
    expect(layer.dataset.active).toBe("true");
    picker.setActive(false);
    expect(layer.dataset.active).toBe("false");
  });

  it("reports the element under the pointer in the tile's own pixels", () => {
    ptr("pointermove", 150, 100);
    expect(events).toEqual([["hover", "one", [100, 100]]]);
  });

  it("reports a click the same way, and a click on empty board space as no tile", () => {
    ptr("click", 150, 100);
    ptr("click", 20, 20);
    expect(events).toEqual([
      ["pick", "one", [100, 100]],
      ["pick", null, null],
    ]);
  });

  it("reports leaving the board as no tile", () => {
    ptr("pointermove", 150, 100);
    layer.dispatchEvent(new MouseEvent("pointerleave"));
    expect(events.at(-1)).toEqual(["hover", null, null]);
  });

  it("asks again about the last pointer position after a scroll moved the tiles under it", () => {
    picker.setActive(true);
    ptr("pointermove", 150, 100);
    events.length = 0;
    el = { id: "other" };
    picker.refresh();
    expect(events).toEqual([["hover", "one", [100, 100]]]);
  });

  it("does not ask while no tool is active, or before the pointer was ever over the board", () => {
    picker.refresh();
    picker.setActive(true);
    picker.refresh();
    expect(events).toEqual([]);
  });
});
