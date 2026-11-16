// @vitest-environment jsdom
//
// The structured variant editor inside the use-case dialog (CHR-1109): overrides (inherited / overridden, Use base drops the
// key), actor swaps, step changes with the full step editor, the empty state, and the blocking / non-blocking problems.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openUseCaseDialog, draftFromSource } from "./usecases-forms.js";
import { blankVariant } from "./usecases-variant-edit.js";
import { makePool, rawUseCase } from "./usecases.test-helper.js";

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
const button = (label) => $$("dialog .uc-foot-actions button").find((b) => b.textContent === label);
const byText = (root, selector, text) => $$(selector, root).find((el) => el.textContent === text);

function options(over = {}) {
  return {
    mode: "edit",
    source: rawUseCase,
    pool: () => makePool(),
    screens: () => ["editor", "picker"],
    groups: () => [],
    takenIds: () => new Set(["map-step"]),
    loadNodes: async () => ["btn-map", "row-agent"],
    save: vi.fn(async () => ({ ok: true, data: { warnings: [] } })),
    newObject: vi.fn(async () => {}),
    ...over,
  };
}

async function open(over = {}) {
  const opts = options(over);
  const closed = openUseCaseDialog(opts);
  await flush();
  return { opts, closed };
}

const variantCard = (n) => $$(".uc-variant-edit")[n];
const row = (card, key) => $(`.uc-override-row[data-key="${key}"]`, card);
const addSwap = (card) => byText(card, "button", "addActor swap").click();
const addChange = (card) => byText(card, "button", "addStep change").click();

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("structure", () => {
  it("has no JSON field: three sections below the condition, six override rows, every row inherited when nothing is overridden", async () => {
    await open();
    const card = variantCard(1); // "large": nothing overridden
    expect($$("textarea", card)).toHaveLength(0);
    expect(card.textContent).not.toContain("null"); // an absent child must never be drawn as the text "null"
    expect($$(".uc-var-h", card).map((h) => h.firstChild.textContent)).toEqual(["Overrides", "Actor swaps", "Step changes"]);
    expect($$(".uc-override-row", card).map((r) => r.querySelector(".uc-label").textContent)).toEqual(["Trigger", "Goal", "Outcome", "Personas", "Inputs", "Outputs"]);
    expect($$(".uc-override-row", card).every((r) => r.dataset.state === "base")).toBe(true);
    expect($(".uc-inherited-value", row(card, "trigger")).textContent).toBe("Step has no target");
    expect($(".uc-inherited-from", row(card, "trigger")).textContent).toBe("From base");
    expect($(".uc-inherited-value", row(card, "personas")).textContent).toBe("Dana");
    expect($(".uc-inherited-value", row(card, "outputs")).textContent).toBe("Mapping · status: ready, owner: Pablo");
  });

  it("shows what a stored variant overrides: its editors prefilled, with Use base", async () => {
    await open();
    const card = variantCard(0); // "agent": personas + outputs
    expect(row(card, "personas").dataset.state).toBe("override");
    expect($$(".uc-person-chip", row(card, "personas")).map((c) => c.dataset.persona)).toEqual(["dex"]);
    expect($("input[aria-label='Variant 1 output 1 example']", card).value).toBe("status: ready, owner: Agent");
    expect(byText(row(card, "outputs"), "button", "Use base")).toBeTruthy();
    expect(row(card, "trigger").dataset.state).toBe("base");
  });

  it("the empty state of a new variant says nothing is overridden, swapped or changed", async () => {
    const draft = draftFromSource(rawUseCase);
    draft.variants.push(blankVariant());
    await open({ initialDraft: draft, focus: { variants: true } });
    const card = variantCard(2);
    expect(document.activeElement.getAttribute("aria-label")).toBe("Variant 3 title");
    expect($("input[aria-label='Variant 3 title']", card).placeholder).toBe("Large project: map from the list");
    expect($(".uc-swaps-edit", card).textContent).toContain("None. Every inherited step keeps its base actor.");
    expect($(".uc-ops-edit", card).textContent).toContain("None. This variant runs the 3 base steps as they are.");
    expect($(".uc-foot-msg").textContent).toBe("Variant 3 needs a title.");
    expect(button("Save use case").disabled).toBe(true);
  });
});

