// @vitest-environment jsdom
//
// Smoke test for createInspectorPanel's list DOM: row structure, empty/error
// states and expand wiring. The expanded row *body* (readComputedDetails)
// leans on getBoundingClientRect/getComputedStyle for real layout, which
// jsdom doesn't compute — that part stays covered only by manual browser
// verification. Here getRenderedDoc always returns null, exercising the
// "waiting" fallback path instead of asserting on layout jsdom can't produce.
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll } from "vitest";
import { createInspectorPanel, updateInspectOverlay } from "./inspector.js";

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

describe("inspect outline label (CHR-780)", () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView ??= () => {}; // jsdom has none; focusEntry scrolls its row
  });
  const withInstance = [
    ...entries,
    { id: "card-1", tag: "div", componentRef: "product-card", variant: null, tokenRefs: [] },
  ];

  it("labels a component instance with its ref, and with ref · variant when it has one", () => {
    const { panel } = makePanel();
    panel.setEntries(withInstance, "home");
    panel.focusEntry("card-1");
    expect(panel.getFocusedLabel()).toBe("$product-card");
    panel.focusEntry("btn-1");
    expect(panel.getFocusedLabel()).toBe("$btn-primary · hover");
  });

  it("gives a plain element, a descendant outline and no focus no label", () => {
    const { panel } = makePanel();
    panel.setEntries(withInstance, "home");
    expect(panel.getFocusedLabel()).toBeNull();
    panel.focusEntry("root");
    expect(panel.getFocusedLabel()).toBeNull();
    panel.focusEntry("card-1", "card-1-title"); // outline is on a descendant, not the instance
    expect(panel.getFocusedLabel()).toBeNull();
  });
});

describe("updateInspectOverlay label", () => {
  const doc = () => {
    const d = document.implementation.createHTMLDocument("x");
    d.body.innerHTML = '<div id="card-1"></div>';
    return d;
  };

  it("sets and clears data-label as focus moves, and flips when there is no room above", () => {
    const overlay = document.createElement("div");
    updateInspectOverlay(overlay, doc(), "card-1", "$product-card · dark");
    expect(overlay.dataset.label).toBe("$product-card · dark");
    expect(overlay.hidden).toBe(false);
    expect("flip" in overlay.dataset).toBe(true); // jsdom rect.top is 0 — no room above
    updateInspectOverlay(overlay, doc(), "card-1", null);
    expect("label" in overlay.dataset).toBe(false);
  });

  it("does not flip when the element sits low enough", () => {
    const overlay = document.createElement("div");
    const d = doc();
    d.getElementById("card-1").getBoundingClientRect = () => ({ left: 0, top: 80, width: 10, height: 10 });
    updateInspectOverlay(overlay, d, "card-1", "$x");
    expect("flip" in overlay.dataset).toBe(false);
  });
});

describe("updateInspectOverlay label display (CHR-780 review)", () => {
  const docAt = (rect) => {
    const d = document.implementation.createHTMLDocument("x");
    d.body.innerHTML = '<div id="n"></div>';
    d.getElementById("n").getBoundingClientRect = () => ({ left: 0, top: 80, width: 10, height: 10, ...rect });
    return d;
  };
  const holderWith = (zoom, width = 390) => {
    const holder = document.createElement("div");
    holder.style.setProperty("--zoom", String(zoom));
    Object.defineProperty(holder, "clientWidth", { value: width });
    const overlay = document.createElement("div");
    holder.appendChild(overlay);
    return overlay;
  };

  it("measures the flip room in iframe px, i.e. on-screen room divided by zoom", () => {
    const overlay = holderWith(0.5);
    updateInspectOverlay(overlay, docAt({ top: 30 }), "n", "$x"); // 22 / 0.5 = 44 px needed
    expect("flip" in overlay.dataset).toBe(true);
    updateInspectOverlay(overlay, docAt({ top: 60 }), "n", "$x");
    expect("flip" in overlay.dataset).toBe(false);
  });

  it("sets the clamp offset for an element scrolled above the viewport", () => {
    const overlay = holderWith(1);
    updateInspectOverlay(overlay, docAt({ top: -40 }), "n", "$x");
    expect(overlay.style.getPropertyValue("--label-clamp")).toBe("40px");
    updateInspectOverlay(overlay, docAt({ top: 80 }), "n", "$x");
    expect(overlay.style.getPropertyValue("--label-clamp")).toBe("0px");
  });

  it("right-aligns a label that would cross the holder's right edge, and never truncates", () => {
    const overlay = holderWith(1, 390);
    updateInspectOverlay(overlay, docAt({ left: 10 }), "n", "$product-card");
    expect("alignRight" in overlay.dataset).toBe(false);
    updateInspectOverlay(overlay, docAt({ left: 340 }), "n", "$product-card");
    expect("alignRight" in overlay.dataset).toBe(true);
    const css = readFileSync("src/preview/style.css", "utf8");
    const rule = css.slice(css.indexOf("#inspect-overlay[data-label]::after"), css.indexOf("}", css.indexOf("#inspect-overlay[data-label]::after")));
    expect(rule).not.toMatch(/max-width|text-overflow|overflow/);
    expect(rule).toContain("scale(calc(1 / var(--zoom, 1)))");
  });
});
