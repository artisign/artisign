// @vitest-environment jsdom
//
// Reordering the step changes of a variant (CHR-1118): the same handle, keyboard and ⋯ menu as the base steps, the order lands
// in the payload, typed values and focus survive, plus the grab announcement and the errors that wait until a row is left.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openUseCaseDialog } from "./usecases-forms.js";
import { closeMenu } from "./usecases-menu.js";
import { grabbedText } from "./usecases-reorder.js";
import { makePool, rawUseCase } from "./usecases.test-helper.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const button = (label) => $$("dialog .uc-foot-actions button").find((b) => b.textContent === label);
const card = () => $$(".uc-variant-edit")[0]; // "agent": replace pick, remove notify, append time
const ops = () => $$(".uc-step-op", card());
const kinds = () => ops().map((row) => row.dataset.op);
const live = () => $$(".uc-reorder-live")[1].textContent; // [0] belongs to the base steps

async function open(source = rawUseCase) {
  const opts = {
    mode: "edit",
    source,
    pool: () => makePool(),
    screens: () => ["editor", "picker"],
    groups: () => [],
    takenIds: () => new Set(["map-step"]),
    loadNodes: async () => ["btn-map", "row-agent"],
    save: vi.fn(async () => ({ ok: true, data: { warnings: [] } })),
    newObject: vi.fn(async () => {}),
  };
  openUseCaseDialog(opts);
  await vi.advanceTimersByTimeAsync(10);
  return opts;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  closeMenu();
  vi.useRealTimers();
});

describe("variant step changes: reordering", () => {
  it("every change row has a handle, a ⋯ menu and a key hint as its last line, named after the change", async () => {
    await open();
    expect(kinds()).toEqual(["replace", "remove", "append"]);
    for (const row of ops()) {
      expect($(".uc-drag-handle", row)).not.toBeNull();
      expect($("button[aria-haspopup=menu]", row)).not.toBeNull();
      expect(row.lastElementChild.classList.contains("uc-step-keys")).toBe(true);
    }
    expect($$(".uc-drag-handle", card()).map((b) => b.getAttribute("aria-label"))).toEqual(["Reorder change 1, Picks the agent", "Reorder change 2, Remove notify", "Reorder change 3, Sets the time"]);
    expect($$(".uc-step-op button[aria-haspopup=menu]", card()).map((b) => b.getAttribute("aria-label"))).toEqual(["Actions for change 1", "Actions for change 2", "Actions for change 3"]);
  });

  it("the ⋯ menu moves a change; the order lands in the payload; the same node moves and typed values and focus survive", async () => {
    const opts = await open();
    const first = ops()[0];
    const action = $("input[aria-label='Variant 1 change 1 action']", first);
    action.value = "Picks the agent today";
    action.dispatchEvent(new Event("input", { bubbles: true }));
    $("button[aria-haspopup=menu]", first).click();
    $("[role=menuitem][data-value=down]").click();
    expect(kinds()).toEqual(["remove", "replace", "append"]);
    expect(ops()[1]).toBe(first); // moved, not redrawn
    expect($("input[aria-label='Variant 1 change 2 action']", first).value).toBe("Picks the agent today");
    expect($("[data-path='variant.0.op.1.id']", first)).not.toBeNull();
    expect($("button[aria-label='Remove change 2 of variant 1']", first)).not.toBeNull();
    expect(document.activeElement.getAttribute("aria-label")).toBe("Actions for change 2");
    vi.advanceTimersByTime(600);
    expect(live()).toBe("Picks the agent today, moved to change 2 of 3.");
    button("Save use case").click();
    await vi.advanceTimersByTimeAsync(10);
    expect(opts.save.mock.calls[0][0].variants[0].steps.map((op) => op.op)).toEqual(["remove", "replace", "append"]);
  });

  it("keyboard: grab, ArrowDown, drop; Escape restores; the first row cannot move up", async () => {
    await open();
    const handle = (i) => $(".uc-drag-handle", ops()[i]);
    handle(0).focus();
    key(handle(0), " ");
    key(handle(0), "ArrowUp");
    expect(kinds()).toEqual(["replace", "remove", "append"]);
    key(handle(0), "ArrowDown");
    expect(kinds()).toEqual(["remove", "replace", "append"]);
    key(handle(1), "Escape");
    expect(kinds()).toEqual(["replace", "remove", "append"]);
    vi.advanceTimersByTime(600);
    expect(live()).toBe("Move cancelled.");
    key(handle(2), " ");
    key(handle(2), "ArrowUp");
    key(handle(1), " ");
    expect(kinds()).toEqual(["replace", "append", "remove"]);
  });

  it("the step lists follow the new order: a removal's struck line and the flow each step select offers", async () => {
    await open();
    const removeRow = ops()[1];
    const struckBefore = $(".uc-op-struck", removeRow).textContent;
    expect(struckBefore).toContain("Dex gets a push");
    $("button[aria-haspopup=menu]", ops()[0]).click();
    $("[role=menuitem][data-value=down]").click();
    // the removal now comes first and the replace after it: the replace no longer sees the removed step in its flow
    expect(kinds()).toEqual(["remove", "replace", "append"]);
    expect($(".uc-op-struck", ops()[0]).textContent).toContain("Dex gets a push");
    const replaceSelect = $("select[aria-label='Variant 1 change 2 step']", ops()[1]);
    expect([...replaceSelect.options].map((o) => o.value)).not.toContain("notify");
  });
});

