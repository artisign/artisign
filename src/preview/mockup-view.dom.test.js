// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderMockupView } from "./mockup-view.js";

/** Flushes the microtask queue so a resolved/rejected fetchRenderFor promise's .then() has run. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("renderMockupView", () => {
  it("renders the header (title/description) and one column per variant in order", () => {
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
    expect(columns[0].querySelector(".mockup-column-index").textContent).toBe("Variant 1");
    expect(columns[0].querySelector(".mockup-column-title").textContent).toBe("Variant A");
    expect(columns[0].querySelector(".mockup-column-description").textContent).toBe("Single page");
    expect(columns[1].querySelector(".mockup-column-index").textContent).toBe("Variant 2");
    expect(columns[1].querySelector(".mockup-column-title").textContent).toBe("Variant B");
    // No description on variant B -> no description element at all.
    expect(columns[1].querySelector(".mockup-column-description")).toBeNull();
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

  it("calls onColumnMeasured once per column, only once its iframe's FINAL size (post-rAF) is known — not at load, while height is still a placeholder", async () => {
    const container = document.createElement("div");
    const onColumnMeasured = vi.fn();
    renderMockupView(
      container,
      { name: "a", variants: [{ id: "1", title: "V1" }, { id: "2", title: "V2" }] },
      { fetchRenderFor: () => Promise.resolve({ ok: true, html: "<p>x</p>" }), onColumnMeasured },
    );
    await flush();

    for (const iframe of container.querySelectorAll(".mockup-column iframe")) {
      // jsdom never actually navigates a srcdoc iframe — stub contentDocument
      // the way createFittingIframe (iframe-fit.js) reads it, so its `load`
      // listener runs its real width/height/onFitted logic instead of
      // bailing out on a missing documentElement.
      Object.defineProperty(iframe, "contentDocument", {
        configurable: true,
        value: { documentElement: { scrollWidth: 300, scrollHeight: 900 } },
      });
      iframe.dispatchEvent(new Event("load"));
    }
    // onFitted (and so onColumnMeasured) fires one animation frame after
    // load, once the real height replaces the CSS-default placeholder —
    // asserting BEFORE that frame proves the callback isn't (mis)called early.
    expect(onColumnMeasured).not.toHaveBeenCalled();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(onColumnMeasured).toHaveBeenCalledTimes(2);
    for (const iframe of container.querySelectorAll(".mockup-column iframe")) {
      expect(iframe.style.height).toBe("900px");
    }
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
