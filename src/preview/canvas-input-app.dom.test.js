// @vitest-environment jsdom
//
// CHR-1290 / CHR-1291 — the canvases' pan and wheel zoom. The real index.html body and modules, a stubbed daemon (fetch + EventSource).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

const s = (name) => ({ name, tags: [], notes: "" });
let sources;
let screens;
let mockups;

const memoryStorage = new Map();
const storageStub = {
  getItem: (k) => memoryStorage.get(k) ?? null,
  setItem: (k, v) => void memoryStorage.set(k, String(v)),
  removeItem: (k) => void memoryStorage.delete(k),
  get length() { return memoryStorage.size; },
  key: (i) => [...memoryStorage.keys()][i] ?? null,
  clear: () => memoryStorage.clear(),
};

function stubDaemon() {
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  sources = [];
  vi.stubGlobal("EventSource", class { constructor() { sources.push(this); } close() {} });
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (v) => v });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", async (url) => {
    const path = String(url).split("?")[0];
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/projects") return json({ active: "/p", open: [{ root: "/p", name: "p" }], recent: [] });
    if (path === "/api/screens") return json({ screens });
    if (path === "/api/mockups") return json({ mockups });
    if (path === "/api/design-system") {
      return json({ component_definitions: [{ name: "btn", variants: [{ name: "default", rendered_html: "<button></button>" }] }] });
    }
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [] });
    if (path === "/api/tools/get_screen") return json({ nodes: [] });
    if (path.startsWith("/api/render/")) return { ok: true, status: 200, text: async () => `<div id="root">${path}</div>` };
    if (path.startsWith("/api/mockups/")) return json({ name: "m", variants: [] });
    return json({});
  });
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);

const followState = () => (!$("#agent-follow-paused-row").hidden ? "paused" : $("#follow-switch").checked ? "following" : "off");
const pointer = (target, type, x, y, over = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, ...over }));
const wheel = (target, over) => {
  const evt = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 200, clientY: 150, ...over });
  target.dispatchEvent(evt);
  return evt;
};

async function boot() {
  localStorage.setItem("artisign.last-screen:/p", "a");
  localStorage.setItem("artisign.followEnabled", "true");
  await import("./app.js");
  await flush();
}

beforeEach(() => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  screens = [s("a"), s("b")];
  mockups = [];
  stubDaemon();
});
afterEach(() => vi.unstubAllGlobals());

describe("CHR-1290 — pan the Screens canvas by dragging", () => {
  it("scrolls the canvas the other way by the drag, leaves the zoom alone and pauses Follow", async () => {
    await boot();
    expect(followState()).toBe("following");
    const label = $("#zoom-label").textContent;
    const canvas = $("#canvas");
    canvas.scrollLeft = 200;
    canvas.scrollTop = 100;
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointermove", 101, 100);
    expect(canvas.scrollLeft).toBe(200); // below the threshold: nothing moves
    expect(followState()).toBe("following");
    pointer(canvas, "pointermove", 160, 130);
    pointer(canvas, "pointerup", 160, 130);
    expect([canvas.scrollLeft, canvas.scrollTop]).toEqual([140, 70]);
    expect(followState()).toBe("paused");
    expect($("#zoom-label").textContent).toBe(label);
  });

  it("an active tool keeps the left button", async () => {
    await boot();
    $("#inspect-mode-toggle").click();
    await flush();
    $("#follow-resume").click();
    $("#canvas").scrollLeft = 200;
    pointer($("#canvas"), "pointermove", 100, 100, { buttons: 0 });
    pointer($("#canvas"), "pointerdown", 100, 100);
    pointer($("#canvas"), "pointermove", 160, 130);
    expect($("#canvas").scrollLeft).toBe(200);
    expect(followState()).toBe("following");
  });

  it("leaves the tool bar where it is", async () => {
    await boot();
    $("#app").style.setProperty("--toolbar-top", "77px");
    const canvas = $("#canvas");
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointermove", 160, 130);
    pointer(canvas, "pointerup", 160, 130);
    wheel(canvas, { deltaY: -100 });
    expect($("#app").style.getPropertyValue("--toolbar-top")).toBe("77px");
  });
});