describe("overrides", () => {
  it("Override copies the base value into an editor; the typed text is saved", async () => {
    const { opts, closed } = await open();
    const card = variantCard(1);
    byText(row(card, "goal"), "button", "Override").click();
    const area = $("textarea", row(card, "goal"));
    expect(area.value).toBe("Map it");
    expect(document.activeElement).toBe(area);
    type(area, "Map it in one go");
    button("Save use case").click();
    await closed;
    expect(opts.save.mock.calls[0][0].variants[1].goal).toBe("Map it in one go");
  });

  it("Use base takes the key out of the variant object and never sends null", async () => {
    const { opts, closed } = await open();
    const card = variantCard(0);
    byText(row(card, "outputs"), "button", "Use base").click();
    expect(row(card, "outputs").dataset.state).toBe("base");
    expect(document.activeElement).toBe(byText(row(card, "outputs"), "button", "Override"));
    button("Save use case").click();
    await closed;
    const agent = opts.save.mock.calls[0][0].variants[0];
    expect("outputs" in agent).toBe(false);
    expect(JSON.stringify(agent)).not.toContain("null");
  });

  it("inputs and outputs start as a copy of the base rows and replace the list wholesale", async () => {
    const { opts, closed } = await open();
    const card = variantCard(1);
    byText(row(card, "inputs"), "button", "Override").click();
    expect($("input[aria-label='Variant 2 input 1 example']", card).value).toBe("status: draft");
    byText(row(card, "inputs"), ".uc-link-btn", "addInput").click();
    const added = $$(".uc-io-row", row(card, "inputs"))[1];
    type(added.querySelector("select"), "mapping");
    type(added.querySelectorAll("input")[1], "status: ready");
    button("Save use case").click();
    await closed;
    expect(opts.save.mock.calls[0][0].variants[1].inputs).toEqual([
      { object: "mapping", source: "mapping", example: { status: "draft" } },
      { object: "mapping", example: { status: "ready" } },
    ]);
  });

  it("an overridden list without a row with an example blocks Save", async () => {
    await open();
    const card = variantCard(0);
    $("button[aria-label='Remove output 1 of variant 1']", card).click();
    expect($(".uc-foot-msg").textContent).toBe('Variant "No human": an overridden outputs list needs at least one output with an example.');
    expect(button("Save use case").disabled).toBe(true);
  });

  it("personas: Override copies the base chips and the picker edits them", async () => {
    const { opts, closed } = await open();
    const card = variantCard(1);
    byText(row(card, "personas"), "button", "Override").click();
    expect($$(".uc-person-chip", row(card, "personas")).map((c) => c.dataset.persona)).toEqual(["dana"]);
    $("button[aria-label='Add persona to variant 2']", card).click();
    const labels = $$(".uc-menu .uc-menu-item").map((i) => i.querySelector(".uc-menu-label").textContent);
    $$(".uc-menu .uc-menu-item")[labels.indexOf("Dex")].click();
    button("Save use case").click();
    await closed;
    expect(opts.save.mock.calls[0][0].variants[1].personas).toEqual(["dana", "dex"]);
  });
});

describe("actor swaps", () => {
  it("+ Actor swap adds a from → to row that is written as the actors map, once per from", async () => {
    const { opts, closed } = await open();
    const card = variantCard(1);
    addSwap(card);
    const [from, to] = $$(".uc-swap-row select", card);
    expect($$("option", from).map((o) => o.textContent)).toEqual(["Actor…", "System", "Dana", "Dex"]); // generated personas stay out
    type(from, "dana");
    type(to, "dex");
    expect($$("option", to).find((o) => o.value === "dana").disabled).toBe(true); // the to-select may not equal its from
    addSwap(card);
    const second = $$(".uc-swap-row", card)[1].querySelectorAll("select")[0];
    expect($$("option", second).find((o) => o.value === "dana").disabled).toBe(true); // a from-value appears once
    $$(".uc-swap-row", card)[1].querySelector("button").click(); // an unfinished row is simply removed
    button("Save use case").click();
    await closed;
    expect(opts.save.mock.calls[0][0].variants[1].actors).toEqual({ dana: "dex" });
  });

  it("the inherited Personas row follows the swaps: 'Dex (Dana, swapped below)', then 'none (Dana is swapped to System)'", async () => {
    await open();
    const card = variantCard(1);
    addSwap(card);
    type($$(".uc-swap-row select", card)[0], "dana");
    type($$(".uc-swap-row select", card)[1], "dex");
    expect($(".uc-inherited-value", row(card, "personas")).textContent).toBe("Dex (Dana, swapped below)");
    type($$(".uc-swap-row select", card)[1], "system");
    expect($(".uc-inherited-value", row(card, "personas")).textContent).toBe("none (Dana is swapped to System)");
  });

  it("a swap to an unknown persona warns and never blocks", async () => {
    const source = { ...rawUseCase, variants: [{ id: "swap", title: "Swap", when: { size: ["large"] }, actors: { dana: "ghost" } }] };
    await open({ source });
    expect($(".uc-field-warn[data-path='variant.0.swap.0.to']").textContent).toBe("Persona ghost does not exist.");
    expect($(".uc-foot-msg").dataset.tone).toBe("warning");
    expect(button("Save use case").disabled).toBe(false);
  });
});

