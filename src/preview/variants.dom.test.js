// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createVariantUI } from "./variants.js";

const v = (name, variant_of, variant_kind) => ({ name, tags: [], ...(variant_of ? { variant_of, variant_kind } : {}) });
const screens = [
  v("plain"),
  v("family"),
  v("leave", "family", "overlay"),
  v("confirm", "leave", "step"),
  v("dissolve", "leave", "step"),
  v("confirm-error", "confirm", "state"),
  v("two-parents", "family", "state"),
  v("name-sheet", "family", "overlay"),
];
const flows = [
  { from: "family.open", event: "tap", to: "leave", to_kind: "screen" },
  { from: "feed.btn", event: "tap", to: "confirm", to_kind: "screen" },
  { from: "calendar.card", event: "tap", to: "confirm.title", to_kind: "node" },
  { from: "confirm.ok", event: "tap", to: "plain", to_kind: "screen" },
];

function setup(current, opts = {}) {
  document.body.innerHTML = '<nav id="bar"></nav><aside id="map"></aside><section id="insp"></section>';
  const selected = [];
  const ui = createVariantUI({
    barEl: document.getElementById("bar"),
    mapEl: document.getElementById("map"),
    inspectorEl: document.getElementById("insp"),
    onSelect: (n) => selected.push(n),
  });
  const shown = ui.update(opts.screens ?? screens, opts.flows ?? flows, current);
  return { ui, selected, shown, bar: document.getElementById("bar"), map: document.getElementById("map"), insp: document.getElementById("insp") };
}
const crumbNames = (bar) => [...bar.querySelectorAll(".crumb-group")].map((g) => g.dataset.screen);

