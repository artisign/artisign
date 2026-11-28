// @vitest-environment jsdom
//
// CHR-1290 / CHR-1291 — the canvas input controller: drag threshold, click kept, tools, Space and middle button, wheel, forwarded iframe documents.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCanvasInput, PAN_THRESHOLD } from "./canvas-input.js";

let surface;
let inner;
let calls;
let toolActive;
let unmount;
let input;

function pointer(target, type, x, y, over = {}) {
  const evt = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, ...over });
  target.dispatchEvent(evt);
  return evt;
}

function wheelOn(target, over = {}) {
  const evt = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 50, clientY: 60, deltaY: 100, ...over });
  target.dispatchEvent(evt);
  return evt;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="surface"><div id="inner"><button id="btn">b</button></div><div id="layer"><p id="pop">pop</p></div></div>';
  surface = document.getElementById("surface");
  inner = document.getElementById("inner");
  calls = { pan: [], zoom: [], manual: 0, wheelPan: [] };
  toolActive = false;
  input = createCanvasInput({
    surfaceEl: surface,
    isToolActive: () => toolActive,
    ignoreSelector: "#layer *",
    onPan: (dx, dy) => calls.pan.push([dx, dy]),
    onWheelPan: (dx, dy) => calls.wheelPan.push([dx, dy]),
    onZoom: (factor, x, y) => calls.zoom.push([factor, x, y]),
    onManual: () => (calls.manual += 1),
  });
  unmount = input.mount();
});

afterEach(() => {
  unmount();
  vi.useRealTimers();
});

describe("left-drag pan", () => {
  it("pans by the pointer delta once the threshold is passed, and pauses Follow once", () => {
    pointer(inner, "pointerdown", 10, 10);
    pointer(inner, "pointermove", 10 + PAN_THRESHOLD - 1, 10);
    expect(calls.pan).toEqual([]);
    pointer(inner, "pointermove", 30, 18);
    pointer(inner, "pointermove", 35, 20);
    expect(calls.pan).toEqual([[20, 8], [5, 2]]);
    expect(calls.manual).toBe(1);
    expect(surface.dataset.pan).toBe("grabbing");
    pointer(inner, "pointerup", 35, 20);
    expect(surface.dataset.pan).toBe("grab");
  });

  it("keeps a click without movement a click", () => {
    const click = vi.fn();
    inner.addEventListener("click", click);
    pointer(inner, "pointerdown", 10, 10);
    pointer(inner, "pointermove", 12, 11);
    pointer(inner, "pointerup", 12, 11);
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(calls.pan).toEqual([]);
    expect(calls.manual).toBe(0);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("swallows the click that ends a drag", () => {
    const click = vi.fn();
    inner.addEventListener("click", click);
    pointer(inner, "pointerdown", 10, 10);
    pointer(inner, "pointermove", 40, 10);
    pointer(inner, "pointerup", 40, 10);
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(click).not.toHaveBeenCalled();
    const later = vi.fn(); // a capture handler registered after the controller's: the tools and flows of a screen
    surface.addEventListener("click", later, true);
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(later).not.toHaveBeenCalled();
    surface.removeEventListener("click", later, true);
    vi.runAllTimers();
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(click).toHaveBeenCalledTimes(1); // the next, unrelated click works again
  });

  it("leaves the left button to an active canvas tool", () => {
    toolActive = true;
    pointer(inner, "pointermove", 5, 5, { buttons: 0 }); // a hover picks the tool up: no grab cursor
    expect(surface.dataset.pan).toBeUndefined();
    pointer(inner, "pointerdown", 10, 10);
    pointer(inner, "pointermove", 60, 10);
    expect(calls.pan).toEqual([]);
  });

  it("never starts on a shell control or an overlay inside the surface", () => {
    pointer(document.getElementById("btn"), "pointerdown", 10, 10);
    pointer(document.getElementById("btn"), "pointermove", 60, 10);
    pointer(document.getElementById("pop"), "pointerdown", 10, 10);
    pointer(document.getElementById("pop"), "pointermove", 60, 10);
    expect(calls.pan).toEqual([]);
  });

  it("pans on the middle button in every tool state", () => {
    toolActive = true;
    pointer(inner, "pointerdown", 10, 10, { button: 1 });
    pointer(inner, "pointermove", 40, 10);
    pointer(inner, "pointerup", 40, 10, { button: 1 });
    expect(calls.pan).toEqual([[30, 0]]);
  });

  it("pans with Space held in every tool state, and hands the button back on release", () => {
    toolActive = true;
    surface.dispatchEvent(new Event("pointerenter"));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }));
    expect(surface.dataset.pan).toBe("grab");
    pointer(inner, "pointerdown", 10, 10);
    pointer(inner, "pointermove", 25, 10);
    pointer(inner, "pointerup", 25, 10);
    expect(calls.pan).toEqual([[15, 0]]);
    document.body.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " ", bubbles: true }));
    expect(surface.dataset.pan).toBeUndefined();
  });

  it("ignores Space while a text field has the key", () => {
    document.body.insertAdjacentHTML("beforeend", '<input id="field" />');
    surface.dispatchEvent(new Event("pointerenter"));
    document.getElementById("field").dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }));
    toolActive = true;
    pointer(inner, "pointerdown", 10, 10);
    pointer(inner, "pointermove", 25, 10);
    expect(calls.pan).toEqual([]);
  });

  it("ends a drag whose button was released outside the window", () => {
    pointer(inner, "pointerdown", 10, 10);
    pointer(inner, "pointermove", 30, 10);
    pointer(document.body, "pointermove", 50, 10, { buttons: 0 });
    pointer(document.body, "pointermove", 90, 10);
    expect(calls.pan).toEqual([[20, 0]]);
  });
});