describe("step changes", () => {
  const ops = (card) => $$(".uc-step-op", card);

  it("lists the stored changes in order, each with its kind and step; Remove shows the struck base step", async () => {
    await open();
    const card = variantCard(0);
    expect(ops(card).map((o) => o.dataset.op)).toEqual(["replace", "remove", "append"]);
    expect($("select[aria-label='Variant 1 change 1 operation']", card).value).toBe("replace");
    expect($$("select[aria-label='Variant 1 change 1 step'] option", card).map((o) => o.textContent)).toEqual(["Step…", "1 · Taps the step", "2 · Picks Pablo", "3 · Dex gets a push"]);
    expect($(".uc-op-removed", ops(card)[1]).textContent).toContain("Dex gets a push");
    expect($(".uc-op-removed .uc-diff", ops(card)[1]).dataset.kind).toBe("removed");
    expect($(".uc-op-after-last", ops(card)[2]).textContent).toBe("after the last step");
    expect($("select[aria-label='Variant 1 change 3 step']", card)).toBeNull();
  });

  it("the select of a later change lists the flow as it stands: steps added above can be targeted", async () => {
    await open();
    const card = variantCard(0);
    addChange(card);
    expect($$("select[aria-label='Variant 1 change 4 step'] option", card).map((o) => o.textContent)).toEqual(["Step…", "1 · Taps the step", "2 · Picks the agent", "3 · Sets the time"]);
  });

  it("+ Step change adds a Replace on the 'Step…' placeholder and focuses its operation; picking a step prefills the whole body, id included and editable", async () => {
    const { opts, closed } = await open();
    const card = variantCard(1);
    addChange(card);
    expect(document.activeElement.getAttribute("aria-label")).toBe("Variant 2 change 1 operation");
    expect($("select[aria-label='Variant 2 change 1 step']", card).value).toBe("");
    expect($(".uc-op-body", card)).toBeNull();
    expect($(".uc-foot-msg").textContent).toBe('Variant "Large project", change 1: pick the step it changes.');
    type($("select[aria-label='Variant 2 change 1 step']", card), "pick");
    expect($("input[aria-label='Variant 2 change 1 step id']", card).value).toBe("pick");
    expect($("input[aria-label='Variant 2 change 1 action']", card).value).toBe("Picks Pablo");
    expect($("select[aria-label='Variant 2 change 1 actor']", card).value).toBe("dana");
    expect($("input[aria-label='Variant 2 change 1 data 1 after']", card).value).toBe("status: ready, owner: Pablo");
    expect($(".uc-op-body .uc-step-data-edit .uc-link-btn", card).textContent).toBe("addData change");
    type($("input[aria-label='Variant 2 change 1 action']", card), "Picks Pablo and confirms");
    button("Save use case").click();
    await closed;
    expect(opts.save.mock.calls[0][0].variants[1].steps).toEqual([{ op: "replace", step_id: "pick", step: { ...rawUseCase.steps[1], action: "Picks Pablo and confirms" } }]);
  });

  it("a swapped actor is what a Replace prefills, and changing the step later keeps what was typed", async () => {
    await open();
    const card = variantCard(1);
    addSwap(card);
    type($$(".uc-swap-row select", card)[0], "dana");
    type($$(".uc-swap-row select", card)[1], "dex");
    addChange(card);
    type($("select[aria-label='Variant 2 change 1 step']", card), "tap");
    expect($("select[aria-label='Variant 2 change 1 actor']", card).value).toBe("dex");
    type($("input[aria-label='Variant 2 change 1 action']", card), "Typed");
    type($("select[aria-label='Variant 2 change 1 step']", card), "pick");
    expect($("input[aria-label='Variant 2 change 1 action']", card).value).toBe("Typed");
  });

  it("switching the kind: Insert after and Append bodies start empty and end with + Data change; Remove has no body", async () => {
    const { opts, closed } = await open();
    const card = variantCard(1);
    addChange(card);
    type($("select[aria-label='Variant 2 change 1 operation']", card), "insert_after");
    expect($("input[aria-label='Variant 2 change 1 action']", card).value).toBe("");
    expect($(".uc-op-body .uc-step-data-edit .uc-link-btn", card).textContent).toBe("addData change");
    type($("select[aria-label='Variant 2 change 1 step']", card), "tap");
    type($("input[aria-label='Variant 2 change 1 step id']", card), "check");
    type($("input[aria-label='Variant 2 change 1 action']", card), "Checks the node");
    type($("select[aria-label='Variant 2 change 1 operation']", card), "append");
    expect($("select[aria-label='Variant 2 change 1 step']", card)).toBeNull();
    expect($(".uc-op-body", card)).not.toBeNull();
    type($("select[aria-label='Variant 2 change 1 operation']", card), "remove");
    expect($(".uc-op-body", card)).toBeNull();
    type($("select[aria-label='Variant 2 change 1 operation']", card), "insert_after");
    button("Save use case").click();
    await closed;
    expect(opts.save.mock.calls[0][0].variants[1].steps).toEqual([{ op: "insert_after", step_id: "tap", step: { id: "check", actor: "dana", action: "Checks the node" } }]);
  });

  it("the target picker works inside a change (screen, element, none)", async () => {
    const { opts, closed } = await open();
    const card = variantCard(1);
    addChange(card);
    type($("select[aria-label='Variant 2 change 1 operation']", card), "append");
    type($("input[aria-label='Variant 2 change 1 action']", card), "Opens the picker");
    byText($("[role=radiogroup]", card), "button", "Element").click();
    type($("input[aria-label='Variant 2 change 1 screen']", card), "picker");
    type($("input[aria-label='Variant 2 change 1 element']", card), "row-agent");
    button("Save use case").click();
    await closed;
    expect(opts.save.mock.calls[0][0].variants[1].steps[0].step.target).toEqual({ screen: "picker", node: "row-agent" });
  });

  it("removing a change takes it out of the list; the empty text counts the base steps", async () => {
    await open();
    const card = variantCard(0);
    for (let i = 0; i < 3; i++) $("button[aria-label='Remove change 1 of variant 1']", card).click();
    expect($(".uc-ops-edit", card).textContent).toContain("None. This variant runs the 3 base steps as they are.");
  });
});

