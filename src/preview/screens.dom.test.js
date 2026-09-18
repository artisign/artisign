// @vitest-environment jsdom
//
// Smoke tests for renderScreenList's DOM output — structure, aria state and
// click wiring only. filterScreens (the actual filtering logic) is tested
// directly in screens.test.js under the fast node environment; this file
// exists solely because renderScreenList needs a real `document`.
import { describe, it, expect } from "vitest";
import { renderScreenList } from "./screens.js";

describe("renderScreenList", () => {
  const screens = [
    { name: "checkout-cart", tags: ["checkout", "payment"] },
    { name: "login", tags: [] },
  ];

  it("renders one row per screen with name and tag chips", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, "login", () => {}, "");

    const items = listEl.querySelectorAll("li");
    expect(items).toHaveLength(2);

    const [cartBtn, loginBtn] = listEl.querySelectorAll("button.screen-item");
    expect(cartBtn.querySelector(".screen-item-name").textContent).toBe("checkout-cart");
    expect([...cartBtn.querySelectorAll(".tag-chip")].map((el) => el.textContent)).toEqual(["checkout", "payment"]);
    // No tags -> no tag row at all, not an empty one.
    expect(loginBtn.querySelector(".tag-row")).toBeNull();
  });

  it("marks the active screen via aria-current", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, "login", () => {}, "");

    const [cartBtn, loginBtn] = listEl.querySelectorAll("button.screen-item");
    expect(cartBtn.getAttribute("aria-current")).toBe("false");
    expect(loginBtn.getAttribute("aria-current")).toBe("true");
  });

  it("applies the filter and wires row clicks to onSelect", () => {
    const listEl = document.createElement("ul");
    const selected = [];
    renderScreenList(listEl, screens, null, (name) => selected.push(name), "checkout");

    const buttons = listEl.querySelectorAll("button.screen-item");
    expect(buttons).toHaveLength(1);
    buttons[0].click();
    expect(selected).toEqual(["checkout-cart"]);
  });

  it("clears previous content on re-render", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, null, () => {}, "");
    renderScreenList(listEl, [screens[0]], null, () => {}, "");
    expect(listEl.querySelectorAll("li")).toHaveLength(1);
  });

  it("renders no pin button at all when onTogglePin is omitted (CHR-624 — every caller before this ticket)", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, null, () => {}, "");
    expect(listEl.querySelector(".screen-item-pin")).toBeNull();
  });

  it("renders a pin button per row as a SIBLING of the select button, not nested inside it", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, null, () => {}, "", { pinned: new Set(), onTogglePin: () => {} });
    const row = listEl.querySelector("li");
    expect(row.querySelector(".screen-item .screen-item-pin")).toBeNull(); // not nested
    expect(row.children).toHaveLength(2); // button.screen-item, button.screen-item-pin
  });

  it("reflects the pinned set via aria-pressed and a pinned class", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, null, () => {}, "", { pinned: new Set(["login"]), onTogglePin: () => {} });
    const pins = [...listEl.querySelectorAll(".screen-item-pin")];
    const [cartPin, loginPin] = pins;
    expect(cartPin.getAttribute("aria-pressed")).toBe("false");
    expect(cartPin.classList.contains("pinned")).toBe(false);
    expect(loginPin.getAttribute("aria-pressed")).toBe("true");
    expect(loginPin.classList.contains("pinned")).toBe(true);
  });

  it("calls onTogglePin with the screen name, and never onSelect, when the pin button is clicked", () => {
    const listEl = document.createElement("ul");
    const selected = [];
    const toggled = [];
    renderScreenList(listEl, screens, null, (name) => selected.push(name), "", {
      pinned: new Set(),
      onTogglePin: (name) => toggled.push(name),
    });
    listEl.querySelector(".screen-item-pin").click();
    expect(toggled).toEqual(["checkout-cart"]);
    expect(selected).toEqual([]);
  });

  it("only shows a pin button for rows the filter actually shows — pinned-outside-filter is a board-only distinction", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, null, () => {}, "checkout", { pinned: new Set(["login"]), onTogglePin: () => {} });
    expect(listEl.querySelectorAll("li")).toHaveLength(1); // "login" doesn't match "checkout" — not in the list at all
  });
});
