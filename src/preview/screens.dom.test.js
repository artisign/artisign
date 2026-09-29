// @vitest-environment jsdom
//
// Smoke tests for renderScreenList's DOM output — structure, aria state and
// click wiring only. filterScreens (the actual filtering logic) is tested
// directly in screens.test.js under the fast node environment; this file
// exists solely because renderScreenList needs a real `document`.
import { describe, it, expect, vi } from "vitest";
import { renderScreenList } from "./screens.js";

describe("renderScreenList", () => {
  const screens = [
    { name: "checkout-cart", tags: ["checkout", "payment"] },
    { name: "login", tags: [] },
  ];

  it("renders one row per screen with name and tag chips", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, "login", () => {}, "");

    const items = listEl.querySelectorAll("li");
    expect(items).toHaveLength(2);

    const [cartBtn, loginBtn] = listEl.querySelectorAll("button.screen-item");
    expect(cartBtn.querySelector(".screen-item-name").textContent).toBe("checkout-cart");
    expect([...cartBtn.querySelectorAll(".tag-chip")].map((el) => el.textContent)).toEqual(["checkout", "payment"]);
    // No tags -> no tag row at all, not an empty one.
    expect(loginBtn.querySelector(".tag-row")).toBeNull();
  });

  it("marks the active screen via aria-current", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, "login", () => {}, "");

    const [cartBtn, loginBtn] = listEl.querySelectorAll("button.screen-item");
    expect(cartBtn.getAttribute("aria-current")).toBe("false");
    expect(loginBtn.getAttribute("aria-current")).toBe("true");
  });

  it("applies the filter and wires row clicks to onSelect", () => {
    const listEl = document.createElement("ul");
    const selected = [];
    renderScreenList(listEl, screens, null, (name) => selected.push(name), "checkout");

    const buttons = listEl.querySelectorAll("button.screen-item");
    expect(buttons).toHaveLength(1);
    buttons[0].click();
    expect(selected).toEqual(["checkout-cart"]);
  });

  it("clears previous content on re-render", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, null, () => {}, "");
    renderScreenList(listEl, [screens[0]], null, () => {}, "");
    expect(listEl.querySelectorAll("li")).toHaveLength(1);
  });

  it("renders no pin button at all when onTogglePin is omitted (CHR-624 — every caller before this ticket)", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, null, () => {}, "");
    expect(listEl.querySelector(".screen-item-pin")).toBeNull();
  });

  it("renders a pin button per row as a SIBLING of the select button, not nested inside it", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, null, () => {}, "", { pinned: new Set(), onTogglePin: () => {} });
    const row = listEl.querySelector("li");
    expect(row.querySelector(".screen-item .screen-item-pin")).toBeNull(); // not nested
    expect(row.children).toHaveLength(2); // button.screen-item, button.screen-item-pin
  });

  it("reflects the pinned set via aria-pressed and a pinned class", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, null, () => {}, "", { pinned: new Set(["login"]), onTogglePin: () => {} });
    const pins = [...listEl.querySelectorAll(".screen-item-pin")];
    const [cartPin, loginPin] = pins;
    expect(cartPin.getAttribute("aria-pressed")).toBe("false");
    expect(cartPin.classList.contains("pinned")).toBe(false);
    expect(loginPin.getAttribute("aria-pressed")).toBe("true");
    expect(loginPin.classList.contains("pinned")).toBe(true);
  });

  it("calls onTogglePin with the screen name, and never onSelect, when the pin button is clicked", () => {
    const listEl = document.createElement("ul");
    const selected = [];
    const toggled = [];
    renderScreenList(listEl, screens, null, (name) => selected.push(name), "", {
      pinned: new Set(),
      onTogglePin: (name) => toggled.push(name),
    });
    listEl.querySelector(".screen-item-pin").click();
    expect(toggled).toEqual(["checkout-cart"]);
    expect(selected).toEqual([]);
  });

  it("only shows a pin button for rows the filter actually shows — pinned-outside-filter is a board-only distinction", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, null, () => {}, "checkout", { pinned: new Set(["login"]), onTogglePin: () => {} });
    expect(listEl.querySelectorAll("li")).toHaveLength(1); // "login" doesn't match "checkout" — not in the list at all
  });
});

