// @vitest-environment jsdom
//
// Step reordering in the use-case edit dialog (CHR-1110): keyboard grab-move-drop, the ⋯ menu with Move up / Move down,
// pointer drag with its drop marker, one announcement wording, rows moved (not redrawn), the menu's command items.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openUseCaseDialog } from "./usecases-forms.js";
import { dropIndex, movedText } from "./usecases-reorder.js";
import { openMenu, closeMenu } from "./usecases-menu.js";
import { makePool, rawUseCase } from "./usecases.test-helper.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const actions = () => $$(".uc-step-edit input[aria-label$='action']").map((i) => i.value);
const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const live = () => $(".uc-reorder-live").textContent;

function options(over = {}) {
  return {
    mode: "edit",
    source: rawUseCase,
    pool: () => makePool(),
    screens: () => ["editor", "picker"],
    groups: () => [],
    takenIds: () => new Set(["map-step"]),
    loadNodes: async () => [],
    save: vi.fn(async () => ({ ok: true, data: { warnings: [] } })),
    newObject: vi.fn(async () => {}),
    ...over,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  closeMenu();
  vi.useRealTimers();
});

async function open(over) {
  const opts = options(over);
  openUseCaseDialog(opts);
  await vi.advanceTimersByTimeAsync(10);
  return opts;
}

describe("pure helpers", () => {
  it("dropIndex counts the midpoints above the pointer; movedText has one wording", () => {
    expect(dropIndex([10, 30, 50], 5)).toBe(0);
    expect(dropIndex([10, 30, 50], 35)).toBe(2);
    expect(dropIndex([10, 30, 50], 999)).toBe(3);
    expect(movedText("Clicks Save", 1, 5)).toBe("Clicks Save, moved to step 2 of 5.");
  });
});

