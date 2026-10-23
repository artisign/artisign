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

  it("sets width and height synchronously on load, without waiting for an animation frame", () => {
    const iframe = createFittingIframe();
    stubContentDocument(iframe, { scrollWidth: 300, scrollHeight: 900 });
    iframe.dispatchEvent(new Event("load"));

    expect(iframe.style.width).toBe("300px");
    expect(iframe.style.height).toBe("900px");
  });

  it("still fits when animation frames never fire (hidden or throttled window)", () => {
    const original = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 0; // the callback is never invoked
    try {
      const calls = [];
      const iframe = createFittingIframe(() => calls.push(iframe.style.height));
      stubContentDocument(iframe, { scrollWidth: 300, scrollHeight: 900 });
      iframe.dispatchEvent(new Event("load"));
      expect(iframe.style.height).toBe("900px");
      expect(calls).toEqual(["900px"]);
    } finally {
      globalThis.requestAnimationFrame = original;
    }
  });

  it("re-fits a frame later when the document grew after load, and reports it", async () => {
    const calls = [];
    const iframe = createFittingIframe(() => calls.push(iframe.style.height));
    const doc = { scrollWidth: 300, scrollHeight: 900 };
    Object.defineProperty(iframe, "contentDocument", { configurable: true, value: { documentElement: doc } });
    iframe.dispatchEvent(new Event("load"));
    doc.scrollHeight = 1200; // e.g. an image or web font arrived
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(iframe.style.height).toBe("1200px");
    expect(calls).toEqual(["900px", "1200px"]);
  });

  it("does not report twice when the later pass measures the same height", async () => {
    const calls = [];
    const iframe = createFittingIframe(() => calls.push(iframe.style.height));
    stubContentDocument(iframe, { scrollWidth: 300, scrollHeight: 900 });
    iframe.dispatchEvent(new Event("load"));
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
