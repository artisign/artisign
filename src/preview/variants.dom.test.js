// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createVariantUI } from "./variants.js";

const v = (name, variant_of, variant_kind) => ({ name, tags: [], ...(variant_of ? { variant_of, variant_kind } : {}) });
const screens = [
  v("plain"),
  v("cart"),
  v("clear", "cart", "overlay"),
  v("confirm", "clear", "step"),
  v("all", "clear", "step"),
  v("confirm-error", "confirm", "state"),
  v("two-items", "cart", "state"),
  v("name-sheet", "cart", "overlay"),
];
const flows = [
  { from: "cart.open", event: "tap", to: "clear", to_kind: "screen" },
  { from: "feed.btn", event: "tap", to: "confirm", to_kind: "screen" },
  { from: "menu-today.card", event: "tap", to: "confirm.title", to_kind: "node" },
  { from: "confirm.ok", event: "tap", to: "plain", to_kind: "screen" },
];

function setup(current, opts = {}) {
  document.body.innerHTML = '<nav id="bar"></nav>';
  const selected = [];
  const ui = createVariantUI({
    barEl: document.getElementById("bar"),
    onSelect: (n) => selected.push(n),
  });
  const shown = ui.update(opts.screens ?? screens, opts.flows ?? flows, current);
  return { ui, selected, shown, bar: document.getElementById("bar") };
}
const crumbNames = (bar) => [...bar.querySelectorAll(".crumb-group")].map((g) => g.dataset.screen);

