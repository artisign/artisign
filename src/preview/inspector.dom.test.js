// @vitest-environment jsdom
//
// Smoke test for createInspectorPanel's list DOM: row structure, empty/error
// states and expand wiring. The expanded row *body* (readComputedDetails)
// leans on getBoundingClientRect/getComputedStyle for real layout, which
// jsdom doesn't compute — that part stays covered only by manual browser
// verification. Here getRenderedDoc always returns null, exercising the
// "waiting" fallback path instead of asserting on layout jsdom can't produce.
import { describe, it, expect } from "vitest";
import { createInspectorPanel } from "./inspector.js";

function makePanel(getRenderedDoc = () => null) {
  const listEl = document.createElement("ul");
  const emptyEl = document.createElement("p");
  const errorEl = document.createElement("p");
  const panel = createInspectorPanel({ listEl, emptyEl, errorEl }, { getRenderedDoc });
  return { panel, listEl, emptyEl, errorEl };
}

const entries = [
  { id: "root", tag: "section", componentRef: null, variant: null, tokenRefs: [] },
  { id: "btn-1", tag: "button", componentRef: "btn-primary", variant: "hover", tokenRefs: [] },
];

describe("createInspectorPanel", () => {
  it("renders one row per entry with tag/id label and a component badge", () => {
    const { panel, listEl, emptyEl } = makePanel();
    panel.setEntries(entries, "home");

    const rows = listEl.querySelectorAll(".inspector-entry");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".inspector-entry-label").textContent).toBe("<section> · root");
    expect(rows[0].querySelector(".inspector-entry-badge")).toBeNull();
    expect(rows[1].querySelector(".inspector-entry-badge").textContent).toBe("$btn-primary");
    expect(emptyEl.hidden).toBe(true);
  });

  it("shows the empty state for zero entries", () => {
    const { panel, emptyEl } = makePanel();
    panel.setEntries([], "home");
    expect(emptyEl.hidden).toBe(false);
  });

  it("expands a row on head click and falls back to the waiting note when no rendered doc is available", () => {
    const { panel, listEl } = makePanel(() => null);
    panel.setEntries(entries, "home");

    const head = listEl.querySelector(".inspector-entry-head");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    head.click();
    expect(head.getAttribute("aria-expanded")).toBe("true");

    const body = listEl.querySelector(".inspector-entry-body");
    expect(body.hidden).toBe(false);
    expect(body.querySelector(".inspector-entry-note").textContent).toMatch(/waiting/i);
  });

  it("carries expand state over a same-screen re-render, but resets it on a screen switch", () => {
    const { panel, listEl } = makePanel(() => null);
    panel.setEntries(entries, "home");
    listEl.querySelector(".inspector-entry-head").click();
    expect(listEl.querySelector(".inspector-entry-head").getAttribute("aria-expanded")).toBe("true");

    // Same screen (e.g. a design-system edit re-render) -> expand survives.
    panel.setEntries(entries, "home");
    expect(listEl.querySelector(".inspector-entry-head").getAttribute("aria-expanded")).toBe("true");
    expect(listEl.querySelector(".inspector-entry-body").hidden).toBe(false);

    // A different screen -> ids aren't stable across screens, so it resets.
    panel.setEntries(entries, "other");
    expect(listEl.querySelector(".inspector-entry-head").getAttribute("aria-expanded")).toBe("false");
    expect(listEl.querySelector(".inspector-entry-body").hidden).toBe(true);
  });

  it("setError clears the list and shows the error message", () => {
    const { panel, listEl, errorEl, emptyEl } = makePanel();
    panel.setEntries(entries, "home");
    panel.setError("boom");

    expect(listEl.querySelectorAll(".inspector-entry")).toHaveLength(0);
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe("boom");
    expect(emptyEl.hidden).toBe(true);
  });
});
