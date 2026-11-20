// @vitest-environment jsdom
//
// The world parts of the use-case dialog (ADR-011, CHR-1154): the trigger in its three forms, constellations, starting state,
// the branch list with its own dialog, and the same parts in a variant (overrides, state merge with unset, branch changes).
// Save is blocked only by shape errors; everything else is a warning.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openUseCaseDialog } from "./usecases-forms.js";
import { baseCase, constellations, entities, relationshipTypes, makeWorldPool, rawVariant } from "./usecases-world.test-helper.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
const pick = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
const top = () => $$("dialog[open]").at(-1);
const caseDialog = () => $$("dialog[open]")[0];
const footButton = (label, dialog = top()) => $$(".uc-foot-actions button", dialog).find((b) => b.textContent === label);
const world = { entities, relationship_types: relationshipTypes, constellations };
const pool = () => ({ ...makeWorldPool(), world });
const stored = { ...baseCase, constellations: ["two-parents", "single-parent"], state: baseCase.state.filter((s) => s.subject !== "grandma"), variants: [rawVariant] };

async function open(source = stored) {
  const save = vi.fn(async () => ({ ok: true, data: { warnings: [] } }));
  const closed = openUseCaseDialog({ mode: "edit", source, pool, screens: () => ["notice", "options"], groups: () => [], takenIds: () => new Set(), loadNodes: async () => [], save, newObject: vi.fn(async () => {}) });
  await flush();
  return { save, closed };
}
const savePayload = async (save, closed) => {
  footButton("Save use case", caseDialog()).click();
  await closed;
  return save.mock.calls[0][0];
};
const trigger = () => $(".uc-trigger-edit", caseDialog());
const triggerMode = (label) => $$(".uc-segmented button", trigger()).find((b) => b.textContent === label);
const variantCard = () => $(".uc-variant-edit", caseDialog());
const rowOf = (key) => $(`.uc-override-row[data-key=${key}]`, variantCard());

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("trigger editor", () => {
  it("opens in the form the stored trigger has; an untouched save sends it as stored", async () => {
    const { save, closed } = await open();
    expect($(".uc-segmented [aria-checked=true]", trigger()).textContent).toBe("Action");
    expect($("select[aria-label='Trigger actor']", trigger()).value).toBe("insurer");
    expect($("input[aria-label='Trigger via']", trigger()).value).toBe("webhook");
    expect((await savePayload(save, closed)).trigger).toEqual(baseCase.trigger);
  });

  it("the actor is a persona: the system and entities are not offered", async () => {
    await open();
    expect([...$("select[aria-label='Trigger actor']", trigger()).options].map((o) => o.textContent)).toEqual(["Actor…", "Maria", "Jon", "Insurer North"]);
  });

  it("switching the form keeps what was typed; clearing the text of a structured trigger keeps the structure (N5)", async () => {
    const { save, closed } = await open();
    type($("input[aria-label='Trigger what happens']", trigger()), "");
    const payload = await savePayload(save, closed);
    expect(payload.trigger).toEqual({ text: "", actor: "insurer", via: "webhook" });
  });

  it("the Text form drops the structure: the trigger becomes the sentence, or is removed when it is empty", async () => {
    const { save, closed } = await open();
    triggerMode("Text").click();
    await flush();
    const area = $("textarea[aria-label='Trigger text']", trigger());
    expect(area.value).toBe("sends the renewal notice");
    type(area, "Insurer North writes");
    expect((await savePayload(save, closed)).trigger).toBe("Insurer North writes");
    document.body.innerHTML = "";
    const second = await open();
    triggerMode("Text").click();
    await flush();
    type($("textarea[aria-label='Trigger text']", trigger()), "  ");
    expect((await savePayload(second.save, second.closed)).trigger).toBeNull();
  });

  it("via without an actor is a shape error with the design's note; the footer names it and Save is blocked", async () => {
    await open();
    pick($("select[aria-label='Trigger actor']", trigger()), "");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(true);
    expect($(".uc-foot-msg", caseDialog()).textContent).toBe("Trigger: via names the channel and needs an actor.");
    expect($(".uc-field-error:not([hidden])", trigger()).textContent).toBe("Via names the channel and needs an actor.");
    expect($("input[aria-label='Trigger via']", trigger()).getAttribute("aria-invalid")).toBe("true");
    type($("input[aria-label='Trigger via']", trigger()), "");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(false);
  });

  it("State or time: no actor field; conditions with the operator words; a malformed `at` blocks Save", async () => {
    const { save, closed } = await open();
    triggerMode("State or time").click();
    await flush();
    expect($("select[aria-label='Trigger actor']", trigger())).toBeNull();
    $$("button", trigger()).find((b) => b.textContent.endsWith("Add condition")).click();
    await flush();
    const row = $(".uc-cond-row", trigger());
    pick($("select[aria-label='Condition 1 subject']", row), "policy");
    type($("input[aria-label='Condition 1 property']", row), "status");
    expect([...$("select[aria-label='Condition 1 operator']", row).options].map((o) => o.textContent)).toEqual(["is", "is not", "less than", "at most", "greater than", "at least", "is one of"]);
    pick($("select[aria-label='Condition 1 operator']", row), "lt");
    type($("input[aria-label='Condition 1 value']", row), "18");
    type($("input[aria-label='Trigger at']", trigger()), "tomorrow");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(true);
    expect($(".uc-field-error:not([hidden])", trigger()).textContent).toBe("Use a date (2027-01-01) or a date and time (2027-01-01T09:00).");
    type($("input[aria-label='Trigger at']", trigger()), "2027-01-01");
    expect($(".uc-trig-preview", trigger()).textContent).toContain("from");
    expect((await savePayload(save, closed)).trigger).toEqual({ text: "sends the renewal notice", state: [{ subject: "policy", property: "status", op: "lt", value: 18 }], at: "2027-01-01" });
  });

  it("'is one of' without a list is an error under the value", async () => {
    await open();
    triggerMode("State or time").click();
    await flush();
    $$("button", trigger()).find((b) => b.textContent.endsWith("Add condition")).click();
    await flush();
    const row = $(".uc-cond-row", trigger());
    pick($("select[aria-label='Condition 1 subject']", row), "policy");
    type($("input[aria-label='Condition 1 property']", row), "status");
    pick($("select[aria-label='Condition 1 operator']", row), "in");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(true);
    row.dataset.touched = "true";
    type($("input[aria-label='Condition 1 value']", row), "");
    expect($(".uc-field-error:not([hidden])", row).textContent).toBe("Add at least one value, separated by commas.");
    type($("input[aria-label='Condition 1 value']", row), "active, 3");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(false);
  });
});

