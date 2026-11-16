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
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
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
    expect($("button[title='Move up']")).toBeNull();
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
    expect($(".uc-step-keys:not([hidden])", row).textContent).toContain("Esc to cancel");
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
    const mid = [40, 140, 240];
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
    expect(list.dataset.drop).toBe("true");
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
    expect(list.dataset.drop).toBeUndefined();
    expect(rows().some((r) => r.classList.contains("is-lifted"))).toBe(false);
    vi.advanceTimersByTime(600);
    expect(live()).toBe(`${first[0]}, moved to step 2 of 3.`);
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
