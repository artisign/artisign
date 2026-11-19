// @vitest-environment jsdom
//
// The detail view with steps taken out of a branch (ADR-011): they are not main-flow rows.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderDetail } from "./usecases-detail.js";
import { makePool, baseBundle, variantBundle, rawUseCase } from "./usecases.test-helper.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function render(over = {}) {
  const root = document.createElement("div");
  const handlers = { onVariant: vi.fn(), onEdit: vi.fn(), onMap: vi.fn(), onCopyId: vi.fn(), onCopy: vi.fn(), onAddVariant: vi.fn(), onToggleCoverage: vi.fn(), onDelete: vi.fn() };
  renderDetail(root, { bundle: baseBundle, base: baseBundle, source: rawUseCase, variantId: null, pool: makePool(), coverageOpen: false, handlers, ...over });
  document.body.replaceChildren(root);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("branch removals", () => {
  it("a step taken out of a branch is no ghost row in the main flow and is not counted as removed", () => {
    const fromBranch = { id: "show-limit", actor: "system", action: "Explains the limit", change: "removed", after: null, branch: "limit-reached" };
    const bundle = { ...variantBundle, removed_steps: [...variantBundle.removed_steps, fromBranch] };
    render({ bundle, variantId: "agent" });
    expect($$(".uc-step.is-removed")).toHaveLength(1); // only the main-flow one
    expect($$(".uc-step").map((s) => s.textContent).join(" ")).not.toContain("Explains the limit");
    expect($(".uc-h2-meta").textContent).toContain("1 removed");
  });
});
