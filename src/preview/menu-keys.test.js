// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { captureFocus, handleListArrowKeys, setRovingTabindex, tabbableWithin, trapFocus, wireMenu } from "./menu-keys.js";

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

describe("trapFocus with nothing tabbable", () => {
  it("lands focus on the container itself (it needs tabindex -1 to take it)", () => {
    document.body.innerHTML = '<section id="d" tabindex="-1"><p>text only</p></section><button id="out"></button>';
    const d = document.getElementById("d");
    document.getElementById("out").focus();
    expect(trapFocus(key("Tab", document.activeElement), d)).toBe(true);
    expect(document.activeElement).toBe(d);
  });
});

describe("captureFocus", () => {
  it("puts focus back on the element with the same key after a rebuild, else on the fallback, else nowhere", () => {
    document.body.innerHTML = '<div id="c"><button data-key="a"></button><button data-key="b"></button></div><button id="out"></button>';
    const c = document.getElementById("c");
    c.querySelector('[data-key="b"]').focus();
    let restore = captureFocus(c, "data-key", () => c.querySelector("button"));
    c.innerHTML = '<button data-key="a"></button><button data-key="b"></button>';
    expect(restore()).toBe(c.querySelector('[data-key="b"]'));
    expect(document.activeElement).toBe(c.querySelector('[data-key="b"]'));
    restore = captureFocus(c, "data-key", () => c.querySelector("button"));
    c.innerHTML = '<button data-key="a"></button>';
    expect(restore()).toBe(c.querySelector('[data-key="a"]'));
    document.getElementById("out").focus();
    restore = captureFocus(c, "data-key", () => c.querySelector("button"));
    expect(restore()).toBeUndefined();
    expect(document.activeElement).toBe(document.getElementById("out"));
  });
});

describe("wireMenu tab-out", () => {
  it("fires for a keyboard Tab only, not for a pointer or programmatic focus move", async () => {
    document.body.innerHTML = '<div id="m"><button id="r1"></button></div><button id="out"></button>';
    const m = document.getElementById("m");
    const outs = [];
    wireMenu(m, () => [...m.querySelectorAll("button")], { onTabOut: (to) => outs.push(to.id) });
    const later = () => new Promise((r) => setTimeout(r, 5));
    document.getElementById("r1").focus();
    document.getElementById("out").focus(); // e.g. mousedown on another control
    await later();
    expect(outs).toEqual([]);
    document.getElementById("r1").focus();
    document.getElementById("r1").dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    document.getElementById("out").focus(); // the focus move the Tab caused
    await later();
    expect(outs).toEqual(["out"]);
    // A Tab that keeps focus inside the menu is not a tab-out; a later pointer-style move is not either.
    document.getElementById("r1").dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    document.getElementById("r1").focus();
    await later();
    document.getElementById("out").focus();
    await later();
    expect(outs).toEqual(["out"]);
  });
});
