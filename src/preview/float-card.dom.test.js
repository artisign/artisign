// @vitest-environment jsdom
//
// CHR-1267 — the floating card's grip: pointer and keyboard moves, the position kept per viewer, and the clamp that keeps the grip reachable.
import { describe, it, expect, beforeEach } from "vitest";
import { makeCardDraggable, parseCardPosition, clampCardPosition, topBarLimit, CARD_MARGIN, CARD_MIN_VISIBLE, CARD_KEY_STEP } from "./float-card.js";

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
  const win = { width: 1440, height: 900 };

  it("keeps the card inside the window minus a margin; only its head has to stay above the bottom edge", () => {
    expect(clampCardPosition({ left: 5000, top: 5000 }, box, win)).toEqual({ left: 1440 - 256 - CARD_MARGIN, top: 900 - CARD_MIN_VISIBLE });
    expect(clampCardPosition({ left: -5000, top: -5000 }, box, win)).toEqual({ left: CARD_MARGIN, top: 0 });
    expect(clampCardPosition({ left: 200, top: 100 }, box, win)).toEqual({ left: 200, top: 100 });
  });

  it("never lets a card above the top bar's lower edge", () => {
    expect(clampCardPosition({ left: 200, top: -40 }, box, win, { top: 68 })).toEqual({ left: 200, top: 68 });
    expect(clampCardPosition({ left: 200, top: 30 }, box, win, { top: 68 })).toEqual({ left: 200, top: 68 });
  });

  it("a fully-inside card keeps its whole body above the bottom margin", () => {
    expect(clampCardPosition({ left: 200, top: 5000 }, { width: 52, height: 300 }, win, { fullyInside: true })).toEqual({ left: 200, top: 900 - 300 - CARD_MARGIN });
  });

  it("a card taller than the room sits at the top limit instead of flipping", () => {
    expect(clampCardPosition({ left: 200, top: 400 }, { width: 52, height: 2000 }, win, { top: 68, fullyInside: true })).toEqual({ left: 200, top: 68 });
  });
});

describe("topBarLimit", () => {
  it("is the top bar's lower edge plus the margin, read from the DOM; 0 without a top bar", () => {
    expect(topBarLimit()).toBe(0);
    document.body.insertAdjacentHTML("beforeend", '<header id="topbar"></header>');
    const bar = document.getElementById("topbar");
    bar.getBoundingClientRect = () => ({ bottom: 60 });
    expect(topBarLimit()).toBe(60 + CARD_MARGIN);
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
    expect([other.style.left, other.style.top]).toEqual([`${1440 - 256 - CARD_MARGIN}px`, `${900 - CARD_MIN_VISIBLE}px`]);
  });

  it("corrects a saved position under the top bar to the nearest valid one on load, and again when the window resizes", () => {
    document.body.insertAdjacentHTML("beforeend", '<header id="topbar"></header>');
    document.getElementById("topbar").getBoundingClientRect = () => ({ bottom: 60 });
    makeCardDraggable({ cardEl: card, gripEl: grip, storage: memoryStorage({ pos: "300,10" }), key: "pos" });
    expect([card.style.left, card.style.top]).toEqual(["300px", `${60 + CARD_MARGIN}px`]);
    card.style.top = "20px"; // e.g. the top bar grew
    window.dispatchEvent(new Event("resize"));
    expect(card.style.top).toBe(`${60 + CARD_MARGIN}px`);
    window.innerWidth = 400; // a narrower window pulls the card back in
    window.dispatchEvent(new Event("resize"));
    expect(card.style.left).toBe(`${400 - 256 - CARD_MARGIN}px`);
  });

  it("a drag cannot take the card above the top bar", () => {
    document.body.insertAdjacentHTML("beforeend", '<header id="topbar"></header>');
    document.getElementById("topbar").getBoundingClientRect = () => ({ bottom: 60 });
    makeCardDraggable({ cardEl: card, gripEl: grip, storage: memoryStorage(), key: "pos" });
    pointer(grip, "pointerdown", 30, 100, { button: 0 });
    pointer(window, "pointermove", 30, -500);
    expect(card.style.top).toBe(`${60 + CARD_MARGIN}px`);
    pointer(window, "pointerup", 30, -500);
  });

  it("hooks: onDragMove sees the pointer and can re-anchor, onDragEnd can take over the placement, canPlace false skips the saved position", () => {
    const storage = memoryStorage({ pos: "300,120" });
    const seen = [];
    makeCardDraggable({
      cardEl: card,
      gripEl: grip,
      storage,
      key: "pos",
      canPlace: () => false,
      onDragMove: ({ x, y }) => void seen.push([x, y]),
      onDragEnd: () => true,
    });
    expect(card.style.left).toBe("");
    pointer(grip, "pointerdown", 30, 100, { button: 0 });
    pointer(window, "pointermove", 40, 110);
    pointer(window, "pointerup", 40, 110);
    expect(seen).toEqual([[40, 110]]);
    expect(storage.map.get("pos")).toBe("300,120"); // onDragEnd placed the card: nothing saved over it
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
