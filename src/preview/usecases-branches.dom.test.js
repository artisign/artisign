// @vitest-environment jsdom
//
// Branch changes of a variant in the use-case dialog (ADR-011): listed read-only, movable and removable, saved as stored.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openUseCaseDialog } from "./usecases-forms.js";
import { makePool, rawUseCase } from "./usecases.test-helper.js";

const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
const button = (label) => $$("dialog .uc-foot-actions button").find((b) => b.textContent === label);

const addOp = { op: "add_branch", branch: { id: "hold", title: "Hold", when: [{ subject: "dana", property: "holds", value: 1 }], steps: [{ id: "show-hold", actor: "system", action: "Shows the hold" }] } };
const dropOp = { op: "remove_branch", branch_id: "offline" };
const source = {
  ...rawUseCase,
  branches: [{ id: "offline", title: "Offline", when: [{ subject: "system", property: "connectivity", value: "offline" }], steps: [{ id: "show-offline", actor: "system", action: "Shows the saved state" }] }],
  variants: rawUseCase.variants.map((v, i) => (i === 1 ? { ...v, steps: [...(v.steps ?? []), addOp, dropOp] } : v)),
};

async function open() {
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

const branchRows = () => $$(".uc-variant-edit")[1].querySelectorAll(".uc-step-op[data-op$='_branch']");

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("branch changes in the variant editor", () => {
  it("lists a stored branch op read-only and saves it unchanged next to an edited title", async () => {
    const { opts, closed } = await open();
    const rows = [...branchRows()];
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Add branch Hold (1 step)"), expect.stringContaining("Remove branch offline")]);
    expect($$("select, textarea, input", rows[0])).toHaveLength(0); // nothing to type into
    type(document.querySelector('input[aria-label="Variant 2 title"]'), "Renamed");
    button("Save use case").click();
    await closed;
    const sent = opts.save.mock.calls[0][0];
    expect(sent).not.toHaveProperty("branches");
    expect(sent.variants[1].title).toBe("Renamed");
    expect(sent.variants[1].steps.slice(-2)).toEqual([addOp, dropOp]);
  });

  it("the remove button of a branch change row drops exactly that op", async () => {
    const { opts, closed } = await open();
    const rowOfAdd = [...branchRows()].find((r) => r.dataset.op === "add_branch");
    $$("button", rowOfAdd).find((b) => b.getAttribute("aria-label")?.startsWith("Remove change")).click();
    button("Save use case").click();
    await closed;
    expect(opts.save.mock.calls[0][0].variants[1].steps.slice(-1)).toEqual([dropOp]);
  });
});
