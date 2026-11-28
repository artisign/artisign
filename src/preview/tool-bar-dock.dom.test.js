// @vitest-environment jsdom
//
// CHR-1287 — the tool bar's two layouts: dragged into the bottom snap zone it previews and docks beside the zoom pill, dragged out it is vertical again; layout and place survive a reload.
import { describe, it, expect, beforeEach } from "vitest";
import { createToolBar } from "./tool-bar.js";
import { DOCK_ZONE } from "./tool-dock.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), map };
}

const VERTICAL = { width: 52, height: 360 };
const HORIZONTAL = { width: 400, height: 56 };
const PILL = { width: 240, height: 44, top: 840 };

/** jsdom lays nothing out: the bar's size follows its orientation, its rect its inline left/top. */
function build(storage = memoryStorage()) {
  document.body.innerHTML = `<div id="area">
    <div id="bar" role="toolbar" aria-orientation="vertical" focusgroup="toolbar wrap block">
      <button id="grip"></button><button id="fold"><span class="icon">keyboard_arrow_up</span></button><span id="live"></span>
      <div id="tools">
        <button class="tool-btn" id="a" aria-label="Comment"></button>
        <span class="tool-sep" role="separator" aria-orientation="horizontal"></span>
        <button class="tool-btn" id="b" aria-label="Notes"></button>
      </div>
    </div>
    <div id="wrap"><div id="pill"></div></div></div>`;
  const $ = (id) => document.getElementById(id);
  const size = () => ($("bar").dataset.orientation === "horizontal" ? HORIZONTAL : VERTICAL);
  Object.defineProperty($("bar"), "offsetWidth", { get: () => size().width, configurable: true });
  Object.defineProperty($("bar"), "offsetHeight", { get: () => size().height, configurable: true });
  Object.defineProperty($("bar"), "offsetParent", { get: () => $("area") });
  Object.defineProperty($("wrap"), "offsetWidth", { get: () => 1440 });
  Object.defineProperty($("pill"), "offsetWidth", { get: () => PILL.width });
  $("area").getBoundingClientRect = () => ({ left: 0, top: 0, width: 1440, height: 900, bottom: 900 });
  $("pill").getBoundingClientRect = () => ({ left: 600, top: PILL.top, width: PILL.width, height: PILL.height, bottom: PILL.top + PILL.height });
  $("bar").getBoundingClientRect = () => {
    const left = parseFloat($("bar").style.left || "16");
    const top = parseFloat($("bar").style.top || "76");
    return { left, top, right: left + size().width, bottom: top + size().height, width: size().width, height: size().height };
  };
  $("grip").getBoundingClientRect = () => ({ left: 0, top: 0, width: 20, height: 20 });
  const bar = createToolBar({ barEl: $("bar"), toolsEl: $("tools"), foldEl: $("fold"), gripEl: $("grip"), liveEl: $("live"), storage, mac: false, interest: false, dock: { pillEl: $("pill"), wrapEl: $("wrap") } });
  return { bar, storage, $ };
}

const pointer = (target, type, x, y, init = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...init }));

beforeEach(() => {
  window.innerWidth = 1440;
  window.innerHeight = 900;
});

