// @vitest-environment jsdom
//
// Smoke tests for renderScreenList's DOM output — structure, aria state and
// click wiring only. filterScreens (the actual filtering logic) is tested
// directly in screens.test.js under the fast node environment; this file
// exists solely because renderScreenList needs a real `document`.
import { describe, it, expect, vi } from "vitest";
import { renderScreenList, renderBoardScreenList } from "./screens.js";

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
    v("cart", undefined, undefined, ["a", "b", "c", "d"]),
    v("cart-sheet", "cart", "overlay"),
    v("cart-sheet-confirm", "cart-sheet", "step"),
    v("cart-sheet-confirm-error", "cart-sheet-confirm", "state"),
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

  it("a flat project has no chevron or count, but every row carries a viewport icon and tree semantics", () => {
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
      { viewports: new Map([["a", { width: 1280, height: 800 }]]) },
    );
    expect(listEl.querySelector(".screen-item-toggle, .screen-item-total")).toBeNull();
    const icons = [...listEl.querySelectorAll(".kind-icon")].map((i) => [i.textContent, i.dataset.viewport]);
    expect(icons).toEqual([
      ["desktop_windows", "desktop"],
      ["smartphone", "mobile"], // an unknown size reads as the default phone frame
    ]);
    const items = [...listEl.querySelectorAll(".screen-item")];
    expect(items.every((i) => i.getAttribute("role") === "treeitem" && i.getAttribute("aria-level") === "1")).toBe(true);
  });

  it("marks the open screen as the selected tree item", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, [{ name: "a", tags: [] }, { name: "b", tags: [] }], "b", () => {}, "");
    const states = [...listEl.querySelectorAll(".screen-item")].map((i) => [i.getAttribute("aria-selected"), i.getAttribute("aria-current")]);
    expect(states).toEqual([["false", "false"], ["true", "true"]]);
  });

  it("shows only roots collapsed, with the subtree count badge", () => {
    const listEl = render();
    expect(rowNames(listEl)).toEqual(["cart", "solo"]);
    expect(listEl.querySelector('[data-screen="cart"] .screen-item-total').textContent).toBe("3");
    expect(listEl.querySelector('[data-screen="solo"] .screen-item-toggle')).toBeNull();
  });

  it("disclosure triangle toggles via onToggleExpand without selecting", () => {
    const toggled = [];
    const selected = [];
    const listEl = document.createElement("ul");
    renderScreenList(listEl, tree, null, (n) => selected.push(n), "", {
      onToggleExpand: (n) => toggled.push(n),
    });
    const toggle = listEl.querySelector('[data-screen="cart"] .screen-item-toggle');
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    expect(toggled).toEqual(["cart"]);
    expect(selected).toEqual([]);
  });

  it("the disclosure toggle is a chevron icon that follows the expanded state", () => {
    const collapsed = render();
    expect(collapsed.querySelector('[data-screen="cart"] .screen-item-toggle .icon').textContent).toBe("chevron_right");
    const open = render({ expanded: new Set(["cart"]) });
    expect(open.querySelector('[data-screen="cart"] .screen-item-toggle .icon').textContent).toBe("expand_more");
  });

  it("nests expanded variants with depth, kind icons, suffix names and a hover title", () => {
    const listEl = render({
      expanded: new Set(["cart", "cart-sheet", "cart-sheet-confirm"]),
    });
    expect(rowNames(listEl)).toEqual([
      "cart",
      "cart-sheet",
      "cart-sheet-confirm",
      "cart-sheet-confirm-error",
      "solo",
    ]);
    const row = (n) => listEl.querySelector(`[data-screen="${n}"]`);
    expect(row("cart-sheet").dataset.depth).toBe("1");
    expect(row("cart-sheet-confirm-error").dataset.depth).toBe("3");
    expect(row("cart-sheet").querySelector(".kind-icon").textContent).toBe("web_asset"); // an overlay keeps its own glyph
    expect(row("cart-sheet-confirm").querySelector(".kind-icon").textContent).toBe("subdirectory_arrow_right");
    expect(row("cart").querySelector(".kind-icon").dataset.viewport).toBe("mobile");
    expect(row("cart-sheet-confirm-error").querySelector(".kind-icon").dataset.viewport).toBe("mobile"); // a state variant shows its viewport
    expect(row("cart-sheet-confirm-error").querySelector(".screen-item").getAttribute("aria-level")).toBe("4");
    expect(row("cart-sheet-confirm").querySelector(".screen-item-text").textContent).toBe(
      "confirm",
    );
    expect(row("cart-sheet-confirm").querySelector(".screen-item").title).toBe(
      "cart-sheet-confirm\ncart › cart-sheet › cart-sheet-confirm",
    );
    expect(row("cart").querySelector(".screen-item").title).toBe("");
  });

  it("shows the first two tags plus a +N chip whose title lists every tag", () => {
    const listEl = render();
    const chips = [...listEl.querySelectorAll('[data-screen="cart"] .tag-chip')];
    expect(chips.map((c) => c.textContent)).toEqual(["a", "b", "+2"]);
    expect(chips[2].title).toBe("a, b, c, d");
  });

  it("gives every tag chip its full name as title (a long tag is truncated by CSS)", () => {
    const listEl = render();
    const chips = [...listEl.querySelectorAll('[data-screen="cart"] .tag-chip:not(.tag-more)')];
    expect(chips.map((c) => c.title)).toEqual(["a", "b"]);
  });

  it("hides every chip when showTags is false", () => {
    expect(render({ showTags: false }).querySelector(".tag-row")).toBeNull();
  });

  it("while filtering: grey context rows, highlighted match, hidden line", () => {
    const listEl = render({}, { filter: "error" });
    expect(rowNames(listEl)).toEqual([
      "cart",
      "cart-sheet",
      "cart-sheet-confirm",
      "cart-sheet-confirm-error",
    ]);
    expect(listEl.querySelector('[data-screen="cart"]').classList.contains("context")).toBe(true);
    expect(
      listEl.querySelector('[data-screen="cart-sheet-confirm-error"] mark').textContent,
    ).toBe("error");
    const withSibling = render({}, { filter: "sheet-confirm-error" });
    expect(withSibling.querySelector(".screen-hidden-row")).toBeNull();
  });

  it("while filtering: the toggle of a row held open by a match below is disabled", () => {
    const listEl = render({}, { filter: "error" });
    expect(listEl.querySelector('[data-screen="cart"] .screen-item-toggle').disabled).toBe(true);
    expect(render().querySelector('[data-screen="cart"] .screen-item-toggle').disabled).toBe(false);
  });

  it("puts the disclosure toggle before the select button in DOM (tab) order", () => {
    const li = render().querySelector('[data-screen="cart"]');
    const controls = [...li.children].filter((el) => el.tagName === "BUTTON").map((el) => el.className.split(" ")[0]);
    expect(controls.indexOf("screen-item-toggle")).toBeLessThan(controls.indexOf("screen-item"));
  });

  it("while filtering: a matching tag chip is promoted and highlighted", () => {
    const listEl = render({}, { filter: "d" });
    const chips = [...listEl.querySelectorAll('[data-screen="cart"] .tag-chip')];
    expect(chips[0].textContent).toBe("d");
    expect(chips[0].classList.contains("match")).toBe(true);
  });

  it("pinning a nested leaf row pins only itself", () => {
    const onTogglePin = vi.fn();
    const listEl = render({
      expanded: new Set(["cart", "cart-sheet", "cart-sheet-confirm"]),
      pinned: new Set(),
      onTogglePin,
    });
    listEl.querySelector('[data-screen="cart-sheet-confirm-error"] .screen-item-pin').click();
    expect(onTogglePin).toHaveBeenCalledWith("cart-sheet-confirm-error", [
      "cart-sheet-confirm-error",
    ]);
  });

  it("pinning a group row passes the screen and its whole subtree; pressed only when all are pinned", () => {
    const onTogglePin = vi.fn();
    const all = ["cart", "cart-sheet", "cart-sheet-confirm", "cart-sheet-confirm-error"];
    const partial = render({ pinned: new Set(["cart"]), onTogglePin });
    expect(
      partial.querySelector('[data-screen="cart"] .screen-item-pin').getAttribute("aria-pressed"),
    ).toBe("false");
    partial.querySelector('[data-screen="cart"] .screen-item-pin').click();
    expect(onTogglePin).toHaveBeenCalledWith("cart", all);
    const full = render({ pinned: new Set(all), onTogglePin });
    expect(
      full.querySelector('[data-screen="cart"] .screen-item-pin').getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("renderScreenList compare checkboxes (CHR-738)", () => {
  const screens = [
    { name: "plain", tags: [] },
    { name: "cart", tags: [] },
    { name: "a", tags: [], variant_of: "cart", variant_kind: "state" },
    { name: "a1", tags: [], variant_of: "a", variant_kind: "step" },
    { name: "b", tags: [], variant_of: "cart", variant_kind: "state" },
  ];
  const render = (compare) => {
    const listEl = document.createElement("ul");
    document.body.replaceChildren(listEl); // jsdom fires a checkbox's change only while it is connected
    renderScreenList(listEl, screens, "a", () => {}, "", { expanded: new Set(["cart", "a"]), compare });
    return listEl;
  };
  const boxes = (listEl) => Object.fromEntries([...listEl.querySelectorAll("li")].map((li) => [li.dataset.screen, li.querySelector(".screen-item-compare")]));

  it("renders none without the compare option", () => {
    expect(render(undefined).querySelectorAll(".screen-item-compare")).toHaveLength(0);
  });

  it("puts one on each row of the family only: reference ticked and locked, members by selection", () => {
    const found = boxes(render({ reference: "cart", family: ["cart", "a", "a1", "b"], selected: ["a1"], cap: 3, onToggle: () => {} }));
    expect(found.plain).toBeNull();
    expect([found.cart.checked, found.cart.disabled]).toEqual([true, true]);
    expect([found.a.checked, found.a.disabled]).toEqual([false, false]);
    expect([found.a1.checked, found.a1.disabled]).toEqual([true, false]);
    expect([found.b.checked, found.b.disabled]).toEqual([false, false]);
  });

  it("toggles through onToggle and disables the unticked boxes once the cap is reached", () => {
    const toggled = [];
    const listEl = render({ reference: "cart", family: ["cart", "a", "a1", "b"], selected: ["a", "a1", "b"], cap: 3, onToggle: (n) => toggled.push(n) });
    const found = boxes(listEl);
    expect([found.a.disabled, found.a1.disabled, found.b.disabled]).toEqual([false, false, false]);
    found.a1.click();
    expect(toggled).toEqual(["a1"]);

    const full = boxes(render({ reference: "cart", family: ["cart", "a", "a1", "b"], selected: ["a"], cap: 1, onToggle: () => {} }));
    expect([full.a.disabled, full.a1.disabled, full.b.disabled]).toEqual([false, true, true]);
  });
});

describe("pin toggles (design `pin-toggle`)", () => {
  const screens = [{ name: "home", tags: [] }, { name: "cart", tags: [] }];
  it("name what pressing them does: pin to the board, unpin from the board", () => {
    const listEl = document.createElement("ul");
    renderScreenList(listEl, screens, null, () => {}, "", { pinned: new Set(["cart"]), onTogglePin: () => {} });
    expect([...listEl.querySelectorAll(".screen-item-pin")].map((b) => b.getAttribute("aria-label"))).toEqual(["Pin home to the board", "Unpin cart from the board"]);
    expect(listEl.querySelector(".screen-item-pin .icon").textContent).toBe("keep");
    expect(listEl.querySelector(".screen-item-pin").classList.contains("always")).toBe(false); // hover-revealed in the Screens view
  });
});

describe("renderBoardScreenList (the Board's card)", () => {
  const screens = [
    { name: "checkout", tags: ["checkout", "payments"] },
    { name: "checkout-error", tags: [], variant_of: "checkout", variant_kind: "state" },
    { name: "cart", tags: ["checkout"] },
    { name: "home", tags: ["orders"] },
    { name: "settings", tags: ["account"] },
    { name: "sign-in", tags: ["auth"] },
  ];
  const draw = (filter, pinned) => {
    const listEl = document.createElement("ul");
    const drawn = renderBoardScreenList(listEl, screens, null, () => {}, filter, { pinned: new Set(pinned), onTogglePin: () => {} });
    const layout = [...listEl.children].map((li) => (li.classList.contains("screen-section") ? `# ${li.querySelector(".screen-section-title").textContent} ${li.querySelector(".screen-section-count").textContent}` : li.querySelector(".screen-item-text")?.textContent ?? li.textContent));
    return { listEl, drawn, layout };
  };

  it("with a filter: Matches (what it finds) and Pinned (pinned screens it does not find)", () => {
    const { drawn, layout } = draw("checkout", ["home", "settings"]);
    expect(drawn).toEqual([{ title: "Matches", count: 2 }, { title: "Pinned", count: 2 }]);
    expect(layout).toEqual(["# Matches 2", "checkout", "error", "cart", "# Pinned 2", "home", "settings"]); // the variant that matches too is a row under its main screen
  });

  it("without a filter: Pinned, then All screens (the rest)", () => {
    const { drawn, layout } = draw("", ["home"]);
    expect(drawn).toEqual([{ title: "Pinned", count: 1 }, { title: "All screens", count: 4 }]);
    expect(layout.slice(0, 3)).toEqual(["# Pinned 1", "home", "# All screens 4"]);
  });

  it("without a filter and nothing pinned: only All screens", () => {
    expect(draw("", []).drawn).toEqual([{ title: "All screens", count: 5 }]);
  });

  it("a pinned screen that matches the filter stays under Matches, not twice", () => {
    const { drawn } = draw("checkout", ["checkout"]);
    expect(drawn).toEqual([{ title: "Matches", count: 2 }]);
  });

  it("a pin on a variant keeps its whole tree under Pinned", () => {
    const { drawn, layout } = draw("home", ["checkout-error"]);
    expect(drawn).toEqual([{ title: "Matches", count: 1 }, { title: "Pinned", count: 1 }]);
    expect(layout).toContain("checkout");
  });

  it("a filter that finds nothing, with nothing pinned, is the one line", () => {
    const { listEl, drawn } = draw("xyzzy", []);
    expect(drawn).toEqual([{ title: "Matches", count: 0 }]);
    expect(listEl.querySelector(".screen-section")).toBeNull();
    expect(listEl.querySelector(".nav-empty").textContent).toBe("No screen or tag matches \u201cxyzzy\u201d.");
  });

  it("a filter that finds nothing but leaves pins keeps the Matches heading with its line, and the pins below", () => {
    const { layout } = draw("xyzzy", ["home"]);
    expect(layout).toEqual(["# Matches 0", "No screen or tag matches \u201cxyzzy\u201d.", "# Pinned 1", "home"]);
  });

  it("a pinned variant is listed with its toggle when the filter matches only its siblings (the board still shows it)", () => {
    const family = [
      { name: "cart", tags: [] },
      { name: "cart-empty", tags: [], variant_of: "cart", variant_kind: "state" },
      { name: "cart-updated", tags: [], variant_of: "cart", variant_kind: "state" },
    ];
    const listEl = document.createElement("ul");
    const drawn = renderBoardScreenList(listEl, family, null, () => {}, "cart-empty", { pinned: new Set(["cart-updated"]), onTogglePin: () => {} });
    expect(drawn).toEqual([{ title: "Matches", count: 1 }, { title: "Pinned", count: 1 }]);
    const pinnedRow = listEl.querySelector('[data-screen="cart-updated"]');
    expect(pinnedRow).not.toBeNull();
    expect(pinnedRow.querySelector(".screen-item-pin").getAttribute("aria-label")).toBe("Unpin cart-updated from the board");
    expect(pinnedRow.querySelector(".screen-item-pin").classList.contains("pinned")).toBe(true);
    // Every screen that is pinned has a row with a toggle somewhere in the list.
    expect([...listEl.querySelectorAll(".screen-item-pin.pinned")].map((b) => b.closest("li").dataset.screen)).toContain("cart-updated");
  });

  it("without a filter a pinned variant under a root that is not fully pinned is opened up to, while a fully pinned family stays one row", () => {
    const family = [
      { name: "cart", tags: [] },
      { name: "cart-empty", tags: [], variant_of: "cart", variant_kind: "state" },
      { name: "cart-updated", tags: [], variant_of: "cart", variant_kind: "state" },
      { name: "home", tags: [] },
      { name: "home-empty", tags: [], variant_of: "home", variant_kind: "state" },
    ];
    const listEl = document.createElement("ul");
    renderBoardScreenList(listEl, family, null, () => {}, "", { pinned: new Set(["cart-updated", "home", "home-empty"]), onTogglePin: () => {} });
    const rows = [...listEl.querySelectorAll("li[data-screen]")].map((li) => li.dataset.screen);
    expect(rows).toContain("cart-updated");
    expect(rows).not.toContain("home-empty"); // home's row stands for its fully pinned family
  });

  it("every row's pin toggle is always shown on the Board's list", () => {
    const { listEl } = draw("", ["home"]);
    const pins = [...listEl.querySelectorAll(".screen-item-pin")];
    expect(pins.length).toBe(5);
    expect(pins.every((b) => b.classList.contains("always"))).toBe(true);
  });
});
