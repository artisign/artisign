// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createFittingIframe } from "./iframe-fit.js";

/** Stubs contentDocument the way createFittingIframe reads it — jsdom never actually navigates a srcdoc iframe. */
function stubContentDocument(iframe, { scrollWidth, scrollHeight }) {
  Object.defineProperty(iframe, "contentDocument", {
    configurable: true,
    value: { documentElement: { scrollWidth, scrollHeight } },
  });
}

describe("createFittingIframe", () => {
  it("is sandboxed to allow-same-origin only, never allow-scripts", () => {
    const iframe = createFittingIframe();
    expect(iframe.getAttribute("sandbox")).toBe("allow-same-origin");
  });

  it("sets width synchronously on load, but defers height to the next animation frame", async () => {
    const iframe = createFittingIframe();
    stubContentDocument(iframe, { scrollWidth: 300, scrollHeight: 900 });
    iframe.dispatchEvent(new Event("load"));

    expect(iframe.style.width).toBe("300px");
    expect(iframe.style.height).toBe(""); // not yet — one rAF still pending

    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(iframe.style.height).toBe("900px");
  });

  it("calls onFitted once, only after both dimensions are final", async () => {
    const calls = [];
    const iframe = createFittingIframe(() => calls.push(iframe.style.height));
    stubContentDocument(iframe, { scrollWidth: 300, scrollHeight: 900 });
    iframe.dispatchEvent(new Event("load"));

    expect(calls).toHaveLength(0); // must not fire at load, while height is still a placeholder

    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(calls).toEqual(["900px"]);
  });

  it("does not throw, and never calls onFitted, when load fires without a rendered document", async () => {
    const onFitted = () => {
      throw new Error("must not be called");
    };
    const iframe = createFittingIframe(onFitted);
    expect(() => iframe.dispatchEvent(new Event("load"))).not.toThrow();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
});