describe("step reordering", () => {
  it("every row has a handle, a ⋯ menu and no inline up/down buttons", async () => {
    await open();
    const rows = $$(".uc-step-edit");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect($(".uc-drag-handle[aria-pressed=false]", row)).not.toBeNull();
      expect($("button[aria-haspopup=menu]", row)).not.toBeNull();
    }
    expect($("button[data-tooltip='Move up']")).toBeNull();
    // the key hint is the row's last line and carries both texts; CSS picks one by focus / grab state
    const hint = rows[0].lastElementChild;
    expect(hint.classList.contains("uc-step-keys")).toBe(true);
    expect($(".uc-step-keys-rest", hint).textContent).toBe("Space to reorder");
    $(".uc-drag-handle").dispatchEvent(new Event("focus"));
    expect($(".uc-drag-handle").getAttribute("aria-label")).toMatch(/^Reorder step 1, /); // set on focus
  });

  it("keyboard: Space picks up, arrows move the real row, Space drops, the arrows do nothing before the pickup", async () => {
    await open();
    const first = actions();
    const handle = () => $$(".uc-step-edit")[0].querySelector(".uc-drag-handle");
    key(handle(), "ArrowDown");
    expect(actions()).toEqual(first);
    const row = $$(".uc-step-edit")[0];
    key(handle(), " ");
    expect(handle().getAttribute("aria-pressed")).toBe("true");
    expect(row.classList.contains("is-grabbed")).toBe(true); // CSS shows the grabbed hint on this row
    expect($(".uc-step-keys-grab", row).textContent).toBe("Arrows to move · Space to drop · Esc to cancel");
    key(handle(), "ArrowDown");
    expect(actions()).toEqual([first[1], first[0], first[2]]);
    expect($$(".uc-step-edit")[1]).toBe(row); // the same node, moved
    expect($$(".uc-step-edit-no").map((n) => n.textContent)).toEqual(["1", "2", "3"]);
    expect($("input[aria-label='Step 2 action']", row)).not.toBeNull();
    vi.advanceTimersByTime(600);
    expect(live()).toBe(`${first[0]}, moved to step 2 of 3.`);
    key($$(".uc-step-edit")[1].querySelector(".uc-drag-handle"), " ");
    expect($$(".uc-drag-handle")[1].getAttribute("aria-pressed")).toBe("false");
    // the move marks the form dirty: Cancel now asks first
    $$("dialog .uc-foot-actions button").find((b) => b.textContent === "Cancel").click();
    expect($(".uc-foot-msg").textContent).toContain("unsaved changes");
  });

  it("keyboard: Escape puts the row back and says 'Move cancelled.'; the first row cannot move up", async () => {
    await open();
    const first = actions();
    const handle = () => $$(".uc-step-edit")[0].querySelector(".uc-drag-handle");
    key(handle(), " ");
    key(handle(), "ArrowUp");
    expect(actions()).toEqual(first);
    key(handle(), "ArrowDown");
    key($$(".uc-step-edit")[1].querySelector(".uc-drag-handle"), "Escape");
    expect(actions()).toEqual(first);
    vi.advanceTimersByTime(600);
    expect(live()).toBe("Move cancelled.");
    expect($$(".uc-drag-handle").every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("the ⋯ menu moves a step up or down; the ends have the disabled item; the dialog stays dirty-tracked", async () => {
    await open();
    const first = actions();
    $$(".uc-step-edit")[0].querySelector("button[aria-haspopup=menu]").click();
    const up = $("[role=menuitem][data-value=up]");
    const down = $("[role=menuitem][data-value=down]");
    expect(up.getAttribute("aria-disabled")).toBe("true");
    expect(down.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(down); // the arrows skip the disabled item
    up.click(); // no-op: still open
    expect($("[role=menu]")).not.toBeNull();
    down.click();
    expect(actions()).toEqual([first[1], first[0], first[2]]);
    expect($("[role=menu]")).toBeNull();
    vi.advanceTimersByTime(600);
    expect(live()).toBe(`${first[0]}, moved to step 2 of 3.`);
    expect(document.activeElement.getAttribute("aria-label")).toBe("Actions for step 2");
    expect($(".uc-foot-msg")).not.toBeNull();
  });

  it("a moved step is saved in the new order, with its warnings following the row", async () => {
    const opts = await open();
    $$(".uc-step-edit")[2].querySelector("button[aria-haspopup=menu]").click();
    $("[role=menuitem][data-value=up]").click();
    const save = $$("dialog .uc-foot-actions button").find((b) => b.textContent.startsWith("Save"));
    save.click();
    await vi.advanceTimersByTimeAsync(10);
    const sent = opts.save.mock.calls[0][0] ?? opts.save.mock.calls[0];
    const steps = (sent.payload ?? sent).steps ?? [];
    expect(steps.map((s) => s.action)).toEqual([rawUseCase.steps[0].action, rawUseCase.steps[2].action, rawUseCase.steps[1].action]);
  });

  it("pointer drag: only the handle starts it; the marker shows the landing gap; release moves once; Escape cancels", async () => {
    await open();
    const list = $(".uc-steps-edit");
    const rows = () => $$(".uc-step-edit");
    rows().forEach((row, i) => {
      Object.defineProperty(row, "offsetTop", { configurable: true, get: () => i * 100 });
      Object.defineProperty(row, "offsetHeight", { configurable: true, get: () => 80 });
      row.getBoundingClientRect = () => ({ top: i * 100, bottom: i * 100 + 80, height: 80, left: 0, right: 100, width: 100 });
    });
    list.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300, left: 0, right: 100, width: 100 });
    Object.defineProperty(list, "offsetHeight", { configurable: true, get: () => 300 });
    const first = actions();
    const pointer = (type, y, el = document) => el.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerId: 1, clientY: y, button: 0, isPrimary: true }));
    const handle = rows()[0].querySelector(".uc-drag-handle");
    // a pointerdown on the row body (not the handle) starts nothing
    pointer("pointerdown", 40, rows()[0].querySelector("input"));
    expect($(".uc-drop-marker")).toBeNull();
    pointer("pointerdown", 40, handle);
    expect(rows()[0].classList.contains("is-lifted")).toBe(true);
    expect($(".uc-step-slot")).not.toBeNull();
    pointer("pointermove", 150);
    expect($(".uc-drop-marker").hidden).toBe(false);
    // going down the marker is read at the lifted row's bottom edge: 150 - 40 + 80 = 190 passes one row midpoint (140)
    expect($(".uc-drop-marker").style.top).toBe("186px"); // gap between rows 2 and 3 is 180..200, centre 190, minus half the 8px marker
    pointer("pointermove", 20);
    expect($(".uc-drop-marker").hidden).toBe(true); // own slot: no marker
    key(document.body, "Escape");
    expect($(".uc-drop-marker")).toBeNull();
    expect(actions()).toEqual(first);
    vi.advanceTimersByTime(600);
    expect(live()).toBe("Move cancelled.");
    // a second drag, released between rows 2 and 3
    pointer("pointerdown", 40, rows()[0].querySelector(".uc-drag-handle"));
    pointer("pointermove", 190);
    pointer("pointerup", 190);
    expect(actions()).toEqual([first[1], first[0], first[2]]);
    expect($(".uc-drop-marker")).toBeNull();
    expect($(".uc-step-slot")).toBeNull();
    expect(rows().some((r) => r.classList.contains("is-lifted"))).toBe(false);
    vi.advanceTimersByTime(600);
    expect(live()).toBe(`${first[0]}, moved to step 2 of 3.`);
  });
});