describe("variant breadcrumb", () => {
  it("shows root → current with the current crumb marked, chips and back button", () => {
    const { bar, shown } = setup("confirm");
    expect(shown).toBe(true);
    expect(bar.hidden).toBe(false);
    expect(crumbNames(bar)).toEqual(["family", "leave", "confirm"]);
    expect(bar.querySelector(".crumb-group.on").dataset.screen).toBe("confirm");
    expect(bar.querySelector(".crumb-group[data-screen=leave] .kind-icon").dataset.kind).toBe("overlay");
    expect(bar.querySelector(".crumb-group[data-screen=confirm] .kind-icon").dataset.kind).toBe("step");
    expect([...bar.querySelectorAll(".variant-chip")].map((c) => c.textContent)).toEqual(["depth 3", "step"]);
    expect(bar.querySelector(".variant-back").textContent).toContain("Back to family");
  });

  it("clicking a crumb navigates to it", () => {
    const { bar, selected } = setup("confirm");
    bar.querySelector(".crumb-group[data-screen=leave] .crumb").click();
    expect(selected).toEqual(["leave"]);
  });

  it("Back to root navigates to the cluster root", () => {
    const { bar, selected } = setup("confirm-error");
    bar.querySelector(".variant-back").click();
    expect(selected).toEqual(["family"]);
  });

  it("the disclosure opens a popover with children, siblings, current and 'Open itself'", () => {
    const { bar, selected } = setup("confirm");
    bar.querySelector(".crumb-group[data-screen=leave] .crumb-toggle").click();
    const pop = bar.querySelector(".variant-pop");
    const headings = [...pop.querySelectorAll("h4")].map((h) => h.textContent);
    expect(headings).toEqual(["Inside leave · 2", "Siblings in family · 2"]);
    const rows = [...pop.querySelectorAll(".variant-pop-row")].map((r) => r.querySelector(".variant-pop-name")?.textContent ?? r.textContent);
    expect(rows).toEqual(["confirm", "dissolve", "two-parents", "name-sheet", "Open leave itself"]);
    expect(pop.querySelector(".variant-pop-row.current .variant-pop-current").textContent).toBe("current");
    pop.querySelector(".variant-pop-itself").click();
    expect(selected).toEqual(["leave"]);
  });

  it("a popover row navigates and Escape or an outside click closes it", () => {
    const { bar, selected } = setup("confirm");
    const open = () => bar.querySelector(".crumb-group[data-screen=leave] .crumb-toggle").click();
    open();
    bar.querySelectorAll(".variant-pop-row")[1].click();
    expect(selected).toEqual(["dissolve"]);
    open();
    expect(bar.querySelector(".variant-pop")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(bar.querySelector(".variant-pop")).toBeNull();
    open();
    document.body.click();
    expect(bar.querySelector(".variant-pop")).toBeNull();
  });

  it("keyboard focus: opening moves it into the popover, Escape returns it to the toggle and stops there", () => {
    const { bar } = setup("confirm");
    const toggle = () => bar.querySelector(".crumb-group[data-screen=leave] .crumb-toggle");
    toggle().focus();
    toggle().click();
    expect(document.activeElement.classList.contains("variant-pop-row")).toBe(true);
    let laterListenerSaw = false;
    const later = (evt) => {
      if (evt.key === "Escape") laterListenerSaw = true;
    };
    document.addEventListener("keydown", later);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.removeEventListener("keydown", later);
    expect(bar.querySelector(".variant-pop")).toBeNull();
    expect(document.activeElement).toBe(toggle());
    expect(laterListenerSaw).toBe(false);
  });

  it("keyboard focus survives a re-render from outside (e.g. an SSE refresh)", () => {
    const { ui, bar } = setup("confirm");
    bar.querySelector(".crumb-group[data-screen=leave] .crumb").focus();
    ui.update(screens, flows, "confirm");
    expect(document.activeElement).toBe(bar.querySelector(".crumb-group[data-screen=leave] .crumb"));
  });

  it("a cluster root shows itself, its variant count and no back button", () => {
    const { bar } = setup("family");
    expect(crumbNames(bar)).toEqual(["family"]);
    expect(bar.querySelector(".variant-back")).toBeNull();
    expect(bar.querySelector(".variant-chip").textContent).toBe("6 variants");
  });

  it("a plain screen shows no breadcrumb, map or variant section", () => {
    const { bar, map, insp, shown } = setup("plain");
    expect(shown).toBe(false);
    expect(bar.hidden).toBe(true);
    expect(map.hidden).toBe(true);
    expect(insp.hidden).toBe(true);
    expect(bar.children).toHaveLength(0);
  });

  it("re-renders on a new current screen from the stored chain (not the arrival path)", () => {
    const { ui, bar } = setup("family");
    ui.update(screens, flows, "confirm-error");
    expect(crumbNames(bar)).toEqual(["family", "leave", "confirm", "confirm-error"]);
  });
});

describe("variant inspector section", () => {
  it("renders path, kind, depth, siblings and flow counts", () => {
    const { insp } = setup("confirm");
    expect(insp.hidden).toBe(false);
    const kv = Object.fromEntries([...insp.querySelectorAll(".variant-kv")].map((r) => [r.children[0].textContent, r.children[1].textContent]));
    expect(kv).toEqual({ Path: "family › leave", Kind: "step", Depth: "3", Siblings: "1", "Flows in / out": "2 / 1" });
  });

  it("lists 'Also reached from' sources as links that navigate, excluding the parent", () => {
    const { insp, selected } = setup("confirm");
    const card = insp.querySelector(".also-reached");
    expect(card.querySelector("h3").textContent).toBe("Also reached from · 2 flow sources");
    const links = [...card.querySelectorAll(".variant-link")];
    expect(links.map((l) => l.textContent)).toEqual(["feed", "calendar"]);
    links[1].click();
    expect(selected).toEqual(["calendar"]);
  });

  it("omits 'Also reached from' when there is no other source", () => {
    const { insp } = setup("leave");
    expect(insp.querySelector(".also-reached")).toBeNull();
    expect(insp.querySelector(".variant-card")).not.toBeNull();
  });

  it("has no Variant section for a cluster root", () => {
    const { insp } = setup("family");
    expect(insp.hidden).toBe(true);
    expect(insp.children).toHaveLength(0);
  });
});

describe("variant tree map", () => {
  const nodes = (map) => [...map.querySelectorAll(".map-node")].map((n) => n.dataset.screen);

  it("renders the cluster with the current path expanded and the current node highlighted", () => {
    const { map } = setup("confirm");
    expect(map.querySelector("h3").textContent).toBe("Variant tree · family");
    // family's children, leave's children, confirm's children; two-parents and name-sheet are leaves
    expect(nodes(map)).toEqual(["family", "leave", "confirm", "confirm-error", "dissolve", "two-parents", "name-sheet"]);
    expect(map.querySelector(".map-node.on").dataset.screen).toBe("confirm");
    expect(map.querySelector('.map-node[data-screen="dissolve"]').classList.contains("dim")).toBe(true);
    expect(map.querySelector('.map-node[data-screen="leave"]').classList.contains("dim")).toBe(false);
  });

  it("keeps off-path subtrees collapsed with a count", () => {
    const { map } = setup("two-parents");
    expect(nodes(map)).toEqual(["family", "leave", "two-parents", "name-sheet"]);
    expect(map.querySelector('.map-node[data-screen="leave"] .map-node-note').textContent).toBe("▸ 3");
  });

  it("an entry click navigates", () => {
    const { map, selected } = setup("confirm");
    map.querySelector('.map-node[data-screen="dissolve"]').click();
    expect(selected).toEqual(["dissolve"]);
  });

  it("is hidden for plain screens", () => {
    expect(setup("plain").map.hidden).toBe(true);
  });
});

describe("compare mode controls (CHR-738)", () => {
  function setupCompare(current, state) {
    document.body.innerHTML = '<nav id="bar"></nav><aside id="map"></aside><section id="insp"></section>';
    const calls = [];
    const ui = createVariantUI({
      barEl: document.getElementById("bar"),
      mapEl: document.getElementById("map"),
      inspectorEl: document.getElementById("insp"),
      onSelect: () => {},
      compare: {
        state: () => ({ cap: 3, selected: [], on: false, ...state }),
        onMode: (on) => calls.push(["mode", on]),
        onPick: (name) => calls.push(["pick", name]),
      },
    });
    ui.update(screens, flows, current);
    return { ui, calls, bar: document.getElementById("bar") };
  }
  const seg = (bar) => [...bar.querySelectorAll(".compare-seg-button")];

  it("adds a Single | Compare toggle to the bar, Single pressed while compare is off", () => {
    const { bar, calls } = setupCompare("confirm", {});
    expect(seg(bar).map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["Single", "true"],
      ["Compare", "false"],
    ]);
    seg(bar)[1].click();
    seg(bar)[0].click(); // Single while already single: nothing
    expect(calls).toEqual([["mode", true]]);
  });

  it("shows the column count on the pressed Compare button and Single leaves", () => {
    const { bar, calls } = setupCompare("confirm", { on: true, selected: ["confirm", "dissolve"] });
    expect(seg(bar).map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["Single", "false"],
      ["Compare · 3", "true"],
    ]);
    seg(bar)[0].click();
    expect(calls).toEqual([["mode", false]]);
  });

  it("has no toggle without the compare option", () => {
    const { bar } = setup("confirm");
    expect(bar.querySelector(".compare-seg")).toBeNull();
  });

  it("puts a checkbox on every popover row while compare is on, and none while it is off", () => {
    const off = setupCompare("confirm", {});
    off.bar.querySelector(".crumb-group[data-screen=leave] .crumb-toggle").click();
    expect(off.bar.querySelectorAll(".variant-pop-check")).toHaveLength(0);

    const { bar, calls } = setupCompare("confirm", { on: true, selected: ["dissolve"] });
    bar.querySelector(".crumb-group[data-screen=leave] .crumb-toggle").click();
    const boxes = [...bar.querySelectorAll(".variant-pop-check")];
    expect(boxes.map((b) => [b.dataset.screen, b.checked])).toEqual([
      ["confirm", false],
      ["dissolve", true],
      ["two-parents", false],
      ["name-sheet", false],
    ]);
    boxes[0].click();
    expect(calls).toEqual([["pick", "confirm"]]);
    expect(bar.querySelector(".variant-pop")).not.toBeNull(); // ticking does not close the popover
  });

  it("disables unticked boxes once the cap is reached, keeping ticked ones usable", () => {
    const { bar } = setupCompare("confirm", { on: true, selected: ["confirm", "dissolve", "two-parents"] });
    bar.querySelector(".crumb-group[data-screen=leave] .crumb-toggle").click();
    const state = Object.fromEntries([...bar.querySelectorAll(".variant-pop-check")].map((b) => [b.dataset.screen, b.disabled]));
    expect(state).toEqual({ confirm: false, dissolve: false, "two-parents": false, "name-sheet": true });
  });

  it("openPopover opens the popover of a crumb", () => {
    const { ui, bar } = setupCompare("confirm", { on: true });
    ui.openPopover("leave");
    expect(bar.querySelector(".crumb-group[data-screen=leave] .variant-pop")).not.toBeNull();
    ui.openPopover("nope");
    expect(bar.querySelector(".crumb-group[data-screen=leave] .variant-pop")).not.toBeNull();
  });
});
