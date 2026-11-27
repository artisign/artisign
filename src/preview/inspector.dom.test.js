// @vitest-environment jsdom
//
// Smoke test for createInspectorPanel's list DOM: row structure, empty/error
// states and expand wiring. The expanded row *body* (readComputedDetails)
// leans on getBoundingClientRect/getComputedStyle for real layout, which
// jsdom doesn't compute — that part stays covered only by manual browser
// verification. Here getRenderedDoc always returns null, exercising the
// "waiting" fallback path instead of asserting on layout jsdom can't produce.
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createInspectorPanel, updateInspectOverlay } from "./inspector.js";

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {}; // jsdom has none; a selection scrolls its row into view
});

function makePanel(getRenderedDoc = () => null, onSelect) {
  const els = Object.fromEntries(["listEl:ul", "emptyEl:p", "errorEl:p", "summaryEl:div", "detailsEl:div"].map((s) => {
    const [key, tag] = s.split(":");
    return [key, document.createElement(tag)];
  }));
  const panel = createInspectorPanel(els, { getRenderedDoc, onSelect });
  return { panel, ...els };
}

const entries = [
  { id: "root", tag: "section", parentId: null, componentRef: null, variant: null, tokenRefs: [] },
  { id: "btn-1", tag: "button", parentId: "root", componentRef: "btn-primary", variant: "hover", tokenRefs: [{ property: "background", ref: "color.primary" }] },
  { id: "label", tag: "span", parentId: "btn-1", componentRef: null, variant: null, tokenRefs: [] },
];
const ids = (listEl) => [...listEl.querySelectorAll("[role=treeitem]")].map((li) => li.dataset.entry);

describe("createInspectorPanel — the Layers tree", () => {
  it("renders node-rows (treeitems with chevron, tag and id), the roots open one level, deeper levels behind their chevron", () => {
    const { panel, listEl, emptyEl } = makePanel();
    panel.setEntries(entries, "home");
    expect(ids(listEl)).toEqual(["root", "btn-1"]); // label sits under the closed btn-1
    const rows = listEl.querySelectorAll("[role=treeitem]");
    expect(rows[0].getAttribute("aria-expanded")).toBe("true");
    expect(rows[1].getAttribute("aria-expanded")).toBe("false");
    expect(rows[1].getAttribute("aria-level")).toBe("2");
    expect(rows[1].querySelector(".node-row-tag").textContent).toBe("button");
    expect(rows[1].querySelector(".node-row-id").textContent).toBe("btn-1");
    expect(rows[1].querySelector(".inspector-entry-badge").textContent).toBe("$btn-primary");
    expect(emptyEl.hidden).toBe(true);
    rows[1].querySelector(".node-row-chev").click();
    expect(ids(listEl)).toEqual(["root", "btn-1", "label"]);
    listEl.querySelector('[data-entry="root"] .node-row-chev').click();
    expect(ids(listEl)).toEqual(["root"]);
  });

  it("shows the empty state for zero entries", () => {
    const { panel, emptyEl } = makePanel();
    panel.setEntries([], "home");
    expect(emptyEl.hidden).toBe(false);
  });

  it("selecting opens the ancestors, tints the row (aria-selected) and fills the summary: the id and 'tag in ancestors'", () => {
    const { panel, listEl, summaryEl } = makePanel();
    panel.setEntries(entries, "home");
    panel.focusEntry("label");
    expect(ids(listEl)).toEqual(["root", "btn-1", "label"]);
    const selected = listEl.querySelector('[aria-selected="true"]');
    expect(selected.dataset.entry).toBe("label");
    expect(summaryEl.hidden).toBe(false);
    expect(summaryEl.querySelector(".inspect-summary-id").textContent).toBe("label");
    expect(summaryEl.querySelector(".inspect-summary-sub").textContent).toBe("span in btn-1, root");
    panel.clearFocus();
    expect(summaryEl.hidden).toBe(true);
    expect(listEl.querySelector('[aria-selected="true"]')).toBeNull();
  });

  it("a click on a row selects it through onSelect (the canvas outline follows), or by itself without one", () => {
    const picked = [];
    const { panel, listEl } = makePanel(() => null, (id) => picked.push(id));
    panel.setEntries(entries, "home");
    listEl.querySelector('[data-entry="btn-1"]').click();
    expect(picked).toEqual(["btn-1"]);
    const bare = makePanel();
    bare.panel.setEntries(entries, "home");
    bare.listEl.querySelector('[data-entry="btn-1"]').click();
    expect(bare.panel.getFocusedDomId()).toBe("btn-1");
  });

  it("without a rendered document the sections wait; a part of an instance names its instance", () => {
    const { panel, detailsEl, summaryEl } = makePanel(() => null);
    panel.setEntries(entries, "home");
    panel.focusEntry("btn-1", "btn-1--label");
    expect(detailsEl.querySelector(".inspector-entry-note").textContent).toMatch(/waiting/i);
    expect(summaryEl.querySelector(".inspect-summary-id").textContent).toBe("btn-1--label");
    expect(summaryEl.querySelector(".inspect-summary-sub").textContent).toBe("part of btn-1");
  });

  it("carries the selection and the opened levels over a same-screen re-render, but resets both on a screen switch", () => {
    const { panel, listEl } = makePanel();
    panel.setEntries(entries, "home");
    panel.focusEntry("label");
    panel.setEntries(entries, "home");
    expect(panel.getFocusedDomId()).toBe("label");
    expect(ids(listEl)).toEqual(["root", "btn-1", "label"]);
    panel.setEntries(entries, "other");
    expect(panel.getFocusedDomId()).toBeNull();
    expect(ids(listEl)).toEqual(["root", "btn-1"]);
  });

  it("setError clears the list and shows the error message", () => {
    const { panel, listEl, errorEl, emptyEl } = makePanel();
    panel.setEntries(entries, "home");
    panel.setError("boom");
    expect(listEl.querySelectorAll("[role=treeitem]")).toHaveLength(0);
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe("boom");
    expect(emptyEl.hidden).toBe(true);
  });
});