describe("CHR-1291 — wheel zoom", () => {
  it("a mouse wheel notch over the canvas zooms, shows it in the pill and pauses Follow", async () => {
    await boot();
    const evt = wheel($("#canvas"), { deltaY: -100 });
    expect(evt.defaultPrevented).toBe(true);
    expect($("#zoom-label").textContent).toBe("120%");
    expect(followState()).toBe("paused");
    wheel($("#canvas"), { deltaY: 100 });
    expect($("#zoom-label").textContent).toBe("100%");
  });

  it("stays within 5 % to 200 %", async () => {
    await boot();
    for (let i = 0; i < 12; i += 1) wheel($("#canvas"), { deltaY: -100 });
    expect($("#zoom-label").textContent).toBe("200%");
    for (let i = 0; i < 40; i += 1) wheel($("#canvas"), { deltaY: 100 });
    expect($("#zoom-label").textContent).toBe("5%");
  });

  it("Ctrl + wheel zooms the canvas, not the page", async () => {
    await boot();
    const evt = wheel($("#canvas"), { ctrlKey: true, deltaY: -10 });
    expect(evt.defaultPrevented).toBe(true);
    expect(Number.parseInt($("#zoom-label").textContent, 10)).toBeGreaterThan(100);
  });

  it("a trackpad two-finger scroll pans and does not zoom", async () => {
    await boot();
    const label = $("#zoom-label").textContent;
    const evt = wheel($("#canvas"), { deltaX: 3, deltaY: 5.5 });
    expect(evt.defaultPrevented).toBe(true);
    expect($("#zoom-label").textContent).toBe(label);
    expect(followState()).toBe("paused");
  });

  it("a wheel over a card never reaches the canvas", async () => {
    await boot();
    const label = $("#zoom-label").textContent;
    wheel($("#sidebar-screens"), { deltaY: -100 });
    expect($("#zoom-label").textContent).toBe(label);
    expect(followState()).toBe("following");
  });

  it("the zoom controls pause Follow too", async () => {
    await boot();
    $("#zoom-in").click();
    expect(followState()).toBe("paused");
  });

  it("Fit takes a hand-moved canvas back", async () => {
    await boot();
    $("#canvas").scrollLeft = 300;
    wheel($("#canvas"), { deltaX: 40, deltaY: 6.5 });
    expect($("#canvas").scrollLeft).toBe(340);
    $("#zoom-fit").click();
    expect([$("#canvas").scrollLeft, $("#canvas").scrollTop]).toEqual([0, 0]);
  });
});