describe("variant breadcrumb", () => {
  it("shows root → current with the current crumb marked, chips and back button", () => {
    const { bar, shown } = setup("confirm");
    expect(shown).toBe(true);
    expect(bar.hidden).toBe(false);
    expect(crumbNames(bar)).toEqual(["cart", "clear", "confirm"]);
    expect(bar.querySelector(".crumb-group.on").dataset.screen).toBe("confirm");
    expect(bar.querySelector(".crumb-group[data-screen=clear] .kind-icon").dataset.kind).toBe("overlay");
    expect(bar.querySelector(".crumb-group[data-screen=confirm] .kind-icon").dataset.kind).toBe("step");
    expect([...bar.querySelectorAll(".variant-chip")].map((c) => c.textContent)).toEqual(["depth 3", "step"]);
    expect(bar.querySelector(".variant-back").textContent).toContain("Back to cart");
  });

  it("clicking a crumb navigates to it", () => {
    const { bar, selected } = setup("confirm");
    bar.querySelector(".crumb-group[data-screen=clear] .crumb").click();
    expect(selected).toEqual(["clear"]);
  });

  it("Back to root navigates to the cluster root", () => {
    const { bar, selected } = setup("confirm-error");
    bar.querySelector(".variant-back").click();
    expect(selected).toEqual(["cart"]);
  });

  it("the disclosure opens a popover with children, siblings, current and 'Open itself'", () => {
    const { bar, selected } = setup("confirm");
    bar.querySelector(".crumb-group[data-screen=clear] .crumb-toggle").click();
    const pop = bar.querySelector(".variant-pop");
    const headings = [...pop.querySelectorAll("h4")].map((h) => h.textContent);
    expect(headings).toEqual(["Inside clear · 2", "Siblings in cart · 2"]);
    const rows = [...pop.querySelectorAll(".variant-pop-row")].map((r) => r.querySelector(".variant-pop-name")?.textContent ?? r.textContent);
    expect(rows).toEqual(["confirm", "all", "two-items", "name-sheet", "Open clear itself"]);
    expect(pop.querySelector(".variant-pop-row.current .variant-pop-current").textContent).toBe("current");
    pop.querySelector(".variant-pop-itself").click();
    expect(selected).toEqual(["clear"]);
  });

  it("a popover row navigates and Escape or an outside click closes it", () => {
    const { bar, selected } = setup("confirm");
    const open = () => bar.querySelector(".crumb-group[data-screen=clear] .crumb-toggle").click();
    open();
    bar.querySelectorAll(".variant-pop-row")[1].click();
    expect(selected).toEqual(["all"]);
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
    const toggle = () => bar.querySelector(".crumb-group[data-screen=clear] .crumb-toggle");
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

  it("the popover is an ARIA menu: ↑/↓/Home/End move between the rows, one roving tab stop, Enter-style activation selects", () => {
    const { bar, selected } = setup("confirm");
    const toggle = bar.querySelector(".crumb-group[data-screen=clear] .crumb-toggle");
    toggle.focus();
    toggle.click();
    const pop = bar.querySelector(".variant-pop");
    expect(pop.getAttribute("role")).toBe("menu");
    const rows = () => [...pop.querySelectorAll(".variant-pop-row")];
    expect(rows().every((r) => r.getAttribute("role") === "menuitem")).toBe(true);
    expect(rows().map((r) => r.tabIndex)).toEqual([0, ...rows().slice(1).map(() => -1)]);
    const press = (key) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(rows()[0]);
    press("ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows().map((r) => r.tabIndex).filter((t) => t === 0)).toHaveLength(1);
    expect(rows()[1].tabIndex).toBe(0);
    press("End");
    expect(document.activeElement).toBe(rows().at(-1));
    press("ArrowDown"); // menus wrap
    expect(document.activeElement).toBe(rows()[0]);
    press("ArrowUp");
    expect(document.activeElement).toBe(rows().at(-1));
    press("Home");
    rows()[0].click();
    expect(selected).toEqual([rows()[0].dataset.screen]);
  });

  it("keyboard focus survives a re-render from outside (e.g. an SSE refresh)", () => {
    const { ui, bar } = setup("confirm");
    bar.querySelector(".crumb-group[data-screen=clear] .crumb").focus();
    ui.update(screens, flows, "confirm");
    expect(document.activeElement).toBe(bar.querySelector(".crumb-group[data-screen=clear] .crumb"));
  });

  it("a cluster root shows itself, its variant count and no back button", () => {
    const { bar } = setup("cart");
    expect(crumbNames(bar)).toEqual(["cart"]);
    expect(bar.querySelector(".variant-back")).toBeNull();
    expect(bar.querySelector(".variant-chip").textContent).toBe("6 variants");
  });

  it("a plain screen shows no breadcrumb", () => {
    const { bar, shown } = setup("plain");
    expect(shown).toBe(false);
    expect(bar.hidden).toBe(true);
    expect(bar.children).toHaveLength(0);
  });

  it("has no variant map or its toggle any more (CHR-1267): the nav tree carries the variants", () => {
    const { bar } = setup("confirm");
    expect(bar.querySelector(".variant-map-toggle")).toBeNull();
    expect(document.querySelector(".map-node")).toBeNull();
  });

  it("re-renders on a new current screen from the stored chain (not the arrival path)", () => {
    const { ui, bar } = setup("cart");
    ui.update(screens, flows, "confirm-error");
    expect(crumbNames(bar)).toEqual(["cart", "clear", "confirm", "confirm-error"]);
  });
});

describe("compare mode controls (CHR-738)", () => {
  function setupCompare(current, state) {
    document.body.innerHTML = '<nav id="bar"></nav>';
    const calls = [];
    const ui = createVariantUI({
      barEl: document.getElementById("bar"),
      onSelect: (name) => calls.push(["select", name]),
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
    const { bar, calls } = setupCompare("confirm", { on: true, selected: ["confirm", "all"] });
    expect(seg(bar).map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["Single", "false"],
      ["Compare · 3", "true"],
    ]);
    seg(bar)[0].click();
    expect(calls).toEqual([["mode", false]]);
  });

  it("the compare checkboxes are part of the arrow order: each one, then its row, in DOM order", () => {
    const { bar } = setupCompare("confirm", { on: true, selected: ["all"] });
    bar.querySelector(".crumb-group[data-screen=clear] .crumb-toggle").click();
    const pop = bar.querySelector(".variant-pop");
    const entries = [...pop.querySelectorAll(".variant-pop-entry")];
    const [box0, row0] = [entries[0].querySelector(".variant-pop-check"), entries[0].querySelector(".variant-pop-row")];
    const [box1, row1] = [entries[1].querySelector(".variant-pop-check"), entries[1].querySelector(".variant-pop-row")];
    const press = (key) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    row0.focus();
    press("ArrowUp");
    expect(document.activeElement).toBe(box0);
    press("ArrowDown");
    press("ArrowDown");
    expect(document.activeElement).toBe(box1);
    press("ArrowDown");
    expect(document.activeElement).toBe(row1);
    // The disabled boxes (cap reached) are skipped; exactly one control is a tab stop, checkboxes included.
    const items = [...pop.querySelectorAll(".variant-pop-row, .variant-pop-check:not(:disabled)")];
    expect(items.filter((i) => i.tabIndex === 0)).toEqual([row1]);
  });

  const tab = (target, init = {}) => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...init }));
  const later = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("a keyboard Tab out of the popover closes it; Tab onto its own checkboxes does not", async () => {
    const { bar } = setupCompare("confirm", { on: true, selected: [] });
    bar.querySelector(".crumb-group[data-screen=clear] .crumb-toggle").click();
    const pop = bar.querySelector(".variant-pop");
    const box = pop.querySelector(".variant-pop-check");
    pop.querySelector(".variant-pop-row").focus();
    tab(document.activeElement);
    box.focus();
    await later();
    expect(bar.querySelector(".variant-pop")).not.toBeNull();
    const outside = document.createElement("button");
    document.body.append(outside);
    tab(document.activeElement);
    outside.focus();
    await later();
    expect(bar.querySelector(".variant-pop")).toBeNull();
    expect(document.activeElement).toBe(outside); // not dropped to <body> by the rebuild
  });

  it("Shift+Tab from the first row ends on the crumb toggle, not on <body>", async () => {
    const { bar } = setupCompare("confirm", { on: false, selected: [] });
    bar.querySelector(".crumb-group[data-screen=clear] .crumb-toggle").click();
    document.activeElement.focus();
    tab(document.activeElement, { shiftKey: true });
    bar.querySelector(".crumb-group[data-screen=clear] .crumb-toggle").focus();
    await later();
    expect(bar.querySelector(".variant-pop")).toBeNull();
    expect(document.activeElement.classList.contains("crumb-toggle")).toBe(true);
    expect(document.activeElement.isConnected).toBe(true);
  });

  it("a pointer press elsewhere with the popover open does not rebuild the bar under the click: the first click navigates", async () => {
    for (const pick of [
      (ui) => ui.bar.querySelector(".crumb-group[data-screen=cart] .crumb"),
      (ui) => ui.bar.querySelector(".variant-back"),
      (ui) => ui.bar.querySelector(".compare-seg-button[data-mode=compare]"),
    ]) {
      const ui = setupCompare("confirm", { on: false, selected: [] });
      ui.bar.querySelector(".crumb-group[data-screen=clear] .crumb-toggle").click();
      const target = pick(ui);
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); // Chrome moves focus on mousedown
      target.focus();
      await later();
      expect(target.isConnected).toBe(true); // the control under the pointer survived the focus move
      target.click();
      // The handler ran on this very click: navigating closes the popover, the mode toggle reports to compare.
      expect(ui.calls).toHaveLength(1);
      expect(ui.calls[0][0]).toBe(target.classList.contains("compare-seg-button") ? "mode" : "select");
    }
  });

  it("the roving tab stop starts on the current screen's row and a rebuild keeps focus on the row it was on", () => {
    const { bar } = setupCompare("confirm", { on: true, selected: [] });
    bar.querySelector(".crumb-group[data-screen=clear] .crumb-toggle").click();
    const stops = () => [...bar.querySelectorAll(".variant-pop-row")].filter((r) => r.tabIndex === 0);
    expect(stops()).toHaveLength(1);
    expect(stops()[0].classList.contains("current")).toBe(true);
    expect(document.activeElement).toBe(stops()[0]);
    const rows = [...bar.querySelectorAll(".variant-pop-row")];
    const second = rows.find((r) => !r.classList.contains("current"));
    second.focus();
    bar.querySelector(".variant-pop-check").click(); // toggling a compare checkbox rebuilds the popover
    expect(document.activeElement.dataset.screen).toBe(second.dataset.screen);
    expect(stops()).toEqual([document.activeElement]);
  });

  it("has no toggle without the compare option", () => {
    const { bar } = setup("confirm");
    expect(bar.querySelector(".compare-seg")).toBeNull();
  });

  it("puts a checkbox on every popover row while compare is on, and none while it is off", () => {
    const off = setupCompare("confirm", {});
    off.bar.querySelector(".crumb-group[data-screen=clear] .crumb-toggle").click();
    expect(off.bar.querySelectorAll(".variant-pop-check")).toHaveLength(0);

    const { bar, calls } = setupCompare("confirm", { on: true, selected: ["all"] });
    bar.querySelector(".crumb-group[data-screen=clear] .crumb-toggle").click();
    const boxes = [...bar.querySelectorAll(".variant-pop-check")];
    expect(boxes.map((b) => [b.dataset.screen, b.checked])).toEqual([
      ["confirm", false],
      ["all", true],
      ["two-items", false],
      ["name-sheet", false],
    ]);
    boxes[0].click();
    expect(calls).toEqual([["pick", "confirm"]]);
    expect(bar.querySelector(".variant-pop")).not.toBeNull(); // ticking does not close the popover
  });

  it("disables unticked boxes once the cap is reached, keeping ticked ones usable", () => {
    const { bar } = setupCompare("confirm", { on: true, selected: ["confirm", "all", "two-items"] });
    bar.querySelector(".crumb-group[data-screen=clear] .crumb-toggle").click();
    const state = Object.fromEntries([...bar.querySelectorAll(".variant-pop-check")].map((b) => [b.dataset.screen, b.disabled]));
    expect(state).toEqual({ confirm: false, all: false, "two-items": false, "name-sheet": true });
  });

  it("openPopover opens the popover of a crumb", () => {
    const { ui, bar } = setupCompare("confirm", { on: true });
    ui.openPopover("clear");
    expect(bar.querySelector(".crumb-group[data-screen=clear] .variant-pop")).not.toBeNull();
    ui.openPopover("nope");
    expect(bar.querySelector(".crumb-group[data-screen=clear] .variant-pop")).not.toBeNull();
  });
});
