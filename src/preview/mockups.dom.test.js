// @vitest-environment jsdom
//
// Smoke tests for renderMockupList's DOM output — structure, aria state and
// click wiring only. filterMockups (the actual filtering logic) is tested
// directly in mockups.test.js under the fast node environment; this file
// exists solely because renderMockupList needs a real `document`. Mirrors
// screens.dom.test.js.
import { describe, it, expect } from "vitest";
import { renderMockupList, mockupExpandKey } from "./mockups.js";

describe("renderMockupList", () => {
  const mockups = [
    { name: "checkout-redesign", title: "Checkout Redesign", tags: ["checkout", "payment"], variants: [{ id: "a" }, { id: "b" }] },
    { name: "onboarding", variants: [{ id: "a" }] },
  ];

  it("renders one row per mockup with the stacked-layers icon, the title and the variant count", () => {
    const listEl = document.createElement("ul");
    renderMockupList(listEl, mockups, { activeName: null, onSelect: () => {} });

    const items = listEl.querySelectorAll("li");
    expect(items).toHaveLength(2);

    const [checkoutBtn, onboardingBtn] = listEl.querySelectorAll("button.mockup-item");
    expect(checkoutBtn.querySelector(".kind-icon").textContent).toBe("layers");
    expect(checkoutBtn.querySelector(".mockup-item-name").textContent).toBe("Checkout Redesign");
    expect(checkoutBtn.querySelector(".screen-item-total").textContent).toBe("2");
    // No title -> falls back to the raw name.
    expect(onboardingBtn.querySelector(".mockup-item-name").textContent).toBe("onboarding");
    expect(onboardingBtn.querySelector(".screen-item-total").textContent).toBe("1");
  });

  it("collapses the variant tree by default and opens it for an expanded mockup; a variant row opens its mockup", () => {
    const listEl = document.createElement("ul");
    const selected = [];
    const toggled = [];
    const named = [
      { name: "checkout-redesign", title: "Checkout Redesign", variants: [{ id: "a", title: "Guided" }, { id: "b", title: "" }] },
    ];
    renderMockupList(listEl, named, { activeName: null, onSelect: (n) => selected.push(n), onToggleExpand: (k) => toggled.push(k) });
    expect(listEl.querySelector(".mockup-variant-item")).toBeNull();
    const toggle = listEl.querySelector(".screen-item-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    expect(toggled).toEqual([mockupExpandKey("checkout-redesign")]);

    renderMockupList(listEl, named, { activeName: null, onSelect: (n) => selected.push(n), expanded: new Set([mockupExpandKey("checkout-redesign")]) });
    const rows = [...listEl.querySelectorAll(".mockup-variant-item")];
    expect(rows.map((r) => r.querySelector(".screen-item-name").textContent)).toEqual(["Guided", "b"]);
    expect(rows[0].getAttribute("aria-level")).toBe("2");
    rows[1].click();
    expect(selected).toEqual(["checkout-redesign"]);
  });

  it("hides the tag chips when showTags is false", () => {
    const listEl = document.createElement("ul");
    renderMockupList(listEl, mockups, { activeName: null, onSelect: () => {}, showTags: false });
    expect(listEl.querySelector(".tag-row")).toBeNull();
  });

  it("renders tag chips reusing the screen-list chip treatment, or none when the mockup has no tags", () => {
    const listEl = document.createElement("ul");
    renderMockupList(listEl, mockups, { activeName: null, onSelect: () => {} });

    const [checkoutBtn, onboardingBtn] = listEl.querySelectorAll("button.mockup-item");
    expect([...checkoutBtn.querySelectorAll(".tag-chip")].map((el) => el.textContent)).toEqual(["checkout", "payment"]);
    expect(onboardingBtn.querySelector(".tag-row")).toBeNull();
  });

  it("marks the active mockup via aria-current", () => {
    const listEl = document.createElement("ul");
    renderMockupList(listEl, mockups, { activeName: "onboarding", onSelect: () => {} });

    const [checkoutBtn, onboardingBtn] = listEl.querySelectorAll("button.mockup-item");
    expect(checkoutBtn.getAttribute("aria-current")).toBe("false");
    expect(onboardingBtn.getAttribute("aria-current")).toBe("true");
    expect(onboardingBtn.getAttribute("aria-selected")).toBe("true");
  });

  it("wires row clicks to onSelect with the mockup's name", () => {
    const listEl = document.createElement("ul");
    const selected = [];
    renderMockupList(listEl, mockups, { activeName: null, onSelect: (name) => selected.push(name) });

    listEl.querySelectorAll("button.mockup-item")[1].click();
    expect(selected).toEqual(["onboarding"]);
  });

  it("clears previous content on re-render", () => {
    const listEl = document.createElement("ul");
    renderMockupList(listEl, mockups, { activeName: null, onSelect: () => {} });
    renderMockupList(listEl, [mockups[0]], { activeName: null, onSelect: () => {} });
    expect(listEl.querySelectorAll("li")).toHaveLength(1);
  });
});