describe("a frame that fits the pane (CHR-1290 / CHR-1291)", () => {
  const holder = () => $("#screen-holder");
  const edge = () => [parseFloat(holder().style.left), parseFloat(holder().style.top)];
  const scaleOf = () => parseFloat(holder().style.getPropertyValue("--zoom"));
  async function fitting() {
    await boot();
    Object.defineProperty($("#canvas"), "clientWidth", { configurable: true, value: 1400 });
    Object.defineProperty($("#canvas"), "clientHeight", { configurable: true, value: 900 });
    $('.zoom-preset[data-zoom="0.5"]').click(); // 195 x 422: fits both axes
  }

  it("a drag moves the frame with the pointer on both axes, Fit centres it again", async () => {
    await fitting();
    const [x0, y0] = edge();
    const canvas = $("#canvas");
    pointer(canvas, "pointerdown", 600, 500);
    pointer(canvas, "pointermove", 660, 530);
    pointer(canvas, "pointerup", 660, 530);
    expect(edge()).toEqual([x0 + 60, y0 + 30]);
    expect(followState()).toBe("paused");
    $("#zoom-fit").click();
    $('.zoom-preset[data-zoom="0.5"]').click();
    expect(edge()).toEqual([x0, y0]);
  });

  it("a trackpad scroll moves it too, and it stays inside the pane", async () => {
    await fitting();
    const [x0] = edge();
    wheel($("#canvas"), { deltaX: -30, deltaY: 5.5 });
    expect(edge()[0]).toBe(x0 + 30);
    for (let i = 0; i < 80; i += 1) wheel($("#canvas"), { deltaX: -40, deltaY: 0.5 });
    expect(edge()[0]).toBeLessThanOrEqual(1400 - 195 + 0.01);
  });

  it("a wheel zoom out and in keeps the point under the pointer", async () => {
    await fitting();
    const canvas = $("#canvas");
    pointer(canvas, "pointerdown", 600, 500);
    pointer(canvas, "pointermove", 680, 540);
    pointer(canvas, "pointerup", 680, 540);
    const [px, py] = [700, 480];
    const under = () => [(px - edge()[0]) / scaleOf(), (py - edge()[1]) / scaleOf()]; // frame point under the pointer
    const [ux, uy] = under();
    wheel(canvas, { clientX: px, clientY: py, deltaY: 100 });
    wheel(canvas, { clientX: px, clientY: py, deltaY: 100 });
    expect(scaleOf()).toBeLessThan(0.5);
    expect(under()[0]).toBeCloseTo(ux, 3);
    expect(under()[1]).toBeCloseTo(uy, 3);
    wheel(canvas, { clientX: px, clientY: py, deltaY: -100 });
    expect(under()[0]).toBeCloseTo(ux, 3);
    expect(under()[1]).toBeCloseTo(uy, 3);
  });

  it("zoomed in past the pane the same drag scrolls instead", async () => {
    await fitting();
    $('.zoom-preset[data-zoom="2"]').click(); // 780 x 1688 against 900 high
    const [, y0] = edge();
    const canvas = $("#canvas");
    canvas.scrollTop = 100;
    pointer(canvas, "pointerdown", 600, 500);
    pointer(canvas, "pointermove", 600, 540);
    pointer(canvas, "pointerup", 600, 540);
    expect(canvas.scrollTop).toBe(60);
    expect(edge()[1]).toBe(y0); // the offset is not used on an overflowing axis
  });
});

describe("the empty guide", () => {
  it("is left to the browser's wheel", async () => {
    screens = [];
    await boot();
    expect($("#screen-holder").hidden).toBe(true);
    expect(wheel($("#canvas"), { deltaY: -100 }).defaultPrevented).toBe(false);
    expect(wheel($("#canvas"), { deltaX: 3, deltaY: 5.5 }).defaultPrevented).toBe(false);
  });
});

describe("the Board", () => {
  // The Board defers a coalesced relayout while a zoom gesture is fresh (150 ms quiet time + 50 ms coalescing). Let that timer fire while the stubbed CSS still exists, or it runs after the teardown and throws.
  afterEach(() => new Promise((r) => setTimeout(r, 250)));

  async function onBoard() {
    await boot();
    $('.view-tab[data-view="board"]').click();
    await flush();
    $("#follow-resume").click();
  }

  it("a mouse wheel notch zooms around the pointer and pauses Follow", async () => {
    await onBoard();
    const before = $("#zoom-label").textContent;
    const evt = wheel($("#board-surface"), { deltaY: -100 });
    expect(evt.defaultPrevented).toBe(true);
    expect($("#zoom-label").textContent).not.toBe(before);
    expect(followState()).toBe("paused");
  });

  it("a drag scrolls the surface the other way and pauses Follow", async () => {
    await onBoard();
    const surface = $("#board-surface");
    surface.scrollLeft = 200;
    surface.scrollTop = 100;
    pointer(surface, "pointerdown", 100, 100);
    pointer(surface, "pointermove", 130, 90);
    pointer(surface, "pointerup", 130, 90);
    expect([surface.scrollLeft, surface.scrollTop]).toEqual([170, 110]);
    expect(followState()).toBe("paused");
  });

  it("a trackpad scroll is left to the surface's native scroll but pauses Follow", async () => {
    await onBoard();
    const evt = wheel($("#board-surface"), { deltaX: 4, deltaY: 7.5 });
    expect(evt.defaultPrevented).toBe(false);
    expect(followState()).toBe("paused");
  });
});
