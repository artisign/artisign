// @vitest-environment jsdom
//
// CHR-1290 — the Board's tile documents: a Space-held drag in flow mode is a pan, never a click-through.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./api.js", () => ({ fetchRender: vi.fn(async () => ({ ok: true, html: '<div id="go" data-flow-target="dash">go</div>' })) }));

import { createBoardView } from "./board-view.js";

const flows = [{ from: "plain.go", event: "tap", to: "dash", to_kind: "screen" }];
const screens = [{ name: "dash", tags: [] }, { name: "plain", tags: [] }];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = (target, type, x, y, over = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, ...over }));

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.CSS ??= { escape: (s) => s };
});

describe("Board tile documents, flow mode", () => {
  it("a Space + drag over a flow source pans and neither centres the target nor clicks through; a plain click does", async () => {
    document.body.innerHTML = '<div id="surface"><div id="canvas"><div id="inner"><div id="tiles"></div><svg id="edges"></svg></div></div></div>';
    const surface = document.getElementById("surface");
    surface.scrollTo = vi.fn();
    const manual = vi.fn();
    const board = createBoardView({
      surfaceEl: surface,
      canvasEl: document.getElementById("canvas"),
      canvasInnerEl: document.getElementById("inner"),
      tilesEl: document.getElementById("tiles"),
      edgesEl: document.getElementById("edges"),
      onManualNavigate: manual,
    });
    board.mount();
    await board.setScreens(["dash", "plain"], flows, "p", { screens, expanded: [], clusters: false });
    await wait(150);
    board.setFlowMode(true);
    const iframe = document.querySelector('.board-tile[data-screen="plain"] iframe');
    const doc = iframe.contentDocument;
    doc.body.innerHTML = '<div id="go" data-flow-target="dash">go</div>'; // jsdom does not load srcdoc: put the screen in and fire the load the board waits for
    iframe.dispatchEvent(new Event("load"));
    const go = doc.getElementById("go");
    iframe.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 844 });
    Object.defineProperty(iframe, "offsetWidth", { value: 390 });

    // control: a plain click in flow mode follows the flow
    go.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(surface.scrollTo).toHaveBeenCalledTimes(1);
    surface.scrollTo.mockClear();

    surface.dispatchEvent(new Event("pointerenter"));
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }));
    mouse(go, "pointerdown", 10, 10);
    mouse(go, "pointermove", 10, 10);
    mouse(go, "pointermove", 40, 10);
    mouse(go, "pointerup", 40, 10);
    go.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(manual).toHaveBeenCalledTimes(1);
    expect(surface.scrollTo).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " ", bubbles: true }));
  });
});