describe("grab announcement", () => {
  it("picking a row up announces it, its place and the keys (base steps and step changes)", async () => {
    await open();
    const base = $(".uc-steps-edit .uc-drag-handle");
    base.focus();
    key(base, " ");
    vi.advanceTimersByTime(600);
    expect($$(".uc-reorder-live")[0].textContent).toBe(grabbedText("Taps the step", 0, 3));
    expect(grabbedText("Taps the step", 0, 3)).toBe("Taps the step, grabbed, step 1 of 3. Arrow up and down move it, Space drops it, Escape cancels.");
    key(base, "Escape");
    const change = $(".uc-drag-handle", ops()[0]);
    key(change, " ");
    vi.advanceTimersByTime(600);
    expect(live()).toBe(grabbedText("Picks the agent", 0, 3, "change"));
    expect(live()).toBe("Picks the agent, grabbed, change 1 of 3. Arrow up and down move it, Space drops it, Escape cancels.");
  });
});

describe("a re-grab during the settle animation", () => {
  it("keeps the lifted look when the earlier animation finishes after the new drag started; only that animation is finished", async () => {
    await open();
    const rows = $$(".uc-steps-edit .uc-step-edit");
    const list = $(".uc-steps-edit");
    rows.forEach((row, i) => {
      Object.defineProperty(row, "offsetTop", { configurable: true, get: () => i * 100 });
      Object.defineProperty(row, "offsetHeight", { configurable: true, get: () => 80 });
      row.getBoundingClientRect = () => ({ top: i * 100, bottom: i * 100 + 80, height: 80, left: 0, right: 100, width: 100 });
    });
    // the lifted row is 150px from the top, 50px below its resting place, so the release has a distance to settle over
    rows[0].getBoundingClientRect = () => ({ top: rows[0].style.translate ? 150 : 0, bottom: 80, height: 80, left: 0, right: 100, width: 100 });
    list.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300, left: 0, right: 100, width: 100 });
    Object.defineProperty(list, "offsetHeight", { configurable: true, get: () => 300 });
    let onFinish;
    const settle = { finish: vi.fn(() => onFinish?.()), addEventListener: (type, fn) => { if (type === "finish") onFinish = fn; } };
    const unrelated = { finish: vi.fn() };
    rows[0].animate = () => settle;
    rows[0].getAnimations = () => [unrelated, settle];
    const pointer = (type, y) => document.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, clientY: y }));
    const handle = $(".uc-drag-handle", rows[0]);
    const down = (y) => handle.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), { pointerId: 1, clientY: y, button: 0, isPrimary: true }));
    down(10);
    pointer("pointermove", 190);
    pointer("pointerup", 190); // dropped lower: one move, one settle animation
    expect($$(".uc-steps-edit .uc-step-edit")[2]).toBe(rows[0]);
    expect(rows[0].classList.contains("is-lifted")).toBe(true); // until the animation finishes
    down(10); // grabbed again while the release is still settling
    expect(settle.finish).toHaveBeenCalled();
    expect(unrelated.finish).not.toHaveBeenCalled();
    onFinish(); // the old animation's finish callback arrives late
    expect(rows[0].classList.contains("is-lifted")).toBe(true);
    pointer("pointercancel", 0);
  });
});