describe("constellations", () => {
  const worldPicker = () => $(".uc-cst-picker", caseDialog()); // the case's own; the variant has its own picker inside its override row

  it("lists the case's constellations, shows an unknown one as a warning and never blocks", async () => {
    const { save, closed } = await open({ ...stored, constellations: ["two-parents", "three-generations"] });
    expect($$(".uc-cst-chip", worldPicker()).map((c) => c.textContent.replace(/\s+/g, " ").trim())).toEqual(["hubTwo parents, one childclose", "warningthree-generationsclose"]);
    expect($(".uc-cst-chip.is-unknown", worldPicker())).toBeTruthy();
    expect($(".uc-field-warn[data-path='constellation.three-generations']:not([hidden])", caseDialog()).textContent).toBe("three-generations is not in the world pool. Create it in World or remove it here.");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(false);
    expect($(".uc-foot-msg", caseDialog()).dataset.tone).toBe("warning");
    const payload = await savePayload(save, closed);
    expect(payload).not.toHaveProperty("constellations"); // untouched: the merge leaves them
  });

  it("add from the pool, remove, and the list is sent whole; emptied it is removed", async () => {
    const { save, closed } = await open({ ...stored, constellations: ["two-parents"] });
    $$("button", worldPicker()).find((b) => b.textContent.endsWith("Add constellation")).click();
    await flush();
    expect($$(".uc-menu .uc-menu-item").map((i) => i.querySelector(".uc-menu-label").textContent)).toEqual(["Single parent, one child"]);
    $(".uc-menu .uc-menu-item").click();
    await flush();
    expect($$(".uc-cst-chip", worldPicker())).toHaveLength(2);
    $("button[aria-label='Remove Two parents, one child']", worldPicker()).click();
    expect((await savePayload(save, closed)).constellations).toEqual(["single-parent"]);
    document.body.innerHTML = "";
    const second = await open({ ...stored, constellations: ["two-parents"] });
    $("button[aria-label='Remove Two parents, one child']", worldPicker()).click();
    expect((await savePayload(second.save, second.closed)).constellations).toBeNull();
  });
});

