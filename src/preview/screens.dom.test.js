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
});