describe("review findings", () => {
  it("a part drawn after a move (a new data change) uses the step's current position, not the one it was drawn at", async () => {
    await open();
    $$(".uc-step-edit")[0].querySelector("button[aria-haspopup=menu]").click();
    $("[role=menuitem][data-value=down]").click(); // the first step is now second
    const moved = $$(".uc-step-edit")[1];
    expect($("input[aria-label$='action']", moved).value).toBe(actions()[1]);
    $$("button", moved).find((b) => b.textContent.includes("Data change")).click();
    expect($("input[aria-label='Step 2 data 1 before']", moved)).not.toBeNull();
    expect($("[data-path='step.1.data.0.before']", moved)).not.toBeNull();
    expect($("input[aria-label='Step 1 data 1 before']", moved)).toBeNull();
    // and a target switch redraws with the new number too
    $$(".uc-segmented button", moved).find((b) => b.textContent === "Element").click();
    expect($("[aria-label='Step 2 element']", moved)).not.toBeNull();
  });

  it("a blur caused by the move itself does not end the keyboard grab", async () => {
    await open();
    const list = $(".uc-steps-edit");
    const real = list.insertBefore.bind(list);
    list.insertBefore = (node, ref) => {
      node.querySelector(".uc-drag-handle").dispatchEvent(new Event("blur")); // what a browser without moveBefore does
      return real(node, ref);
    };
    const handle = () => $$(".uc-step-edit")[0].querySelector(".uc-drag-handle");
    const row = $$(".uc-step-edit")[0];
    handle().focus();
    key(handle(), " ");
    key(handle(), "ArrowDown");
    expect(row.classList.contains("is-grabbed")).toBe(true);
    key($$(".uc-step-edit")[1].querySelector(".uc-drag-handle"), "ArrowDown");
    expect($$(".uc-step-edit")[2]).toBe(row);
    // a real blur (focus leaves the handle) still drops
    $$(".uc-step-edit")[2].querySelector(".uc-drag-handle").dispatchEvent(new Event("blur"));
    expect(row.classList.contains("is-grabbed")).toBe(false);
  });

  it("the handle and the ⋯ button have their names when drawn", async () => {
    await open();
    expect($$(".uc-steps-edit .uc-drag-handle").map((b) => b.getAttribute("aria-label"))).toEqual(actions().map((a, i) => `Reorder step ${i + 1}, ${a}`));
    expect($$(".uc-step-edit button[aria-haspopup=menu]").map((b) => b.getAttribute("aria-label"))).toEqual(["Actions for step 1", "Actions for step 2", "Actions for step 3"]);
  });

  it("the live region is cleared before it is set again, so the same text twice is announced twice", async () => {
    await open();
    const down = () => {
      $$(".uc-step-edit")[0].querySelector("button[aria-haspopup=menu]").click();
      $("[role=menuitem][data-value=down]").click();
    };
    const up = () => {
      $$(".uc-step-edit")[1].querySelector("button[aria-haspopup=menu]").click();
      $("[role=menuitem][data-value=up]").click();
    };
    down();
    vi.advanceTimersByTime(600);
    const first = live();
    up();
    expect(live()).toBe(""); // cleared right away, set on a later task
    down();
    expect(live()).toBe("");
    vi.advanceTimersByTime(600);
    expect(live()).toBe(first);
  });

  it("a pointer drag on another handle drops a grabbed row first", async () => {
    await open();
    const first = $$(".uc-step-edit")[0];
    key(first.querySelector(".uc-drag-handle"), " ");
    expect(first.classList.contains("is-grabbed")).toBe(true);
    const other = $$(".uc-step-edit")[2].querySelector(".uc-drag-handle");
    other.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), { pointerId: 1, clientY: 10, button: 0, isPrimary: true }));
    expect(first.classList.contains("is-grabbed")).toBe(false);
    expect($$(".uc-step-edit")[2].classList.contains("is-lifted")).toBe(true);
    document.dispatchEvent(Object.assign(new Event("pointercancel"), { pointerId: 1 }));
  });
});