describe("starting state", () => {
  const stateSection = () => $(".uc-state-rows:not(.is-variant)", caseDialog());

  it("rows are subject, property, value; the value text is read as true/false, a number or text", async () => {
    const { save, closed } = await open();
    expect($$(".uc-state-row", stateSection())).toHaveLength(3);
    $$("button", stateSection()).find((b) => b.textContent.endsWith("Add state")).click();
    await flush();
    const row = $$(".uc-state-row", stateSection()).at(-1);
    pick($("select[aria-label='State row 4 subject']", row), "jon");
    type($("input[aria-label='State row 4 property']", row), "consent-required");
    type($("input[aria-label='State row 4 value']", row), "true");
    const payload = await savePayload(save, closed);
    expect(payload.state.at(-1)).toEqual({ subject: "jon", property: "consent-required", value: true });
    expect(payload.state.slice(0, 3)).toEqual(stored.state);
  });

  it("a second row with the same subject and property is an error on its Property field, in the design's words", async () => {
    await open();
    $$("button", stateSection()).find((b) => b.textContent.endsWith("Add state")).click();
    await flush();
    const row = $$(".uc-state-row", stateSection()).at(-1);
    pick($("select[aria-label='State row 4 subject']", row), "leo");
    type($("input[aria-label='State row 4 property']", row), "age");
    type($("input[aria-label='State row 4 value']", row), "18");
    const property = $("input[aria-label='State row 4 property']", row);
    expect(property.getAttribute("aria-invalid")).toBe("true");
    expect($(".uc-field-error:not([hidden])", row).textContent).toBe("Leo · age is already set above. Change that row instead.");
    expect($(".uc-foot-msg", caseDialog()).textContent).toBe("Starting state 4: Leo · age is already set above. Change that row instead.");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(true);
    type(property, "birthday");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(false);
  });

  it("a subject that is no participant stays selectable under its own id and is a warning", async () => {
    const { save, closed } = await open({ ...stored, state: [...stored.state, { subject: "grandma", property: "lives-in-household", value: true }] });
    expect($("select[aria-label='State row 4 subject']", caseDialog()).selectedOptions[0].textContent).toBe("grandma");
    expect($(".uc-field-warn[data-path='state.3.subject']:not([hidden])", caseDialog()).textContent).toBe("grandma is neither a persona nor an entity. Add it to the world or pick another subject.");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(false);
    expect(await savePayload(save, closed)).not.toHaveProperty("state");
  });
});

