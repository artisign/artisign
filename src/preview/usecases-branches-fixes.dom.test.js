// @vitest-environment jsdom
//
// Branch steps and the variant editor (ADR-011, review fixes): ops on a branch step are neither "unknown" nor skipped, a step may not
// reuse a branch step's id, and turning an append that stored a `branch` into another kind drops that key.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openUseCaseDialog } from "./usecases-forms.js";
import { makePool, rawUseCase } from "./usecases.test-helper.js";

const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const button = (label) => $$("dialog .uc-foot-actions button").find((b) => b.textContent === label);
const change = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
};

const variantsWith = (steps) => rawUseCase.variants.map((v, i) => (i === 1 ? { ...v, steps } : v));
const withBranch = (steps) => ({
  ...rawUseCase,
  branches: [{ id: "offline", title: "Offline", when: [{ subject: "system", property: "connectivity", value: "offline" }], steps: [{ id: "show-offline", actor: "system", action: "Shows the saved state" }] }],
  variants: variantsWith(steps),
});

async function openWith(source) {
  const opts = {
    mode: "edit",
    source,
    pool: () => makePool(),
    screens: () => ["editor", "picker"],
    groups: () => [],
    takenIds: () => new Set(),
    loadNodes: async () => [],
    save: vi.fn(async () => ({ ok: true, data: { warnings: [] } })),
    newObject: vi.fn(async () => {}),
  };
  const closed = openUseCaseDialog(opts);
  await flush();
  return { opts, closed };
}
const card = () => $$(".uc-variant-edit")[1];

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("variant editor and branch steps", () => {
  it("an op on a branch step lists it as a branch step: no 'unknown' option and no skipped warning", async () => {
    await openWith(withBranch([{ op: "replace", step_id: "show-offline", step: { id: "show-offline", actor: "system", action: "Changed" } }]));
    const select = card().querySelector("select[data-role=step]");
    expect(select.textContent).toContain("show-offline (branch step)");
    expect(select.textContent).not.toContain("unknown");
    expect(card().textContent).not.toContain("is not a step of the flow");
  });

  it("changing an append that stored a branch into another kind drops `branch`, so the save is valid", async () => {
    const { opts, closed } = await openWith(withBranch([{ op: "append", step: { id: "late", actor: "system", action: "Late" }, branch: "offline" }]));
    const row = card().querySelector(".uc-step-op");
    expect(row.dataset.op).toBe("append");
    change(row.querySelector("select"), "insert_after");
    await flush();
    change(card().querySelector("select[data-role=step]"), "tap");
    await flush();
    button("Save use case").click();
    await closed;
    const op = opts.save.mock.calls[0][0].variants[1].steps[0];
    expect(op).toMatchObject({ op: "insert_after", step_id: "tap" });
    expect(op).not.toHaveProperty("branch");
  });

  it("a step may not reuse the id of a branch step: the save is blocked", async () => {
    const { opts } = await openWith(withBranch([{ op: "append", step: { id: "show-offline", actor: "system", action: "Duplicate" } }]));
    button("Save use case").click();
    await flush();
    expect(opts.save).not.toHaveBeenCalled();
  });
});