describe("review fixes (second round)", () => {
  it("a base step removed or added redraws with its field errors intact", async () => {
    await open();
    const first = () => $$(".uc-steps-edit .uc-step-edit")[0];
    const action = () => $("input[aria-label='Step 1 action']", first());
    action().value = "";
    action().dispatchEvent(new Event("input", { bubbles: true }));
    first().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    expect(action().getAttribute("aria-invalid")).toBe("true");
    $("button[aria-label='Remove step 3']").click(); // redraws every row
    expect(action().getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(action().getAttribute("aria-describedby")).textContent).toBe("The step needs an action.");
  });

  it("focus going into the row's own ⋯ menu is not leaving the row; a real leave still counts", async () => {
    await open();
    $$("button", card()).find((b) => b.textContent === "addStep change").click();
    const kind = $("select[aria-label$='operation']", ops().at(-1));
    kind.value = "append";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    const row = ops().at(-1);
    const action = $("input[aria-label$='action']", row);
    $("button[aria-haspopup=menu]", row).click();
    row.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: $("[role=menuitem]") }));
    expect(row.dataset.touched).toBeUndefined();
    const gone = document.createElement("button");
    row.append(gone);
    const leave = new FocusEvent("focusout", { bubbles: true, relatedTarget: null });
    gone.dispatchEvent(leave); // still connected: a real leave
    expect(row.dataset.touched).toBe("true");
    expect(action.getAttribute("aria-invalid")).toBe("true");
  });

  it("an actor swap with an empty from shows the error state on both selects", async () => {
    await open();
    $$("button", card()).find((b) => b.textContent === "addActor swap").click();
    const [from, to] = $$(".uc-swap-row select", card()).slice(-2);
    to.value = "dex";
    to.dispatchEvent(new Event("change", { bubbles: true }));
    from.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    expect(from.getAttribute("aria-invalid")).toBe("true");
    expect(from.classList.contains("is-error")).toBe(true);
  });

  it("one committed move runs one warning pass", async () => {
    await open();
    const message = $(".uc-foot-msg");
    const observer = new MutationObserver(() => {});
    observer.observe(message, { childList: true, characterData: true, subtree: true });
    $(".uc-steps-edit .uc-step-edit button[aria-haspopup=menu]").click();
    $("[role=menuitem][data-value=down]").click();
    expect(observer.takeRecords()).toHaveLength(1); // the pass sets the footer message once
    observer.disconnect();
  });

  it("a base step moved: the variant's step selects list the new numbering (one warning pass included)", async () => {
    await open();
    const options = () => [...$("select[aria-label='Variant 1 change 1 step']", card()).options].map((o) => o.textContent);
    expect(options()).toContain("1 · Taps the step");
    $(".uc-steps-edit .uc-step-edit button[aria-haspopup=menu]").click();
    $("[role=menuitem][data-value=down]").click();
    expect(options()).toContain("2 · Taps the step");
    expect(options()).toContain("1 · Picks Pablo");
  });

  it("the row's menu closing without the focus coming back to the row counts as leaving it", async () => {
    await open();
    $$("button", card()).find((b) => b.textContent === "addStep change").click();
    const kind = $("select[aria-label$='operation']", ops().at(-1));
    kind.value = "append";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    const row = ops().at(-1);
    const action = $("input[aria-label$='action']", row);
    $("button[aria-haspopup=menu]", row).click();
    const menu = $("[role=menu][aria-label^='Actions for change']");
    row.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: $("[role=menuitem]", menu) }));
    expect(row.dataset.touched).toBeUndefined();
    document.activeElement?.blur();
    menu.remove(); // closed by an outside click that took the focus elsewhere
    await vi.advanceTimersByTimeAsync(10);
    expect(row.dataset.touched).toBe("true");
    expect(action.getAttribute("aria-invalid")).toBe("true");
  });

  it("the row's menu closing with the focus back on the row is not leaving", async () => {
    await open();
    $$("button", card()).find((b) => b.textContent === "addStep change").click();
    const row = ops().at(-1);
    const more = $("button[aria-haspopup=menu]", row);
    more.click();
    row.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: $("[role=menuitem]") }));
    closeMenu(); // the menu returns the focus to its button
    await vi.advanceTimersByTimeAsync(10);
    expect(document.activeElement).toBe(more);
    expect(row.dataset.touched).toBeUndefined();
  });

  it("the move wording names the noun of the list", async () => {
    await open();
    const handle = $(".uc-drag-handle", ops()[0]);
    handle.focus();
    key(handle, " ");
    key(handle, "ArrowDown");
    vi.advanceTimersByTime(600);
    expect(live()).toBe("Picks the agent, moved to change 2 of 3.");
  });
});

describe("errors that wait until the row is left", () => {
  it("a change without an action shows the error on its action field once the row was left; Save stays blocked", async () => {
    await open();
    $$("button", card()).find((b) => b.textContent === "addStep change").click();
    const kind = $("select[aria-label$='operation']", ops().at(-1));
    kind.value = "append"; // a new change starts as a replace without a step: pick a kind that carries its own step
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    const row = ops().at(-1);
    const action = $("input[aria-label$='action']", row);
    expect(action).not.toBeNull();
    expect(button("Save use case").disabled).toBe(true);
    expect(action.getAttribute("aria-invalid")).toBe("false");
    row.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    expect(action.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(action.getAttribute("aria-describedby")).textContent).toBe("The step needs an action.");
    action.value = "Does something";
    action.dispatchEvent(new Event("input", { bubbles: true }));
    expect(action.getAttribute("aria-invalid")).toBe("false");
  });

  it("a base step without an action gets the same field error after the row was left", async () => {
    await open();
    const row = $$(".uc-steps-edit .uc-step-edit")[0];
    const action = $("input[aria-label='Step 1 action']", row);
    action.value = "";
    action.dispatchEvent(new Event("input", { bubbles: true }));
    expect(action.getAttribute("aria-invalid")).toBe("false");
    row.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    expect(action.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(action.getAttribute("aria-describedby")).textContent).toBe("The step needs an action.");
    expect(button("Save use case").disabled).toBe(true);
  });
});