describe("branches", () => {
  const rows = () => $$(".uc-branch-row", caseDialog());

  it("lists the branches with number, fork, conditions, steps and where they go on", async () => {
    await open();
    expect(rows().map((r) => r.querySelector(".uc-frame-no").textContent)).toEqual(["A", "2A", "2B"]);
    expect($$(".uc-form-note", rows()[1]).at(-1).textContent).toBe("after step 2 · 1 condition · 2 steps · continues at step 3");
    expect($$(".uc-form-note", rows()[2]).at(-1).textContent).toBe("after step 2 · 2 conditions · 1 step · ends the case");
    expect($$(".uc-form-note", rows()[0]).at(-1).textContent).toBe("before the first step · 1 condition · 1 step · continues at step 2");
  });

  it("Edit opens the branch dialog over the case dialog; Apply changes the draft and the save sends the whole list", async () => {
    const { save, closed } = await open();
    $("button[aria-label='Edit branch 2A']", caseDialog()).click();
    await flush();
    expect($$("dialog[open]")).toHaveLength(2);
    expect($("h1", top()).textContent).toBe("Edit branch 2A");
    expect($(".uc-dialog-context", top()).textContent).toBe("in Review a premium increase");
    type($("input[autofocus]", top()), "Premium rises by more than 10 %");
    footButton("Apply branch").click();
    await flush();
    expect($$("dialog[open]")).toHaveLength(1);
    expect(rows()[1].textContent).toContain("Premium rises by more than 10 %");
    const payload = await savePayload(save, closed);
    expect(payload.branches.map((b) => b.title)).toEqual(["Device is offline", "Premium rises by more than 10 %", "Leo turns 18"]);
    expect(payload.branches[0]).toEqual(baseCase.branches[0]);
    expect(payload.branches[2]).toEqual(baseCase.branches[2]);
  });

  it("Cancel leaves the draft alone; the case dialog still sends no branches when nothing changed", async () => {
    const { save, closed } = await open();
    $("button[aria-label='Edit branch 2A']", caseDialog()).click();
    await flush();
    type($("input[autofocus]", top()), "Something else");
    footButton("Cancel").click();
    await flush();
    expect($(".uc-foot-msg", top()).textContent).toBe("You have unsaved changes. Discard them?");
    $("[data-action=discard]", top()).click();
    await flush();
    expect($$("dialog[open]")).toHaveLength(1);
    expect(await savePayload(save, closed)).not.toHaveProperty("branches");
  });

  it("the branch dialog blocks Apply for a branch without a condition and for a step id of the main flow, in the design's words", async () => {
    await open();
    $("button[aria-label='Edit branch 2A']", caseDialog()).click();
    await flush();
    $("button[aria-label='Remove condition 1']", top()).click();
    await flush();
    expect(footButton("Apply branch").disabled).toBe(true);
    expect($(".uc-field-error[data-path='branch.when']:not([hidden])", top()).textContent).toBe("Add at least one condition. A branch without one cannot be saved.");
    const second = $(".uc-branch-step:nth-of-type(2)", top());
    second.dataset.touched = "true";
    type($("input[aria-label='Step 2 id']", top()), "accept");
    expect($(".uc-field-error[data-path='branch.step.1.id']:not([hidden])", top()).textContent).toBe("accept is already step 3 of the main flow. Give this step another id.");
    expect($(".uc-foot-msg", top()).textContent).toBe("2 errors. Add at least one condition. A branch without one cannot be saved.");
    expect($("input[aria-label='Step 2 id']", top()).getAttribute("aria-invalid")).toBe("true");
  });

  it("Add branch: forks after the last step, conditions and steps are rows, a new branch ends the case or continues", async () => {
    const { save, closed } = await open();
    $$("button", caseDialog()).find((b) => b.textContent.endsWith("Add branch")).click();
    await flush();
    expect($("h1", top()).textContent).toBe("New branch");
    expect(footButton("Apply branch").disabled).toBe(true);
    expect($(".uc-foot-msg", top()).textContent).toBe(""); // nothing typed yet: no errors shouted
    type($("input[autofocus]", top()), "Payment fails");
    pick($("select[aria-label='Condition 1 subject']", top()), "system");
    type($("input[aria-label='Condition 1 property']", top()), "payment");
    type($("input[aria-label='Condition 1 value']", top()), "failed");
    type($("input[aria-label='Step 1 action']", top()), "Shows the failure");
    pick($("select[aria-label='Step 1 actor']", top()), "system");
    type($("input[aria-label='Step 1 via']", top()), "banner");
    expect($(".uc-frame-no", top()).textContent).toBe("3A.1"); // forks after the last step (3)
    $(".uc-end-row input[value=continue]", top()).click();
    await flush();
    expect($("select[aria-label='Continue at']", top()).disabled).toBe(false);
    footButton("Apply branch").click();
    await flush();
    expect(rows()).toHaveLength(4);
    const payload = await savePayload(save, closed);
    expect(payload.branches.at(-1)).toEqual({ id: "payment-fails", title: "Payment fails", from: "accept", when: [{ subject: "system", property: "payment", value: "failed" }], steps: [{ id: "shows-the-failure", actor: "system", action: "Shows the failure", via: "banner" }], rejoin: "open" });
  });

  it("Remove branch (in the branch dialog or with the row's X) takes it out of the list; nothing else changes", async () => {
    const { save, closed } = await open();
    $("button[aria-label='Remove branch 2B']", caseDialog()).click();
    await flush();
    $("button[aria-label='Edit branch 2A']", caseDialog()).click();
    await flush();
    footButton("Remove branch").click();
    await flush();
    expect(rows().map((r) => r.querySelector(".uc-frame-no").textContent)).toEqual(["A"]);
    expect((await savePayload(save, closed)).branches.map((b) => b.id)).toEqual(["offline"]);
  });

  it("a branch that forks after a main step the case no longer has is a warning, never a block", async () => {
    const { save, closed } = await open();
    $("button[aria-label='Remove step 2']", caseDialog()).click(); // compare: branches 2A and 2B fork after it
    await flush();
    expect($$(".uc-field-warn[data-path^='branch.']:not([hidden])", caseDialog()).map((w) => w.textContent).join(" ")).toContain("it forks after compare, which is not a main-flow step");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(false);
    await savePayload(save, closed);
  });
});