describe("wheel", () => {
  it("zooms at the pointer for a mouse wheel notch and stops the page", () => {
    const evt = wheelOn(inner, { deltaY: -100 });
    expect(evt.defaultPrevented).toBe(true);
    expect(calls.zoom).toHaveLength(1);
    expect(calls.zoom[0][0]).toBeCloseTo(1.2, 5); // one notch up: x1.2
    expect(calls.zoom[0].slice(1)).toEqual([50, 60]);
    expect(calls.manual).toBe(1);
  });

  it("zooms for Ctrl/Cmd + wheel and pinch, never the page", () => {
    const evt = wheelOn(inner, { ctrlKey: true, deltaY: 3 });
    expect(evt.defaultPrevented).toBe(true);
    expect(calls.zoom).toHaveLength(1);
    expect(calls.zoom[0][0]).toBeLessThan(1);
  });

  it("pans on a trackpad two-finger scroll", () => {
    const evt = wheelOn(inner, { deltaX: 7, deltaY: 11.5 });
    expect(evt.defaultPrevented).toBe(true);
    expect(calls.wheelPan).toEqual([[-7, -11.5]]);
    expect(calls.zoom).toEqual([]);
  });

  it("leaves a panel inside the surface to scroll itself", () => {
    const evt = wheelOn(document.getElementById("pop"));
    expect(evt.defaultPrevented).toBe(false);
    expect(calls.zoom).toEqual([]);
  });

  it("leaves a trackpad scroll to the browser where the view has no wheel pan", () => {
    unmount();
    input = createCanvasInput({ surfaceEl: surface, isToolActive: () => false, onPan: () => {}, onZoom: (...args) => calls.zoom.push(args) });
    unmount = input.mount();
    const evt = wheelOn(inner, { deltaY: 6 });
    expect(evt.defaultPrevented).toBe(false);
    expect(calls.zoom).toEqual([]);
  });
});

describe("a screen's own document", () => {
  function mountFrame() {
    const frame = document.createElement("iframe");
    surface.appendChild(frame);
    const doc = frame.contentDocument;
    doc.body.innerHTML = '<a id="link" href="#x">x</a>';
    // the frame is drawn at 2x and sits at (100, 40) in the shell
    frame.getBoundingClientRect = () => ({ left: 100, top: 40, width: 400, height: 800 });
    Object.defineProperty(frame, "offsetWidth", { value: 200 });
    return { frame, doc, detach: input.attachDoc(doc, frame) };
  }

  it("maps a drag that starts inside it into the shell's coordinates", () => {
    const { doc } = mountFrame();
    pointer(doc.getElementById("link"), "pointerdown", 10, 10);
    pointer(doc.getElementById("link"), "pointermove", 20, 15);
    expect(calls.pan).toEqual([[20, 10]]);
    expect(doc.documentElement.style.cursor).toBe("grabbing");
    pointer(doc.getElementById("link"), "pointerup", 20, 15);
    expect(doc.documentElement.style.cursor).toBe("grab");
  });

  it("zooms at the mapped pointer on a wheel inside it", () => {
    const { doc } = mountFrame();
    wheelOn(doc.getElementById("link"), { clientX: 10, clientY: 10, deltaY: 100 });
    expect(calls.zoom[0].slice(1)).toEqual([120, 60]);
  });

  it("hands the left button to an active tool, and takes its cursor off again", () => {
    const { doc } = mountFrame();
    toolActive = true;
    pointer(surface, "pointerenter", 0, 0);
    pointer(doc.getElementById("link"), "pointerdown", 10, 10);
    pointer(doc.getElementById("link"), "pointermove", 60, 15);
    expect(calls.pan).toEqual([]);
  });

  it("stops listening after detach", () => {
    const { doc, detach } = mountFrame();
    detach();
    pointer(doc.getElementById("link"), "pointerdown", 10, 10);
    pointer(doc.getElementById("link"), "pointermove", 60, 15);
    expect(calls.pan).toEqual([]);
  });
});

describe("focus", () => {
  it("keeps a drag going when a press moves the focus into a screen's document", () => {
    const frame = document.createElement("iframe");
    surface.appendChild(frame);
    frame.contentDocument.body.innerHTML = "<p id='p'>x</p>";
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
    input.attachDoc(frame.contentDocument, frame);
    const p = frame.contentDocument.getElementById("p");
    pointer(p, "pointerdown", 10, 10);
    frame.focus();
    window.dispatchEvent(new Event("blur"));
    pointer(p, "pointermove", 40, 10);
    expect(calls.pan).toEqual([[30, 0]]);
  });
});