describe("problems", () => {
  it("a duplicate step id blocks Save: red field, aria-invalid, hint tied with aria-describedby, first error in the footer", async () => {
    const { opts } = await open();
    const card = variantCard(1);
    addChange(card);
    type($("select[aria-label='Variant 2 change 1 operation']", card), "insert_after");
    type($("select[aria-label='Variant 2 change 1 step']", card), "tap");
    type($("input[aria-label='Variant 2 change 1 action']", card), "Opens");
    const id = $("input[aria-label='Variant 2 change 1 step id']", card);
    // Not invalid yet: nothing is announced for the field (the hint is not referenced while it is hidden)
    expect(id.getAttribute("aria-invalid")).toBe("false");
    expect(id.hasAttribute("aria-describedby")).toBe(false);
    type(id, "pick");
    expect(id.classList.contains("is-error")).toBe(true);
    expect(id.getAttribute("aria-invalid")).toBe("true");
    const hint = document.getElementById(id.getAttribute("aria-describedby"));
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe("pick is already a step in this flow. Give the new step another id.");
    expect($(".uc-foot-msg").textContent).toBe('Variant "Large project", change 1: pick is already a step in this flow.');
    expect($(".uc-foot-msg").dataset.tone).toBe("error");
    expect(button("Save use case").disabled).toBe(true);
    type(id, "opens-it");
    expect(id.getAttribute("aria-invalid")).toBe("false");
    expect(id.hasAttribute("aria-describedby")).toBe(false);
    expect(hint.hidden).toBe(true);
    expect(button("Save use case").disabled).toBe(false);
    expect(opts.save).not.toHaveBeenCalled();
  });

  it("a change whose step is not in the flow warns, keeps its stored id as '(unknown)', and never blocks", async () => {
    const source = { ...rawUseCase, variants: [{ id: "v", title: "V", when: { size: ["large"] }, steps: [{ op: "replace", step_id: "save", step: { id: "save", actor: "dana", action: "Saves" } }] }] };
    const { opts, closed } = await open({ source });
    const select = $("select[aria-label='Variant 1 change 1 step']");
    expect(select.value).toBe("save");
    expect($$("option", select).map((o) => o.textContent)).toContain("save (unknown)");
    expect(select.classList.contains("is-warning")).toBe(true);
    const hint = document.getElementById(select.getAttribute("aria-describedby"));
    expect(hint.textContent).toBe("save is not a step of the flow at this point. This change is skipped; you can still save.");
    expect(button("Save use case").disabled).toBe(false);
    button("Save use case").click();
    await closed;
    expect(opts.save).toHaveBeenCalledTimes(1);
  });
});

describe("saving", () => {
  it("an untouched edit sends no variants", async () => {
    const { opts, closed } = await open();
    type($("dialog input[autofocus]"), "Renamed");
    button("Save use case").click();
    await closed;
    expect(opts.save.mock.calls[0][0].variants).toBeUndefined();
  });
});
