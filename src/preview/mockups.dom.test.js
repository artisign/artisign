// @vitest-environment jsdom
//
// Smoke tests for renderMockupList's DOM output — structure, aria state and
// click wiring only. filterMockups (the actual filtering logic) is tested
// directly in mockups.test.js under the fast node environment; this file
// exists solely because renderMockupList needs a real `document`. Mirrors
// screens.dom.test.js.
import { describe, it, expect } from "vitest";
import { renderMockupList } from "./mockups.js";

describe("renderMockupList", () => {
  const mockups = [
    { name: "checkout-redesign", title: "Checkout Redesign", tags: ["checkout", "payment"], variants: [{ id: "a" }, { id: "b" }] },
    { name: "onboarding", variants: [{ id: "a" }] },
  ];

  it("renders one row per mockup with title, a badge and the variant count", () => {
    const listEl = document.createElement("ul");
    renderMockupList(listEl, mockups, { activeName: null, onSelect: () => {} });

    const items = listEl.querySelectorAll("li");
    expect(items).toHaveLength(2);

    const [checkoutBtn, onboardingBtn] = listEl.querySelectorAll("button.mockup-item");
    expect(checkoutBtn.querySelector(".mockup-item-name").textContent).toBe("Checkout Redesign");
    expect(checkoutBtn.querySelector(".mockup-item-badge").textContent).toBe("Mockup");
    expect(checkoutBtn.querySelector(".mockup-item-sub").textContent).toBe("2 variants");
    // No title -> falls back to the raw name.
    expect(onboardingBtn.querySelector(".mockup-item-name").textContent).toBe("onboarding");
    expect(onboardingBtn.querySelector(".mockup-item-sub").textContent).toBe("1 variant");
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