describe("createInspectorPanel — the Layers tree keyboard pattern", () => {
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const row = (listEl, id) => listEl.querySelector(`[data-entry="${id}"]`);
  const tabbable = (listEl) => [...listEl.querySelectorAll("[role=treeitem]")].filter((li) => li.tabIndex === 0).map((li) => li.dataset.entry);

  it("roving tabindex: exactly one row is tabbable, the first (or the selected one)", () => {
    const { panel, listEl } = makePanel();
    document.body.append(listEl);
    panel.setEntries(entries, "home");
    expect(tabbable(listEl)).toEqual(["root"]);
    panel.focusEntry("label");
    expect(tabbable(listEl)).toEqual(["label"]);
  });

  it("Up/Down/Home/End walk the visible rows and move focus with the tab stop", () => {
    const { panel, listEl } = makePanel();
    document.body.append(listEl);
    panel.setEntries(entries, "home"); // root, btn-1 visible
    row(listEl, "root").focus();
    key(row(listEl, "root"), "ArrowDown");
    expect(document.activeElement.dataset.entry).toBe("btn-1");
    expect(tabbable(listEl)).toEqual(["btn-1"]);
    key(row(listEl, "btn-1"), "ArrowDown"); // already last
    expect(document.activeElement.dataset.entry).toBe("btn-1");
    key(row(listEl, "btn-1"), "ArrowUp");
    expect(document.activeElement.dataset.entry).toBe("root");
    key(row(listEl, "root"), "End");
    expect(document.activeElement.dataset.entry).toBe("btn-1");
    key(row(listEl, "btn-1"), "Home");
    expect(document.activeElement.dataset.entry).toBe("root");
  });

  it("Right opens a closed parent, then enters its first child; Left closes an open one, then goes to the parent; aria-expanded follows and focus stays on the row", () => {
    const { panel, listEl } = makePanel();
    document.body.append(listEl);
    panel.setEntries(entries, "home");
    row(listEl, "btn-1").focus();
    key(row(listEl, "btn-1"), "ArrowRight");
    expect(row(listEl, "btn-1").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement.dataset.entry).toBe("btn-1"); // re-rendered, focus kept
    key(row(listEl, "btn-1"), "ArrowRight");
    expect(document.activeElement.dataset.entry).toBe("label");
    key(row(listEl, "label"), "ArrowRight"); // a leaf: nothing
    expect(document.activeElement.dataset.entry).toBe("label");
    key(row(listEl, "label"), "ArrowLeft"); // a leaf goes to its parent
    expect(document.activeElement.dataset.entry).toBe("btn-1");
    key(row(listEl, "btn-1"), "ArrowLeft");
    expect(row(listEl, "btn-1").getAttribute("aria-expanded")).toBe("false");
    expect(ids(listEl)).toEqual(["root", "btn-1"]);
    expect(document.activeElement.dataset.entry).toBe("btn-1");
  });

  it("Enter and Space select the row (onSelect) and aria-selected marks it", () => {
    const picked = [];
    const { panel, listEl } = makePanel(() => null, (id) => picked.push(id));
    document.body.append(listEl);
    panel.setEntries(entries, "home");
    key(row(listEl, "btn-1"), "Enter");
    key(row(listEl, "root"), " ");
    expect(picked).toEqual(["btn-1", "root"]);
    const bare = makePanel();
    document.body.append(bare.listEl);
    bare.panel.setEntries(entries, "home");
    key(row(bare.listEl, "btn-1"), "Enter");
    expect(row(bare.listEl, "btn-1").getAttribute("aria-selected")).toBe("true");
  });
});

describe("createInspectorPanel — Box, Design system, Type", () => {
  it("lists the box, the refs with their resolved values and the font of the selection", () => {
    const doc = document.implementation.createHTMLDocument("x");
    doc.body.innerHTML = '<div id="root"><button id="btn-1"></button></div>';
    doc.getElementById("root").getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 });
    doc.getElementById("btn-1").getBoundingClientRect = () => ({ left: 7, top: 9, width: 93, height: 34 });
    // jsdom computes no layout or cascade: the computed style is answered by hand.
    const spy = vi.spyOn(window, "getComputedStyle").mockReturnValue({ fontSize: "11.5px", fontWeight: "600", getPropertyValue: (p) => (p === "background-color" ? "rgb(15, 138, 126)" : "") });
    try {
      const { panel, detailsEl } = makePanel(() => doc);
      panel.setEntries(entries, "home");
      panel.focusEntry("btn-1");
      expect([...detailsEl.querySelectorAll(".tool-section-head")].map((h) => h.textContent)).toEqual(["Boxpx", "Design system2 refs", "Type"]);
      expect([...detailsEl.querySelectorAll(".prop-row")].map((r) => r.textContent)).toEqual(["Size93 × 34", "Positionx 7, y 9", "Component$btn-primaryhover", "Fill$color.primary#0f8a7e", "Font11.5px, 600"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("inspect outline label (CHR-780)", () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView ??= () => {}; // jsdom has none; focusEntry scrolls its row
  });
  const withInstance = [
    ...entries,
    { id: "card-1", tag: "div", parentId: "root", componentRef: "product-card", variant: null, tokenRefs: [] },
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
