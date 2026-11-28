// CHR-1295, CHR-1296 — the shared hit-test: client points into the tile documents, whatever the zoom and pan.
import { describe, it, expect } from "vitest";
import { elementAtHit, elementClientBox, tileAtPoint, tileScale } from "./tile-hit.js";

/** A tile on screen at `rect`, whose document is `layoutWidth` px wide; `doc` answers elementFromPoint with what it is told. */
const frame = (screen, rect, layoutWidth, doc = {}) => ({ screen, rect: () => rect, layoutWidth: () => layoutWidth, doc: () => doc });

describe("tileScale", () => {
  it("is the on-screen width over the document's layout width (tile fit times board zoom)", () => {
    expect(tileScale(frame("a", { left: 0, top: 0, width: 195, height: 400 }, 390))).toBe(0.5);
  });

  it("falls back to 1 for a frame with no layout width yet", () => {
    expect(tileScale(frame("a", { left: 0, top: 0, width: 195, height: 400 }, 0))).toBe(1);
  });
});

describe("tileAtPoint", () => {
  const a = frame("a", { left: 100, top: 50, width: 200, height: 400 }, 400);
  const b = frame("b", { left: 400, top: 50, width: 200, height: 400 }, 400);

  it("maps a client point into the tile document's pixels", () => {
    const hit = tileAtPoint([a, b], 150, 100);
    expect(hit?.screen).toBe("a");
    expect(hit?.x).toBe(100); // (150 - 100) / 0.5
    expect(hit?.y).toBe(100); // (100 - 50) / 0.5
    expect(tileAtPoint([a, b], 450, 60)).toMatchObject({ screen: "b", x: 100, y: 20 });
  });

  it("holds at any zoom: the same document point is hit wherever the tile is drawn", () => {
    const zoomed = frame("a", { left: 10, top: 20, width: 800, height: 1600 }, 400); // twice the size
    expect(tileAtPoint([zoomed], 410, 420)).toMatchObject({ x: 200, y: 200 });
  });

  it("is null over empty board space, between tiles and past a tile's right and bottom edge", () => {
    expect(tileAtPoint([a, b], 350, 100)).toBeNull();
    expect(tileAtPoint([a, b], 10, 10)).toBeNull();
    expect(tileAtPoint([a], 300, 100)).toBeNull(); // the right edge is outside
    expect(tileAtPoint([a], 150, 450)).toBeNull();
    expect(tileAtPoint([a], 100, 50)?.screen).toBe("a"); // the top-left corner is inside
  });

  it("lets the tile painted last win where two overlap", () => {
    const over = frame("over", { left: 150, top: 50, width: 200, height: 400 }, 400);
    expect(tileAtPoint([a, over], 200, 100)?.screen).toBe("over");
    expect(tileAtPoint([over, a], 200, 100)?.screen).toBe("a");
  });

  it("is null over a tile whose document is not there yet", () => {
    const loading = { ...a, doc: () => null };
    expect(tileAtPoint([loading], 150, 100)).toBeNull();
  });
});

describe("elementAtHit and elementClientBox", () => {
  it("asks the tile document about the mapped point", () => {
    const asked = [];
    const el = { id: "btn" };
    const doc = { elementFromPoint: (x, y) => (asked.push([x, y]), el) };
    const hit = tileAtPoint([frame("a", { left: 100, top: 50, width: 200, height: 400 }, 400, doc)], 150, 100);
    expect(elementAtHit(hit)).toBe(el);
    expect(asked).toEqual([[100, 100]]);
  });

  it("maps an element's document rect back to client pixels", () => {
    const f = frame("a", { left: 100, top: 50, width: 200, height: 400 }, 400);
    const el = { getBoundingClientRect: () => ({ left: 100, top: 100, right: 200, bottom: 140 }) };
    expect(elementClientBox(f, el)).toEqual({ left: 150, top: 100, right: 200, bottom: 120 });
  });
});