describe("a step's via", () => {
  it("is a field of every base step, written when set, removed (not written) when empty", async () => {
    const { save, closed } = await open();
    const via = $$("input[aria-label$=' via']", caseDialog()).filter((i) => /^Step \d via$/.test(i.getAttribute("aria-label")));
    expect(via.map((i) => i.value)).toEqual(["", "", "app"]);
    type(via[0], " scanner ");
    type(via[2], "");
    const payload = await savePayload(save, closed);
    expect(payload.steps[0].via).toBe("scanner");
    expect(payload.steps[2]).not.toHaveProperty("via");
  });
});

describe("the variant: overrides, state merge and branch changes", () => {
  it("constellations: inherited with Override, an own list with Add and Use base; an empty own list stays", async () => {
    const { save, closed } = await open();
    expect(rowOf("constellations").dataset.state).toBe("override");
    expect($(".uc-cst-chip", rowOf("constellations")).textContent).toContain("Single parent, one child");
    $("button[aria-label='Use base constellations']", rowOf("constellations")).click();
    await flush();
    expect(rowOf("constellations").dataset.state).toBe("base");
    expect($(".uc-inherited-value", rowOf("constellations")).textContent).toBe("Two parents, one child, Single parent, one child");
    $("button[aria-label='Override constellations']", rowOf("constellations")).click();
    await flush();
    expect($$(".uc-cst-chip", rowOf("constellations"))).toHaveLength(2); // the base list is copied in, then edited
    $("button[aria-label='Remove Two parents, one child from variant 1']", rowOf("constellations")).click();
    $("button[aria-label='Remove Single parent, one child from variant 1']", rowOf("constellations")).click();
    const payload = await savePayload(save, closed);
    expect(payload.variants[0].constellations).toEqual([]);
  });

  it("the trigger override replaces the trigger whole: base copied in, then edited; Use base removes it", async () => {
    const { save, closed } = await open({ ...stored, variants: [{ ...rawVariant, trigger: undefined }] });
    expect(rowOf("trigger").dataset.state).toBe("base");
    expect($(".uc-inherited-value", rowOf("trigger")).textContent).toBe("Insurer North · sends the renewal notice · via webhook");
    $("button[aria-label='Override trigger']", rowOf("trigger")).click();
    await flush();
    const editor = $(".uc-trigger-edit", rowOf("trigger"));
    expect($("select[aria-label='Variant 1 trigger actor']", editor).value).toBe("insurer");
    type($("input[aria-label='Variant 1 trigger via']", editor), "letter");
    const payload = await savePayload(save, closed);
    expect(payload.variants[0].trigger).toEqual({ text: "sends the renewal notice", actor: "insurer", via: "letter" });
  });

  it("an empty text-only trigger override is an error; a structured one with its text cleared keeps the structure", async () => {
    await open();
    $("button[aria-label='Use base trigger']", rowOf("trigger")).click();
    await flush();
    $("button[aria-label='Override trigger']", rowOf("trigger")).click();
    await flush();
    $$(".uc-segmented button", rowOf("trigger")).find((b) => b.textContent === "Text").click();
    await flush();
    type($("textarea", rowOf("trigger")), "");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(true);
    expect($(".uc-foot-msg", caseDialog()).textContent).toBe('Variant "Single parent": the trigger override is empty.');
    $$(".uc-segmented button", rowOf("trigger")).find((b) => b.textContent === "Action").click();
    await flush();
    expect(footButton("Save use case", caseDialog()).disabled).toBe(false);
  });

  it("starting state of the variant: changed and added rows against the base, an Unset switch, the rest collapsed into 'From base'", async () => {
    const { save, closed } = await open();
    const section = $(".uc-state-rows.is-variant", variantCard());
    const kinds = $$(".uc-state-row", section).map((r) => r.dataset.kind);
    expect(kinds).toEqual(["changed", "added", "unset"]);
    expect($(".uc-state-row[data-kind=changed] .uc-state-note", section).textContent).toContain("base 120");
    expect($(".uc-state-row[data-kind=unset] .uc-unset", section).textContent).toBe("Unset in this variant");
    expect($(".uc-inherited-value", section).textContent).toContain("System connectivity online");
    expect($(".uc-inherited-value", section).textContent).not.toContain("Household liability policy premium"); // the changed row is not "from base"
    // unticking Unset brings the base value back into the row; resetting a changed row removes it
    $(".uc-unset input", section).click();
    await flush();
    expect($$(".uc-state-row", section).map((r) => r.dataset.kind)).toEqual(["changed", "added", "changed"]);
    const payload = await savePayload(save, closed);
    expect(payload.variants[0].state).toEqual([{ subject: "policy", property: "premium", value: 98 }, { subject: "maria", property: "discount", value: "single" }, { subject: "leo", property: "age", value: 17 }]);
  });

  it("Override on the 'From base' line adds a row for that entry; a row repeating a key of the variant is an error", async () => {
    await open();
    const section = () => $(".uc-state-rows.is-variant", variantCard());
    $(".uc-inherited button", section()).click();
    await flush();
    $$(".uc-menu .uc-menu-item").find((i) => i.textContent.includes("connectivity")).click();
    await flush();
    expect($$(".uc-state-row", section())).toHaveLength(4);
    expect($$(".uc-state-row", section()).at(-1).dataset.kind).toBe("changed");
    // a second row for the same key
    $$("button", section()).find((b) => b.textContent.endsWith("Add or override state")).click();
    await flush();
    const row = $$(".uc-state-row", section()).at(-1);
    pick($("select", row), "system");
    type($$("input[type=text]", row)[0], "connectivity");
    type($$("input[type=text]", row)[1], "offline");
    expect($(".uc-foot-msg", caseDialog()).textContent).toContain("is already set above. Change that row instead.");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(true);
  });

  it("an unset of a key the base lacks is a warning that says so and does not block", async () => {
    const { save, closed } = await open({ ...stored, variants: [{ ...rawVariant, state: [{ subject: "leo", property: "shoe-size", unset: true }] }] });
    expect($(".uc-field-warn[data-path='variant.0.state.0']:not([hidden])", variantCard()).textContent).toBe("Leo · shoe-size is not in the base state, so there is nothing to unset.");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(false);
    await savePayload(save, closed);
  });

  const opRows = () => $$(".uc-ops-edit .uc-step-op", variantCard());

  it("branch changes are rows of their own kind: Remove branch names the branch, a stored change comes back as stored", async () => {
    const { save, closed } = await open();
    expect(opRows().map((r) => r.dataset.op)).toEqual(["remove", "remove_branch"]);
    expect($("select[data-role=branch]", opRows()[1]).value).toBe("offline");
    expect([...$("select[data-role=branch]", opRows()[1]).options].map((o) => o.textContent)).toEqual(["Branch…", "A · Device is offline", "2A · Premium rises by more than 15 %", "2B · Leo turns 18"]);
    expect((await savePayload(save, closed)).variants).toBeUndefined(); // nothing about the variant changed
  });

  it("Branch change adds an Add branch row; its Edit opens the branch dialog in the variant's flow and Apply writes the op", async () => {
    const { save, closed } = await open();
    $$("button", variantCard()).find((b) => b.textContent.endsWith("Branch change")).click();
    await flush();
    const row = opRows().at(-1);
    expect($("select", row).value).toBe("add_branch");
    $("button[aria-label^='Edit the branch']", row).click();
    await flush();
    expect($("h1", top()).textContent).toBe("New branch");
    expect($(".uc-dialog-context", top()).textContent).toBe("in variant Single parent");
    expect([...$("select[aria-label='Forks after']", top()).options].map((o) => o.textContent)).toEqual(["Before the first step", "After step 1 · Opens the notice", "After step 2 · Shows old and new premium", "After step 3 · Accepts the premium"]);
    type($("input[autofocus]", top()), "Discount ends");
    pick($("select[aria-label='Condition 1 subject']", top()), "maria");
    type($("input[aria-label='Condition 1 property']", top()), "discount");
    type($("input[aria-label='Condition 1 value']", top()), "single");
    type($("input[aria-label='Step 1 action']", top()), "Shows the end of the discount");
    footButton("Apply branch").click();
    await flush();
    expect($(".uc-op-branch-summary", opRows().at(-1)).textContent).toBe("Discount ends · 1 step · 1 condition");
    const payload = await savePayload(save, closed);
    const op = payload.variants[0].steps.at(-1);
    expect(op).toMatchObject({ op: "add_branch", branch: { id: "discount-ends", title: "Discount ends", from: "accept", when: [{ subject: "maria", property: "discount", value: "single" }] } });
  });

  it("Replace branch: pick one, its current version is copied into the editor with the id locked; the op keeps the id", async () => {
    const { save, closed } = await open({ ...stored, variants: [{ ...rawVariant, steps: [] }] });
    $$("button", variantCard()).find((b) => b.textContent.endsWith("Branch change")).click();
    await flush();
    let row = opRows().at(-1);
    pick($("select", row), "replace_branch");
    await flush();
    row = opRows().at(-1);
    expect($("button[aria-label^='Edit the branch']", row).disabled).toBe(true);
    pick($("select[data-role=branch]", row), "rise");
    await flush();
    row = opRows().at(-1);
    $("button[aria-label^='Edit the branch']", row).click();
    await flush();
    expect($("h1", top()).textContent).toBe("Replace branch 2A");
    expect($("input.uc-mono", top()).readOnly).toBe(true);
    expect($("input.uc-mono", top()).value).toBe("rise");
    expect($(".uc-hint", top()).textContent).toContain("A replaced branch keeps its id.");
    type($("input[autofocus]", top()), "Premium rises by more than 10 %");
    footButton("Apply branch").click();
    await flush();
    const op = (await savePayload(save, closed)).variants[0].steps.at(-1);
    expect(op).toMatchObject({ op: "replace_branch", branch_id: "rise", branch: { id: "rise", title: "Premium rises by more than 10 %" } });
    expect(op.branch.steps.map((s) => s.id)).toEqual(["options", "cosign"]);
  });

  it("changing the kind of a change drops what the new kind does not allow (D1)", async () => {
    const { save, closed } = await open({ ...stored, variants: [{ ...rawVariant, steps: [{ op: "append", step: { id: "late", actor: "system", action: "Later" }, branch: "offline" }] }] });
    expect($("select[aria-label='Variant 1 change 1 branch']", variantCard()).value).toBe("offline");
    pick($("select[aria-label='Variant 1 change 1 operation']", variantCard()), "insert_after");
    await flush();
    pick($("select[data-role=step]", variantCard()), "open");
    await flush();
    const op = (await savePayload(save, closed)).variants[0].steps[0];
    expect(op).toMatchObject({ op: "insert_after", step_id: "open", step: { id: "late" } });
    expect(op).not.toHaveProperty("branch");
  });

  it("the changes below see the flow the changes above left: a removed branch is gone from the next select (N1)", async () => {
    await open();
    const [, removeBranch] = opRows();
    expect(removeBranch.dataset.op).toBe("remove_branch");
    $$("button", variantCard()).find((b) => b.textContent.endsWith("Step change")).click();
    await flush();
    const added = opRows().at(-1);
    expect([...$("select[data-role=step]", added).options].map((o) => o.textContent).join("|")).not.toContain("Shows the saved notice"); // branch "offline" was removed above
    // moving the removal below hands the branch back to the change above it
    expect([...$("select[data-role=step]", opRows()[0]).options].map((o) => o.textContent).join("|")).toContain("Shows the saved notice");
  });

  it("a change that empties a branch is a warning at its row, never a block", async () => {
    await open({ ...stored, variants: [{ ...rawVariant, state: undefined, steps: [{ op: "remove", step_id: "leaves" }] }] });
    expect($(".uc-field-warn[data-path='variant.0.op.0.step']:not([hidden])", variantCard()).textContent).toBe("Branch 2B has no steps left in this variant. Remove the branch too, or keep a step.");
    expect(footButton("Save use case", caseDialog()).disabled).toBe(false);
  });

  it("'Applies when' lists world dimensions first, each labelled with its scope", async () => {
    await open();
    expect($$(".uc-when-dim", variantCard()).map((d) => d.textContent.replace(/\s+/g, " ").trim())).toEqual(["Household world", "Channel personas"]);
  });
});
