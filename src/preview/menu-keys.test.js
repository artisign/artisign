// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { handleListArrowKeys, setRovingTabindex, tabbableWithin, trapFocus } from "./menu-keys.js";

const key = (k, target, init = {}) => {
  const evt = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(evt, "target", { value: target });
  return evt;
};

let rows;
beforeEach(() => {
  document.body.innerHTML = '<div id="c"><button id="a"></button><button id="b"></button><button id="d"></button></div>';
  rows = [...document.querySelectorAll("#c button")];
});

describe("handleListArrowKeys", () => {
  it("moves with Arrow keys, Home and End, wrapping by default", () => {
    rows[0].focus();
    expect(handleListArrowKeys(key("ArrowDown", rows[0]), rows)).toBe(true);
    expect(document.activeElement).toBe(rows[1]);
    handleListArrowKeys(key("End", rows[1]), rows);
    expect(document.activeElement).toBe(rows[2]);
    handleListArrowKeys(key("ArrowDown", rows[2]), rows);
    expect(document.activeElement).toBe(rows[0]);
    handleListArrowKeys(key("ArrowUp", rows[0]), rows);
    expect(document.activeElement).toBe(rows[2]);
    handleListArrowKeys(key("Home", rows[2]), rows);
    expect(document.activeElement).toBe(rows[0]);
  });

  it("stops at the ends without wrap", () => {
    rows[2].focus();
    handleListArrowKeys(key("ArrowDown", rows[2]), rows, { wrap: false });
    expect(document.activeElement).toBe(rows[2]);
    rows[0].focus();
    handleListArrowKeys(key("ArrowUp", rows[0]), rows, { wrap: false });
    expect(document.activeElement).toBe(rows[0]);
  });

  it("enters from outside at the first (down) or last (up) row, ignores other keys and modified arrows", () => {
    expect(handleListArrowKeys(key("ArrowDown", document.body), rows)).toBe(true);
    expect(document.activeElement).toBe(rows[0]);
    document.body.focus();
    handleListArrowKeys(key("ArrowUp", document.body), rows);
    expect(document.activeElement).toBe(rows[2]);
    expect(handleListArrowKeys(key("Enter", rows[2]), rows)).toBe(false);
    expect(handleListArrowKeys(key("ArrowDown", rows[2], { altKey: true }), rows)).toBe(false);
    expect(handleListArrowKeys(key("ArrowDown", rows[2], { shiftKey: true }), rows)).toBe(false);
    expect(handleListArrowKeys(key("ArrowDown", rows[2]), [])).toBe(false);
  });

  it("prevents the default of a handled key only", () => {
    rows[0].focus();
    const down = key("ArrowDown", rows[0]);
    handleListArrowKeys(down, rows);
    expect(down.defaultPrevented).toBe(true);
    const enter = key("Enter", rows[0]);
    handleListArrowKeys(enter, rows);
    expect(enter.defaultPrevented).toBe(false);
  });
});

describe("setRovingTabindex", () => {
  it("leaves one tab stop", () => {
    setRovingTabindex(rows, rows[1]);
    expect(rows.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });
});

describe("trapFocus", () => {
  it("wraps Tab at the last and Shift+Tab at the first control", () => {
    const c = document.getElementById("c");
    rows[2].focus();
    expect(trapFocus(key("Tab", rows[2]), c)).toBe(true);
    expect(document.activeElement).toBe(rows[0]);
    expect(trapFocus(key("Tab", rows[0], { shiftKey: true }), c)).toBe(true);
    expect(document.activeElement).toBe(rows[2]);
    rows[1].focus();
    expect(trapFocus(key("Tab", rows[1]), c)).toBe(false); // the browser moves within
  });

  it("pulls focus in from outside and skips disabled / hidden controls", () => {
    document.body.insertAdjacentHTML("beforeend", "<button id='out'></button>");
    rows[0].disabled = true;
    const c = document.getElementById("c");
    c.insertAdjacentHTML("beforeend", "<div hidden><button id='h'></button></div>");
    expect(tabbableWithin(c).map((e) => e.id)).toEqual(["b", "d"]);
    document.getElementById("out").focus();
    expect(trapFocus(key("Tab", document.getElementById("out")), c)).toBe(true);
    expect(document.activeElement).toBe(rows[1]);
    expect(trapFocus(key("a", rows[1]), c)).toBe(false);
  });
});
