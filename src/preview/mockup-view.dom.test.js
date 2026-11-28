// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderMockupView, markSelectedColumn } from "./mockup-view.js";

/** Flushes the microtask queue so a resolved/rejected fetchRenderFor promise's .then() has run. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("renderMockupView", () => {
  it("names each column '<mockup title>: <variant title>' and marks the selected variant's column", () => {
    const container = document.createElement("div");
    const mockup = { name: "cart", title: "Cart options", variants: [{ id: "a", title: "Sticky total" }, { id: "b", title: "" }] };
    const columns = renderMockupView(container, mockup, { fetchRenderFor: () => new Promise(() => {}) });
    const groups = container.querySelectorAll(".mockup-column");
    expect(groups[0].getAttribute("role")).toBe("group");
    expect(groups[0].getAttribute("aria-label")).toBe("Cart options: Sticky total");
    expect(groups[1].getAttribute("aria-label")).toBe("Cart options: b"); // no title: the id
    expect(columns.map((c) => c.columnEl)).toEqual([...groups]);

    markSelectedColumn(columns, "b");
    expect([...groups].map((g) => g.classList.contains("is-selected"))).toEqual([false, true]);
    expect(groups[1].getAttribute("aria-current")).toBe("true");
    expect(groups[0].hasAttribute("aria-current")).toBe(false);
    markSelectedColumn(columns, null);
    expect([...groups].some((g) => g.classList.contains("is-selected") || g.hasAttribute("aria-current"))).toBe(false);
  });

  it("keeps the mockup's title and description for assistive tech only (the canvas shows the columns)", () => {
    const container = document.createElement("div");
    renderMockupView(container, { name: "m", title: "M", description: "d", variants: [] }, { fetchRenderFor: () => new Promise(() => {}) });
    expect(container.querySelector(".mockup-view-header").classList.contains("visually-hidden")).toBe(true);
  });

  it("renders the hidden mockup header and one column per variant in order", () => {
    const container = document.createElement("div");
    const mockup = {
      name: "checkout-redesign",
      title: "Checkout Redesign",
      description: "Comparing two approaches to the cart step.",
      variants: [
        { id: "a", title: "Variant A", description: "Single page" },
        { id: "b", title: "Variant B" },
      ],
    };
    renderMockupView(container, mockup, { fetchRenderFor: () => new Promise(() => {}) });

    expect(container.querySelector(".mockup-view-header h1").textContent).toBe("Checkout Redesign");
    expect(container.querySelector(".mockup-view-description").textContent).toBe(
      "Comparing two approaches to the cart step.",
    );

    const columns = container.querySelectorAll(".mockup-column");
    expect(columns).toHaveLength(2);
    const [labelA, labelB] = [...columns].map((c) => c.querySelector(".mockup-column-label"));
    // The frame label: the mockup icon, the variant's letter, "<mockup title>: <variant title>", then the count chips' slot.
    expect(labelA.querySelector(".frame-label-icon").textContent).toBe("view_column");
    expect(labelA.querySelector(".frame-label-name").textContent).toBe("A");
    expect(labelA.querySelector(".frame-label-detail").textContent).toBe("Checkout Redesign: Variant A");
    expect(labelA.lastElementChild.classList.contains("mockup-column-counts")).toBe(true);
    expect(labelB.querySelector(".frame-label-name").textContent).toBe("B");
    expect(labelB.querySelector(".frame-label-detail").textContent).toBe("Checkout Redesign: Variant B");
    // The variant's description is the label's tooltip; none -> no tooltip.
    expect(labelA.dataset.tooltip).toBe("Single page");
    expect(labelB.hasAttribute("data-tooltip")).toBe(false);
    expect(container.querySelector(".mockup-column-description, .mockup-column-title, .mockup-column-index")).toBeNull();
  });

  it("puts the count chips next to the label, inside the counter-scaled head", () => {
    const container = document.createElement("div");
    const columns = renderMockupView(container, { name: "m", variants: [{ id: "a", title: "" }] }, { fetchRenderFor: () => new Promise(() => {}) });
    const label = container.querySelector(".mockup-column-head > .mockup-column-label");
    expect(label.querySelector(".frame-label-detail").textContent).toBe("m: a"); // no titles: the name and the id
    expect(label.contains(columns[0].countsEl)).toBe(true);
  });

  it("falls back to the mockup's name when it has no title", () => {
    const container = document.createElement("div");
    renderMockupView(
      container,
      { name: "onboarding", variants: [] },
      { fetchRenderFor: () => new Promise(() => {}) },
    );
    expect(container.querySelector(".mockup-view-header h1").textContent).toBe("onboarding");
  });

  it("gives each variant a sandboxed iframe and sets its srcdoc once the fetch resolves", async () => {
    const container = document.createElement("div");
    const fetchRenderFor = vi.fn((variantId) => Promise.resolve({ ok: true, html: `<p>${variantId}</p>` }));
    renderMockupView(
      container,
      { name: "onboarding", variants: [{ id: "a", title: "Variant A" }] },
      { fetchRenderFor },
    );

    const iframe = container.querySelector(".mockup-column iframe");
    expect(iframe.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(fetchRenderFor).toHaveBeenCalledWith("a");
    expect(iframe.srcdoc).toBe(""); // not set yet — the fetch hasn't resolved

    await flush();
    expect(iframe.srcdoc).toBe("<p>a</p>");
  });

  it("shows the error message in the column's error slot when the fetch fails", async () => {
    const container = document.createElement("div");
    renderMockupView(
      container,
      { name: "onboarding", variants: [{ id: "a", title: "Variant A" }] },
      { fetchRenderFor: () => Promise.resolve({ ok: false, message: "not found" }) },
    );

    const errorEl = container.querySelector(".mockup-column-error");
    expect(errorEl.hidden).toBe(true);

    await flush();
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe("not found");
  });

  it("shows an empty-state message and no columns when the mockup has no variants", () => {
    const container = document.createElement("div");
    renderMockupView(container, { name: "onboarding", variants: [] }, { fetchRenderFor: () => new Promise(() => {}) });

    expect(container.querySelector(".mockup-view-empty").textContent).toBe("No variants yet.");
    expect(container.querySelectorAll(".mockup-column")).toHaveLength(0);
  });

  it("does not throw when the iframe's load event fires without a rendered document (jsdom never actually navigates srcdoc iframes)", async () => {
    const container = document.createElement("div");
    renderMockupView(
      container,
      { name: "onboarding", variants: [{ id: "a", title: "Variant A" }] },
      { fetchRenderFor: () => Promise.resolve({ ok: true, html: "<p>a</p>" }) },
    );
    await flush();

    const iframe = container.querySelector(".mockup-column iframe");
    expect(() => iframe.dispatchEvent(new Event("load"))).not.toThrow();
  });

  it("calls onColumnMeasured for every column only once its iframe's final size is known — never while the height is still the CSS placeholder", async () => {
    const container = document.createElement("div");
    const heightsAtCall = [];
    const onColumnMeasured = vi.fn(() => {
      heightsAtCall.push([...container.querySelectorAll(".mockup-column iframe")].map((f) => f.style.height));
    });
    renderMockupView(
      container,
      { name: "a", variants: [{ id: "1", title: "V1" }, { id: "2", title: "V2" }] },
      { fetchRenderFor: () => Promise.resolve({ ok: true, html: "<p>x</p>" }), onColumnMeasured },
    );
    await flush();
    expect(onColumnMeasured).not.toHaveBeenCalled(); // nothing loaded yet

    const iframes = [...container.querySelectorAll(".mockup-column iframe")];
    for (const iframe of iframes) {
      // jsdom never actually navigates a srcdoc iframe — stub contentDocument
      // the way createFittingIframe (iframe-fit.js) reads it, so its `load`
      // listener runs its real width/height/onFitted logic instead of
      // bailing out on a missing documentElement.
      Object.defineProperty(iframe, "contentDocument", {
        configurable: true,
        value: { documentElement: { scrollWidth: 300, scrollHeight: 900 } },
      });
      iframe.dispatchEvent(new Event("load"));
      // Fitted synchronously on load, no animation frame needed.
      expect(iframe.style.height).toBe("900px");
    }
    expect(onColumnMeasured).toHaveBeenCalled();
    // Every call (fit, and again after the column took the frame's width) saw the first column already sized.
    expect(heightsAtCall.every((heights) => heights[0] === "900px")).toBe(true);
    expect(heightsAtCall.at(-1)).toEqual(["900px", "900px"]);
  });

  it("clears previous content on re-render", () => {
    const container = document.createElement("div");
    renderMockupView(
      container,
      { name: "a", variants: [{ id: "1", title: "V1" }, { id: "2", title: "V2" }] },
      { fetchRenderFor: () => new Promise(() => {}) },
    );
    renderMockupView(container, { name: "b", variants: [{ id: "1", title: "V1" }] }, { fetchRenderFor: () => new Promise(() => {}) });
    expect(container.querySelectorAll(".mockup-column")).toHaveLength(1);
  });
});
