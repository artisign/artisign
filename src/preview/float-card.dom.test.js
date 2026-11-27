// @vitest-environment jsdom
//
// CHR-1267 — the floating card's grip: pointer and keyboard moves, the position kept per viewer, and the clamp that keeps the grip reachable.
import { describe, it, expect, beforeEach } from "vitest";
import { makeCardDraggable, parseCardPosition, clampCardPosition, CARD_MIN_VISIBLE, CARD_KEY_STEP } from "./float-card.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), map };
}

let card;
let grip;
let box;

/** jsdom lays nothing out: the card's rect follows its inline left/top and a fixed size. */
function stubRect(el) {
  el.getBoundingClientRect = () => {
    const left = parseFloat(el.style.left || "16");
    const top = parseFloat(el.style.top || "76");
    return { left, top, right: left + 256, bottom: top + 700, width: 256, height: 700, x: left, y: top };
  };
}

beforeEach(() => {
  document.body.innerHTML = '<aside id="card"><button id="grip"></button></aside>';
  card = document.getElementById("card");
  grip = document.getElementById("grip");
  stubRect(card);
  window.innerWidth = 1440;
  window.innerHeight = 900;
  box = { width: 256, height: 700 };
});

const pointer = (target, type, x, y, init = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...init }));

describe("parseCardPosition", () => {
  it("reads left,top and rejects anything else", () => {
    expect(parseCardPosition("120,90")).toEqual({ left: 120, top: 90 });
    expect(parseCardPosition("-40, 12")).toEqual({ left: -40, top: 12 });
    for (const bad of [null, "", "1", "1,2,3", "a,b", "1,", ",2"]) expect(parseCardPosition(bad)).toBeNull();
  });
});

describe("clampCardPosition", () => {
  it("keeps a strip of the card inside the window on every side", () => {
    const win = { width: 1440, height: 900 };
    expect(clampCardPosition({ left: 5000, top: 5000 }, box, win)).toEqual({ left: 1440 - CARD_MIN_VISIBLE, top: 900 - CARD_MIN_VISIBLE });
    expect(clampCardPosition({ left: -5000, top: -5000 }, box, win)).toEqual({ left: CARD_MIN_VISIBLE - 256, top: 0 });
    expect(clampCardPosition({ left: 200, top: 100 }, box, win)).toEqual({ left: 200, top: 100 });
  });
});

describe("makeCardDraggable", () => {
  it("leaves the card where CSS puts it without a stored position", () => {
    makeCardDraggable({ cardEl: card, gripEl: grip, storage: memoryStorage(), key: "pos" });
    expect([card.style.left, card.style.top]).toEqual(["", ""]);
  });

  it("restores a stored position, clamped into the window", () => {
    makeCardDraggable({ cardEl: card, gripEl: grip, storage: memoryStorage({ pos: "300,120" }), key: "pos" });
    expect([card.style.left, card.style.top]).toEqual(["300px", "120px"]);
    document.body.innerHTML = '<aside id="card"><button id="grip"></button></aside>';
    const other = document.getElementById("card");
    stubRect(other);
    makeCardDraggable({ cardEl: other, gripEl: document.getElementById("grip"), storage: memoryStorage({ pos: "9000,9000" }), key: "pos" });
    expect([other.style.left, other.style.top]).toEqual([`${1440 - CARD_MIN_VISIBLE}px`, `${900 - CARD_MIN_VISIBLE}px`]);
  });

  it("a pointer drag on the grip moves the card with the pointer, marks it while dragging and remembers where it was left", () => {
    const storage = memoryStorage();
    makeCardDraggable({ cardEl: card, gripEl: grip, storage, key: "pos" });
    pointer(grip, "pointerdown", 30, 100, { button: 0 }); // the card is at 16,76: the grab is 14,24 inside it
    expect(card.classList.contains("is-dragging")).toBe(true);
    pointer(window, "pointermove", 530, 160); // listeners are on the window: they keep working off the small grip
    expect([card.style.left, card.style.top]).toEqual(["516px", "136px"]);
    pointer(window, "pointerup", 530, 160);
    expect(card.classList.contains("is-dragging")).toBe(false);
    expect(storage.map.get("pos")).toBe("516,136");
    pointer(window, "pointermove", 900, 400); // a released card stays put
    expect(card.style.left).toBe("516px");
  });

  it("ignores a secondary button", () => {
    makeCardDraggable({ cardEl: card, gripEl: grip, storage: memoryStorage(), key: "pos" });
    pointer(grip, "pointerdown", 30, 100, { button: 2 });
    expect(card.classList.contains("is-dragging")).toBe(false);
  });

  it("arrow keys on the grip move it, Shift four steps at a time, and the move is remembered", () => {
    const storage = memoryStorage();
    makeCardDraggable({ cardEl: card, gripEl: grip, storage, key: "pos" });
    const press = (key, init = {}) => {
      const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      grip.dispatchEvent(evt);
      return evt;
    };
    expect(press("ArrowRight").defaultPrevented).toBe(true);
    expect([card.style.left, card.style.top]).toEqual([`${16 + CARD_KEY_STEP}px`, "76px"]);
    press("ArrowDown", { shiftKey: true });
    expect(card.style.top).toBe(`${76 + CARD_KEY_STEP * 4}px`);
    expect(storage.map.get("pos")).toBe(`${16 + CARD_KEY_STEP},${76 + CARD_KEY_STEP * 4}`);
    expect(press("a").defaultPrevented).toBe(false);
    expect(press("ArrowLeft", { ctrlKey: true }).defaultPrevented).toBe(false); // browser and OS shortcuts stay theirs
  });

  it("tells screen readers about a move, through the live region, without coordinates", () => {
    const live = document.createElement("span");
    document.body.append(live);
    makeCardDraggable({ cardEl: card, gripEl: grip, storage: memoryStorage(), key: "pos", label: "Screens card", liveEl: live });
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(live.textContent).toBe("Screens card moved left");
    pointer(grip, "pointerdown", 30, 100, { button: 0 });
    pointer(window, "pointerup", 30, 100);
    expect(live.textContent).toBe("Screens card moved");
  });
});
