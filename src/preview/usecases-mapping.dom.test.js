// @vitest-environment jsdom
//
// The mapping view: the flow next to the mapped screens in flow order, real renders in sandboxed iframes, an outline plus
// numbered pin for an element mapping (positioned by the inspector's own overlay routine), a whole-frame outline for a
// screen mapping, stale and unstable mappings marked, step click focuses a frame.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMappingView, framesOf, dataChangeLine, revealInScrollParents } from "./usecases-mapping.js";
import { makePool, baseBundle, variantBundle } from "./usecases.test-helper.js";
import { indexById } from "./usecases-data.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("framesOf", () => {
  it("lists each screen once in order of first use, with every step that maps to it", () => {
    const steps = [
      { id: "a", actor: "dana", action: "x", target: { screen: "editor", node: "d" } },
      { id: "b", actor: "dana", action: "y", target: { screen: "picker" } },
      { id: "c", actor: "dana", action: "z", target: { screen: "editor", node: "e" } },
      { id: "d", actor: "system", action: "no target" },
    ];
    const bundle = { screens: [{ screen: "editor", exists: true, mappings: [{ step: "a", scope: "element" }, { step: "c", scope: "element", unstable: true }] }, { screen: "picker", exists: false, mappings: [{ step: "b", scope: "screen", stale: true }] }] };
    const frames = framesOf(steps, bundle);
    expect(frames.map((f) => f.screen)).toEqual(["editor", "picker"]);
    expect(frames[0].steps.map((s) => [s.number, s.scope])).toEqual([[1, "element"], [3, "element"]]);
    expect(frames[0].steps[1].mapping.unstable).toBe(true);
    expect(frames[1]).toMatchObject({ exists: false });
    expect(frames[1].steps[0].scope).toBe("stale");
  });
});

describe("dataChangeLine", () => {
  it("summarises only the changed fields: 'Object: field before → after'", () => {
    const objects = indexById([{ id: "mapping", name: "Mapping" }]);
    const step = { data: [{ object: "mapping", before: { status: "draft" }, after: { status: "ready", owner: "Pablo" } }] };
    expect(dataChangeLine(step, objects)).toBe("Mapping: status draft → ready, owner → Pablo");
    expect(dataChangeLine({}, objects)).toBe("");
    expect(dataChangeLine({ data: [{ object: "mapping", before: { a: 1 }, after: { a: 1 } }] }, objects)).toBe("");
  });
});

describe("revealInScrollParents", () => {
  it("scrolls an overflow container (also overflow:hidden) so the element is in view, and nothing else", () => {
    document.body.innerHTML = `<div id="box" style="overflow:hidden"><div id="el"></div></div>`;
    const box = document.getElementById("box");
    const el = document.getElementById("el");
    Object.defineProperty(box, "scrollHeight", { value: 800, configurable: true });
    Object.defineProperty(box, "clientHeight", { value: 200, configurable: true });
    box.getBoundingClientRect = () => ({ top: 0, bottom: 200 });
    el.getBoundingClientRect = () => ({ top: 500, bottom: 560 });
    revealInScrollParents(el);
    expect(box.scrollTop).toBe(372);
  });
});