describe("the tool bar's layout", () => {
  it("starts vertical", () => {
    const { bar, $ } = build();
    expect(bar.orientation()).toBe("vertical");
    expect([$("bar").dataset.orientation, $("bar").getAttribute("aria-orientation"), $("bar").getAttribute("focusgroup")]).toEqual(["vertical", "vertical", "toolbar wrap block"]);
  });

  it("a drag that ends in the bottom zone shows a preview while over it and docks on drop beside the zoom pill", () => {
    const { bar, storage, $ } = build();
    pointer($("grip"), "pointerdown", 20, 20, { button: 0 });
    pointer(window, "pointermove", 300, 900 - DOCK_ZONE + 10);
    const preview = document.querySelector(".tool-dock-preview");
    expect(preview.hidden).toBe(false);
    expect(parseFloat(preview.style.width)).toBe(HORIZONTAL.width);
    expect(bar.orientation()).toBe("vertical"); // a preview, not the switch itself
    pointer(window, "pointermove", 300, 200);
    expect(preview.hidden).toBe(true); // leaving the zone takes the preview away
    pointer(window, "pointermove", 300, 900 - DOCK_ZONE + 10);
    pointer(window, "pointerup", 300, 900 - DOCK_ZONE + 10);
    expect(preview.hidden).toBe(true);
    expect(bar.orientation()).toBe("horizontal");
    expect($("bar").getAttribute("aria-orientation")).toBe("horizontal");
    expect($("bar").getAttribute("focusgroup")).toBe("toolbar wrap inline");
    expect(document.querySelector(".tool-sep").getAttribute("aria-orientation")).toBe("vertical");
    // the group of bar + gap + pill is centred, the pill is pushed over by the bar's width plus the gap
    expect(parseFloat($("bar").style.left)).toBe((1440 - (HORIZONTAL.width + 12 + PILL.width)) / 2);
    expect($("wrap").style.paddingLeft).toBe(`${HORIZONTAL.width + 12}px`);
    expect(storage.map.get("artisign.tool-bar.orientation")).toBe("horizontal");
  });

  it("dragging a docked bar out of the zone makes it vertical again and frees the zoom pill", () => {
    const { bar, storage, $ } = build();
    pointer($("grip"), "pointerdown", 20, 20, { button: 0 });
    pointer(window, "pointermove", 300, 880);
    pointer(window, "pointerup", 300, 880);
    expect(bar.orientation()).toBe("horizontal");
    pointer($("grip"), "pointerdown", 330, 880, { button: 0 });
    pointer(window, "pointermove", 330, 400);
    expect(bar.orientation()).toBe("vertical");
    expect($("wrap").style.paddingLeft).toBe("");
    pointer(window, "pointerup", 330, 400);
    expect(storage.map.get("artisign.tool-bar.orientation")).toBe("vertical");
    expect(storage.map.get("artisign.tool-bar.position")).toBeDefined();
  });

  it("a vertical bar is never dragged out of the window, at the bottom either", () => {
    const { $ } = build();
    pointer($("grip"), "pointerdown", 20, 20, { button: 0 });
    pointer(window, "pointermove", 300, 100); // not in the zone
    pointer(window, "pointermove", 300, 880);
    expect(parseFloat($("bar").style.top)).toBeLessThanOrEqual(900 - VERTICAL.height - 8);
    pointer(window, "pointermove", 300, 100);
    pointer(window, "pointerup", 300, 100);
  });

  it("restores the docked layout after a reload", () => {
    const first = build();
    pointer(first.$("grip"), "pointerdown", 20, 20, { button: 0 });
    pointer(window, "pointermove", 300, 880);
    pointer(window, "pointerup", 300, 880);
    const again = build(first.storage);
    expect(again.bar.orientation()).toBe("horizontal");
    expect(parseFloat(again.$("bar").style.left)).toBe((1440 - (HORIZONTAL.width + 12 + PILL.width)) / 2);
    expect(again.$("wrap").style.paddingLeft).toBe(`${HORIZONTAL.width + 12}px`);
  });

  it("restores a vertical bar's own place after a reload", () => {
    const { $ } = build(memoryStorage({ "artisign.tool-bar.position": "300,120", "artisign.tool-bar.orientation": "vertical" }));
    expect([$("bar").style.left, $("bar").style.top]).toEqual(["300px", "120px"]);
  });

  it("a plain click on the grip never docks: the preview shows only after a real move into the zone", () => {
    const { bar, storage, $ } = build();
    pointer($("grip"), "pointerdown", 20, 20, { button: 0 });
    pointer(window, "pointerup", 20, 890); // released in the zone without a pointermove
    expect(bar.orientation()).toBe("vertical");
    expect(document.querySelector(".tool-dock-preview")).toBeNull();
    expect(storage.map.get("artisign.tool-bar.orientation")).toBeUndefined();
  });

  it("a click on a docked bar's grip keeps it docked and does not save the docked place as its own", () => {
    const { bar, storage, $ } = build(memoryStorage({ "artisign.tool-bar.orientation": "horizontal", "artisign.tool-bar.position": "300,120" }));
    pointer($("grip"), "pointerdown", 20, 20, { button: 0 });
    pointer(window, "pointerup", 20, 20);
    expect(bar.orientation()).toBe("horizontal");
    expect(storage.map.get("artisign.tool-bar.position")).toBe("300,120");
  });

  it("a docked bar swallows Left, Right and Down without announcing a move; Up leaves the dock and announces it", () => {
    const { bar, $ } = build(memoryStorage({ "artisign.tool-bar.orientation": "horizontal" }));
    const press = (key) => $("grip").dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowDown"]) {
      press(key);
      expect($("live").textContent).toBe("");
      expect(bar.orientation()).toBe("horizontal");
    }
    press("ArrowUp");
    expect(bar.orientation()).toBe("vertical");
    expect($("live").textContent).toBe("Tool bar moved up");
  });

  it("keyboard: Down at the bottom docks, Up leaves the dock", () => {
    const { bar, $ } = build(memoryStorage({ "artisign.tool-bar.position": `300,${900 - VERTICAL.height - 8}` }));
    $("grip").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(bar.orientation()).toBe("horizontal");
    $("grip").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    expect(bar.orientation()).toBe("vertical");
  });

  it("a bar that is not shown (another view hides it) leaves the zoom pill centred", () => {
    const { bar, $ } = build(memoryStorage({ "artisign.tool-bar.orientation": "horizontal" }));
    expect($("wrap").style.paddingLeft).not.toBe("");
    Object.defineProperty($("bar"), "offsetWidth", { get: () => 0, configurable: true });
    bar.syncDock();
    expect($("wrap").style.paddingLeft).toBe("");
  });
});
