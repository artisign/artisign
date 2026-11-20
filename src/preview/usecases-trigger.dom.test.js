// @vitest-environment jsdom
//
// CHR-1143: get_use_case always returns the trigger as an object, a stored case may still hold a string or an object.
// The preview shows the text, compares by what the trigger says, and its edit forms change the text only (until CHR-1154).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderDetail } from "./usecases-detail.js";
import { draftFromSource, buildPayload } from "./usecases-forms.js";
import { variantDraft, buildVariant } from "./usecases-variant-edit.js";
import { makePool, baseBundle, variantBundle, rawUseCase } from "./usecases.test-helper.js";

const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function render(over = {}) {
  const root = document.createElement("div");
  const handlers = { onVariant: vi.fn(), onEdit: vi.fn(), onMap: vi.fn(), onCopyId: vi.fn(), onCopy: vi.fn(), onAddVariant: vi.fn(), onToggleCoverage: vi.fn(), onDelete: vi.fn() };
  renderDetail(root, { bundle: baseBundle, base: baseBundle, source: rawUseCase, variantId: null, pool: makePool(), coverageOpen: false, handlers, ...over });
  document.body.replaceChildren(root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("detail view", () => {
  const withTrigger = (bundle, trigger) => ({ ...bundle, use_case: { ...bundle.use_case, trigger } });

  it("shows the text of an object trigger, never [object Object]", () => {
    const bundle = withTrigger(baseBundle, { text: "The insurer raises the premium", actor: "dana", via: "partner API" });
    const root = render({ bundle, base: bundle });
    expect($$(".uc-trigger-text")[0].textContent).toBe("The insurer raises the premium");
    expect(root.textContent).not.toContain("[object Object]");
  });

  it("still shows a string trigger, and a dash without one", () => {
    render();
    expect($$(".uc-trigger-text")[0].textContent).toBe("Step has no target");
    const { trigger, ...rest } = baseBundle.use_case;
    expect(trigger).toBeDefined();
    const bare = { ...baseBundle, use_case: rest };
    render({ bundle: bare, base: bare });
    expect($$(".uc-trigger-text")[0].textContent).toBe("—");
  });

  it("the changed badge compares what the trigger says, not its shape", () => {
    const base = withTrigger(baseBundle, { text: "Step has no target" });
    const same = withTrigger(variantBundle, { text: "Step has no target" });
    render({ bundle: same, base, source: { ...rawUseCase, variants: [{ ...rawUseCase.variants[0], trigger: "Step has no target" }] }, variantId: "agent" });
    expect($$(".uc-trigger")[0].textContent).not.toContain("Changed");

    const other = withTrigger(variantBundle, { text: "Agent starts", actor: "dex" });
    render({ bundle: other, base, source: { ...rawUseCase, variants: [{ ...rawUseCase.variants[0], trigger: { text: "Agent starts", actor: "dex" } }] }, variantId: "agent" });
    expect($$(".uc-trigger")[0].textContent).toContain("Changed");
  });
});

describe("case edit form", () => {
  const structured = { text: "The insurer raises the premium", actor: "dana", via: "partner API" };
  const source = { ...rawUseCase, trigger: structured };
  const payloadOf = (draft, src) => buildPayload({ id: "map-step", draft, source: src }).payload;

  it("puts the text of an object trigger into the field", () => {
    expect(draftFromSource(source).trigger).toBe("The insurer raises the premium");
    expect(draftFromSource(rawUseCase).trigger).toBe("Step has no target");
  });

  it("saves an untouched object trigger as stored and an untouched string as a string", () => {
    expect(payloadOf(draftFromSource(source), source).trigger).toEqual(structured);
    expect(payloadOf(draftFromSource(rawUseCase), rawUseCase).trigger).toBe("Step has no target");
  });

  it("edits the text only and keeps actor, via, state and at", () => {
    const full = { text: "Overdue", state: [{ subject: "copy", property: "status", value: "overdue" }], at: "2026-12-01" };
    const stored = { ...rawUseCase, trigger: full };
    const draft = draftFromSource(stored);
    draft.trigger = "  The loan is overdue ";
    expect(payloadOf(draft, stored).trigger).toEqual({ ...full, text: "The loan is overdue" });
    draft.trigger = "";
    expect(payloadOf(draft, stored).trigger).toEqual({ ...full, text: "" });
  });

  it("edits and clears a string trigger as before", () => {
    const draft = draftFromSource(rawUseCase);
    draft.trigger = " New text ";
    expect(payloadOf(draft, rawUseCase).trigger).toBe("New text");
    draft.trigger = "";
    expect(payloadOf(draft, rawUseCase).trigger).toBeNull();
  });
});

describe("variant trigger override", () => {
  const trigger = { text: "The insurer calls", actor: "dana", via: "email" };
  const stored = { id: "t", title: "T", when: { size: ["small"] }, trigger };
  const baseSteps = draftFromSource(rawUseCase).steps;
  const build = (variant) => buildVariant(variant, 0, { baseSteps, usedStepIds: new Set(baseSteps.map((s) => s.id)), variantIds: new Set() });

  it("shows the text and writes an untouched override back as stored", () => {
    const draft = variantDraft(stored);
    expect(draft.overrides.trigger).toBe("The insurer calls");
    const { out, errors } = build(draft);
    expect(errors).toEqual([]);
    expect(out.trigger).toEqual(trigger);
  });

  it("edits the text only, keeping actor and via; clearing the text keeps the structure (N5), a text-only override stays an error", () => {
    const draft = variantDraft(stored);
    draft.overrides.trigger = "  The insurer writes ";
    expect(build(draft).out.trigger).toEqual({ ...trigger, text: "The insurer writes" });
    draft.overrides.trigger = " ";
    // The override still says who acts and how: the empty text is not an empty override.
    expect(build(draft).errors).toEqual([]);
    expect(build(draft).out.trigger).toEqual({ ...trigger, text: "" });
    // Switching to the text form is the explicit way to drop the structure; then an empty text is an empty override.
    draft.triggerShape.kind = "text";
    expect(build(draft).errors).toEqual(['Variant "T": the trigger override is empty.']);
  });

  it("keeps a string override a string", () => {
    const draft = variantDraft({ ...stored, trigger: "plain" });
    draft.overrides.trigger = "changed";
    expect(build(draft).out.trigger).toBe("changed");
  });
});