// CHR-731 — variant tree, tag chips, group pinning.
describe("renderScreenList — variant tree", () => {
  const v = (name, variant_of, variant_kind, tags = []) => ({
    name,
    tags,
    ...(variant_of ? { variant_of, variant_kind } : {}),
  });
  const tree = [
    v("family", undefined, undefined, ["a", "b", "c", "d"]),
    v("family-sheet", "family", "overlay"),
    v("family-sheet-confirm", "family-sheet", "step"),
    v("family-sheet-confirm-error", "family-sheet-confirm", "state"),
    v("solo"),
  ];
  const render = (opts = {}, { active = null, filter = "" } = {}) => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, tree, active, () => {}, filter, opts);
    return listEl;
  };
  const rowNames = (listEl) =>
    [...listEl.querySelectorAll("li.screen-item-row:not(.screen-hidden-row)")].map(
      (li) => li.dataset.screen,
    );

  it("renders exactly the flat list when no screen has a variant_of (no tree chrome)", () => {
    const listEl = document.createElement("ul");
    renderScreenList(
      listEl,
      [
        { name: "a", tags: [] },
        { name: "b", tags: [] },
      ],
      null,
      () => {},
      "",
    );
    expect(
      listEl.querySelector(".screen-item-toggle, .kind-icon, .screen-item-total, [data-depth]"),
    ).toBeNull();
    expect(listEl.querySelector(".screen-item.in-tree")).toBeNull();
  });

  it("shows only roots collapsed, with the subtree count badge", () => {
    const listEl = render();
    expect(rowNames(listEl)).toEqual(["family", "solo"]);
    expect(listEl.querySelector('[data-screen="family"] .screen-item-total').textContent).toBe("3");
    expect(listEl.querySelector('[data-screen="solo"] .screen-item-toggle')).toBeNull();
  });

  it("disclosure triangle toggles via onToggleExpand without selecting", () => {
    const toggled = [];
    const selected = [];
    const listEl = document.createElement("ul");
    renderScreenList(listEl, tree, null, (n) => selected.push(n), "", {
      onToggleExpand: (n) => toggled.push(n),
    });
    const toggle = listEl.querySelector('[data-screen="family"] .screen-item-toggle');
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    expect(toggled).toEqual(["family"]);
    expect(selected).toEqual([]);
  });

  it("nests expanded variants with depth, kind icons, suffix names and a hover title", () => {
    const listEl = render({
      expanded: new Set(["family", "family-sheet", "family-sheet-confirm"]),
    });
    expect(rowNames(listEl)).toEqual([
      "family",
      "family-sheet",
      "family-sheet-confirm",
      "family-sheet-confirm-error",
      "solo",
    ]);
    const row = (n) => listEl.querySelector(`[data-screen="${n}"]`);
    expect(row("family-sheet").dataset.depth).toBe("1");
    expect(row("family-sheet-confirm-error").dataset.depth).toBe("3");
    expect(row("family-sheet").querySelector(".kind-icon").dataset.kind).toBe("overlay");
    expect(row("family-sheet-confirm").querySelector(".kind-icon").textContent).toBe("↪");
    expect(row("family").querySelector(".kind-icon")).toBeNull();
    expect(row("family-sheet-confirm").querySelector(".screen-item-text").textContent).toBe(
      "…-confirm",
    );
    expect(row("family-sheet-confirm").querySelector(".screen-item").title).toBe(
      "family-sheet-confirm\nfamily › family-sheet › family-sheet-confirm",
    );
    expect(row("family").querySelector(".screen-item").title).toBe("");
  });

  it("shows the first two tags plus a +N chip whose title lists every tag", () => {
    const listEl = render();
    const chips = [...listEl.querySelectorAll('[data-screen="family"] .tag-chip')];
    expect(chips.map((c) => c.textContent)).toEqual(["a", "b", "+2"]);
    expect(chips[2].title).toBe("a, b, c, d");
  });

  it("hides every chip when showTags is false", () => {
    expect(render({ showTags: false }).querySelector(".tag-row")).toBeNull();
  });

  it("while filtering: grey context rows, highlighted match, hidden line", () => {
    const listEl = render({}, { filter: "error" });
    expect(rowNames(listEl)).toEqual([
      "family",
      "family-sheet",
      "family-sheet-confirm",
      "family-sheet-confirm-error",
    ]);
    expect(listEl.querySelector('[data-screen="family"]').classList.contains("context")).toBe(true);
    expect(
      listEl.querySelector('[data-screen="family-sheet-confirm-error"] mark').textContent,
    ).toBe("error");
    const withSibling = render({}, { filter: "sheet-confirm-error" });
    expect(withSibling.querySelector(".screen-hidden-row")).toBeNull();
  });

  it("while filtering: a matching tag chip is promoted and highlighted", () => {
    const listEl = render({}, { filter: "d" });
    const chips = [...listEl.querySelectorAll('[data-screen="family"] .tag-chip')];
    expect(chips[0].textContent).toBe("d");
    expect(chips[0].classList.contains("match")).toBe(true);
  });

  it("pinning a nested leaf row pins only itself", () => {
    const onTogglePin = vi.fn();
    const listEl = render({
      expanded: new Set(["family", "family-sheet", "family-sheet-confirm"]),
      pinned: new Set(),
      onTogglePin,
    });
    listEl.querySelector('[data-screen="family-sheet-confirm-error"] .screen-item-pin').click();
    expect(onTogglePin).toHaveBeenCalledWith("family-sheet-confirm-error", [
      "family-sheet-confirm-error",
    ]);
  });

  it("pinning a group row passes the screen and its whole subtree; pressed only when all are pinned", () => {
    const onTogglePin = vi.fn();
    const all = ["family", "family-sheet", "family-sheet-confirm", "family-sheet-confirm-error"];
    const partial = render({ pinned: new Set(["family"]), onTogglePin });
    expect(
      partial.querySelector('[data-screen="family"] .screen-item-pin').getAttribute("aria-pressed"),
    ).toBe("false");
    partial.querySelector('[data-screen="family"] .screen-item-pin').click();
    expect(onTogglePin).toHaveBeenCalledWith("family", all);
    const full = render({ pinned: new Set(all), onTogglePin });
    expect(
      full.querySelector('[data-screen="family"] .screen-item-pin').getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