describe("mapping view", () => {
  let root;
  let handlers;
  let fetchRender;
  let view;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.append(root);
    handlers = { onBack: vi.fn(), onVariantMenu: vi.fn(), onOpenScreen: vi.fn(), onPickTarget: vi.fn(), onUnmap: vi.fn(), onStep: vi.fn() };
    fetchRender = vi.fn(async (screen) => ({ ok: true, html: `<main id="${screen}"><div id="btn-map">14</div><div id="row-agent">h</div></main>` }));
    view = createMappingView({ root, fetchRender, handlers });
  });

  const show = (over = {}) => view.show({ project: "/p", bundle: baseBundle, variantId: null, variants: baseBundle.variants, pool: makePool(), stepId: null, ...over });

  it("renders the flow list and one frame per screen in flow order, sandboxed, with an arrow between frames", async () => {
    show();
    await flush();
    expect($$(".uc-map-step").map((s) => s.dataset.scope)).toEqual(["element", "screen", "stale"]);
    expect($$(".uc-frame").map((f) => f.querySelector(".uc-frame-name").textContent)).toEqual(["editor", "picker", "gone-screen"]);
    expect($$(".uc-map-arrow")).toHaveLength(2);
    expect(fetchRender).toHaveBeenCalledTimes(2); // the missing screen is never fetched
    for (const iframe of $$(".uc-frame iframe")) {
      expect(iframe.getAttribute("sandbox")).toBe("allow-same-origin"); // never allow-scripts
      expect(iframe.srcdoc).toContain("<main");
    }
  });

  it("every frame label says Element / Screen / Stale in words, a screen mapping carries a 'Whole screen' chip", async () => {
    show();
    await flush();
    expect($$(".uc-frame").map((f) => $$(".uc-scope-chip", f).map((c) => c.textContent))).toEqual([["Element"], ["Screen"], ["Stale"]]);
    expect($(".uc-screen-outline .uc-screen-chip").textContent).toBe("Whole screen");
  });

  it("an element mapping gets a numbered pin, a screen mapping an outline around the whole frame", async () => {
    show();
    await flush();
    expect($(".uc-pin[data-step=tap] .uc-pin-no").textContent).toBe("1");
    expect($(".uc-screen-outline[data-step=pick] .uc-pin-no").textContent).toBe("2");
    // jsdom does not load srcdoc: put the render's elements into the frame's document, then fire its load.
    const iframe = $(".uc-frame iframe");
    iframe.contentDocument.body.innerHTML = `<div id="btn-map">14</div>`;
    Object.defineProperty(iframe.contentDocument.documentElement, "scrollHeight", { value: 844, configurable: true }); // a real render has a height: the fitting iframe reports it
    iframe.dispatchEvent(new Event("load"));
    expect($(".uc-pin[data-step=tap]").dataset.stale).toBe("false");
    expect($(".uc-pin[data-step=tap]").hidden).toBe(false);
    expect($(".uc-pin[data-step=tap]").dataset.missing).toBeUndefined();
  });

  it("an element that is not in the render is marked missing (warning pin), never outlined at a guess", async () => {
    show({ bundle: { ...baseBundle, screens: [{ screen: "editor", exists: true, mappings: [{ step: "tap", scope: "element", stale: true }] }, ...baseBundle.screens.slice(1)] } });
    await flush();
    const iframe = $(".uc-frame iframe");
    Object.defineProperty(iframe.contentDocument.documentElement, "scrollHeight", { value: 844, configurable: true });
    iframe.dispatchEvent(new Event("load"));
    const pin = $(".uc-pin[data-step=tap]");
    expect(pin.dataset.missing).toBe("true");
    expect(pin.dataset.stale).toBe("true");
  });

  it("a screen that no longer exists is a dashed 'Screen not found' frame and its step offers new target / leave unmapped", async () => {
    show();
    await flush();
    const missing = $$(".uc-frame").find((f) => f.textContent.includes("gone-screen"));
    expect(missing.querySelector(".uc-frame-box").dataset.exists).toBe("false");
    expect(missing.textContent).toContain("Screen not found");
    expect(missing.querySelector("iframe")).toBeNull();
    const stale = $(".uc-map-step[data-scope=stale]");
    expect(stale.querySelector(".uc-map-stale").textContent).toContain("never rewrites mappings");
    const [pick, leave] = $$(".uc-map-stale-actions button", stale);
    pick.click();
    expect(handlers.onPickTarget).toHaveBeenCalledWith("notify");
    leave.click();
    expect(handlers.onUnmap).toHaveBeenCalledWith("notify");
  });

  it("clicking a step focuses its frame; clicking a frame opens that screen (with the node of the selected step)", async () => {
    show();
    await flush();
    const scroll = vi.fn();
    $$(".uc-frame").forEach((f) => (f.scrollIntoView = scroll));
    $(".uc-map-step[data-step=tap] .uc-map-step-btn").click();
    expect(handlers.onStep).toHaveBeenCalledWith("tap");
    expect($(".uc-map-step[data-step=tap]").classList.contains("is-selected")).toBe(true);
    expect($$(".uc-frame-label").map((l) => l.classList.contains("is-selected"))).toEqual([true, false, false]); // the label bar, never a frame outline
    expect($$(".uc-frame-box.is-selected")).toHaveLength(0);
    expect(scroll).toHaveBeenCalledTimes(1);
    $$(".uc-frame")[0].click();
    expect(handlers.onOpenScreen).toHaveBeenCalledWith("editor", "btn-map");
    $$(".uc-frame")[1].click();
    expect(handlers.onOpenScreen).toHaveBeenLastCalledWith("picker", null);
  });

  it("one screen used by several steps is rendered once with several pins", async () => {
    show({ bundle: variantBundle, variantId: "agent", variants: baseBundle.variants });
    await flush();
    expect($$(".uc-frame").map((f) => f.querySelector(".uc-frame-name").textContent)).toEqual(["editor", "picker"]);
    expect(fetchRender).toHaveBeenCalledTimes(2);
    const sheet = $$(".uc-frame")[1];
    expect($$(".uc-frame-no", sheet).map((n) => n.textContent)).toEqual(["2", "3"]);
    expect($(".uc-pin[data-step=pick]", sheet)).not.toBeNull();
    expect($(".uc-screen-outline[data-step=time]", sheet)).not.toBeNull();
  });

  it("shows the selected variant in the bar and passes the menu anchor out; back leaves the view", async () => {
    show({ variantId: "agent", bundle: variantBundle });
    await flush();
    const chip = $(".uc-map-bar .uc-filter-chip-main");
    expect(chip.textContent).toContain("No human");
    chip.click();
    expect(handlers.onVariantMenu).toHaveBeenCalledWith(chip);
    $(".uc-map-bar .chrome-icon-btn").click();
    expect(handlers.onBack).toHaveBeenCalled();
  });

  it("explains an empty mapping instead of drawing nothing", async () => {
    show({ bundle: { ...baseBundle, use_case: { ...baseBundle.use_case, steps: [{ id: "a", actor: "dana", action: "x" }] }, screens: [] } });
    await flush();
    expect($(".uc-map-none").textContent).toContain("No step of this use case is mapped");
  });

  it("a render that finishes after the view moved on is dropped", async () => {
    let resolve;
    fetchRender.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    show();
    const first = $(".uc-frame iframe");
    show(); // a second show() replaces everything
    resolve({ ok: true, html: "<main>late</main>" });
    await flush();
    expect(first.srcdoc).toBe("");
  });
});