describe("openMenu align end", () => {
  it("opens 180px wide with its right edge under the anchor, kept inside the dialog; default menus keep the left edge", () => {
    const dialog = document.body.appendChild(document.createElement("dialog"));
    dialog.getBoundingClientRect = () => ({ left: 100, right: 500, top: 0, bottom: 600, width: 400, height: 600 });
    const anchor = dialog.appendChild(document.createElement("button"));
    anchor.getBoundingClientRect = () => ({ left: 440, right: 470, top: 100, bottom: 128, width: 30, height: 28 });
    openMenu({ anchor, label: "A", onPick: () => {}, align: "end", width: 180, items: [{ value: "x", label: "X", command: true }] });
    const menu = $("[role=menu]");
    expect(menu.style.width).toBe("180px");
    expect(menu.style.left).toBe("290px"); // 470 - 180
    closeMenu();
    anchor.getBoundingClientRect = () => ({ left: 490, right: 520, top: 100, bottom: 128, width: 30, height: 28 });
    openMenu({ anchor, label: "A", onPick: () => {}, align: "end", width: 180, items: [{ value: "x", label: "X", command: true }] });
    expect($("[role=menu]").style.left).toBe("312px"); // right edge clamped to the dialog's 500 - 8
    closeMenu();
    openMenu({ anchor, label: "A", onPick: () => {}, items: [{ value: "x", label: "X" }] });
    expect($("[role=menu]").style.width).toBe("");
    expect($("[role=menu]").style.left).toBe("490px");
  });
});

describe("openMenu command items", () => {
  it("renders menuitem commands; a disabled one is aria-disabled, skipped by the arrows and does not pick", () => {
    const anchor = document.body.appendChild(document.createElement("button"));
    const onPick = vi.fn();
    openMenu({ anchor, label: "Actions", onPick, items: [{ value: "a", label: "A", command: true, disabled: true }, { value: "b", label: "B", command: true }, { value: "c", label: "C", command: true }] });
    const items = $$("[role=menuitem]");
    expect(items.map((i) => i.getAttribute("aria-disabled"))).toEqual(["true", null, null]);
    expect(document.activeElement).toBe(items[1]);
    key(document.activeElement, "ArrowUp");
    expect(document.activeElement).toBe(items[2]); // wraps past the disabled first item
    items[0].click();
    expect(onPick).not.toHaveBeenCalled();
    items[2].click();
    expect(onPick).toHaveBeenCalledWith("c");
  });
});
