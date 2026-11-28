// @vitest-environment jsdom
//
// The world pool dialogs (ADR-011, CHR-1154): entity, relationship type, constellation; persona kind, dimension scope and the
// generation target switch. A shape error blocks Save, a reference problem is a warning, delete asks first.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openEntityDialog, openRelationshipTypeDialog, openConstellationDialog, relationshipWarnings } from "./usecases-forms-world.js";
import { openPersonaDialog, openDimensionDialog, openGenerateDialog } from "./usecases-forms-pool.js";
import { entities, relationshipTypes, constellations, makeWorldPool } from "./usecases-world.test-helper.js";
import { indexById } from "./usecases-data.js";

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
const objects = [{ id: "policy", name: "Policy", fields: [{ name: "holder", type: "ref", ref: "member" }, { name: "premium", type: "number" }, { name: "covered", type: "list" }] }];
const pool = (extra = {}) => ({ ...makeWorldPool({ objects, objectsById: indexById(objects) }), world: { entities, relationship_types: relationshipTypes, constellations }, ...extra });
const ok = () => vi.fn(async () => ({ ok: true, data: { warnings: [] } }));

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("entity dialog", () => {
  const open = (extra = {}) => {
    const save = ok();
    const remove = vi.fn(async () => ({ ok: true, data: { warnings: [] } }));
    const closed = openEntityDialog({ mode: "new", source: null, pool: () => pool(), takenIds: () => new Set(["leo"]), save, remove, ...extra });
    return { save, remove, closed };
  };

  it("creates an entity: the id follows the name, traits and data object are optional", async () => {
    const { save, closed } = open();
    await flush();
    expect(button("Create entity").disabled).toBe(true);
    type($("dialog input[autofocus]"), "Household policy");
    expect($("dialog input.uc-mono").value).toBe("household-policy");
    type($$("dialog input")[1], "Policy"); // Type
    expect(button("Create entity").disabled).toBe(false);
    button("Create entity").click();
    const result = await closed;
    expect(result.id).toBe("household-policy");
    expect(save.mock.calls[0][0]).toEqual({ id: "household-policy", name: "Household policy", type: "Policy" });
  });

  it("'system' is reserved: a shape error in the design's words, Save is blocked", async () => {
    open();
    await flush();
    type($("dialog input[autofocus]"), "System");
    expect(button("Create entity").disabled).toBe(true);
    expect($(".uc-foot-msg").textContent).toBe("system is reserved for artisign itself. Pick another id.");
    expect($(".uc-foot-msg").dataset.tone).toBe("error");
  });

  it("an id shared with a persona is a warning, never a block", async () => {
    const { save, closed } = open();
    await flush();
    type($("dialog input[autofocus]"), "Maria");
    expect($(".uc-field-warn:not([hidden])").textContent).toContain("A persona has the id maria");
    expect(button("Create entity").disabled).toBe(false);
    button("Create entity").click();
    await closed;
    expect(save.mock.calls[0][0].id).toBe("maria");
  });

  it("edits a stored entity: the id is fixed, cleared fields become null, the data object select needs a data model", async () => {
    const source = { id: "leo", name: "Leo", type: "Child", description: "A son", avatar: { emoji: "🧒" }, traits: { household: "two-parents" }, object: "policy" };
    const { save, closed } = open({ mode: "edit", source });
    await flush();
    expect($("dialog input.uc-mono").readOnly).toBe(true);
    expect($("dialog select[aria-label='Data object']").value).toBe("policy");
    type($$("dialog input")[1], ""); // Type
    type($("dialog textarea"), "");
    button("Save entity").click();
    await closed;
    expect(save.mock.calls[0][0]).toMatchObject({ id: "leo", type: null, description: null });
    // without data objects the select is disabled
    document.body.innerHTML = "";
    openEntityDialog({ mode: "new", source: null, pool: () => pool({ objects: [] }), takenIds: () => new Set(), save: ok(), remove: vi.fn() });
    await flush();
    expect($("dialog select[aria-label='Data object']").disabled).toBe(true);
  });

  it("delete asks first, names where it is used, and only then deletes", async () => {
    const source = { id: "leo", name: "Leo" };
    const usage = vi.fn(async () => "Used by 3 use cases.");
    const { remove, closed } = open({ mode: "edit", source, usage });
    await flush();
    button("Delete").click();
    await flush();
    expect(remove).not.toHaveBeenCalled();
    expect($(".uc-foot-msg").textContent).toContain("Delete Leo? Used by 3 use cases. If something still refers to it");
    expect($(".uc-foot-msg").textContent).toContain("Nothing is repaired");
    button("Delete Leo").click();
    await flush();
    expect(remove).toHaveBeenCalledWith("leo");
    expect((await closed).deleted).toBe(true);
  });
});

describe("CHR-1170: clearing the id field derives it from the name again (entity, constellation)", () => {
  it("entity", async () => {
    const save = ok();
    openEntityDialog({ mode: "new", source: null, pool: () => pool(), takenIds: () => new Set(), save, remove: vi.fn() });
    await flush();
    type($("dialog input[autofocus]"), "Household policy");
    type($("dialog input.uc-mono"), "");
    expect(button("Create entity").disabled).toBe(false);
    button("Create entity").click();
    await flush();
    expect(save.mock.calls[0][0]).toMatchObject({ id: "household-policy", name: "Household policy" });
  });

  it("constellation", async () => {
    const save = ok();
    openConstellationDialog({ mode: "new", source: null, pool: () => pool(), takenIds: () => new Set(), save, remove: vi.fn() });
    await flush();
    type($("dialog input[autofocus]"), "Two parents");
    type($("dialog input.uc-mono"), "");
    expect(button("Create constellation").disabled).toBe(false);
    button("Create constellation").click();
    await flush();
    expect(save.mock.calls[0][0]).toMatchObject({ id: "two-parents", name: "Two parents" });
  });
});

describe("relationship type dialog", () => {
  const open = (extra = {}) => {
    const save = ok();
    const closed = openRelationshipTypeDialog({ mode: "new", source: null, pool: () => pool(), takenIds: () => new Set(), save, remove: vi.fn(), ...extra });
    return { save, closed };
  };

  it("shows how the label reads with two real participants, and the inverse only when there is one", async () => {
    open();
    await flush();
    type($("dialog input[autofocus]"), "is parent of");
    expect($(".uc-reads").textContent).toContain("Maria");
    expect($(".uc-reads").textContent).toContain("is parent of");
    expect($$(".uc-reads-line")).toHaveLength(1);
    type($$("dialog input")[1], "is child of");
    expect($$(".uc-reads-line")).toHaveLength(2);
    expect($$(".uc-reads-line")[1].textContent).toContain("is child of");
  });

  it("both ends share: dimensions as checkboxes, written as same_traits; inverse labels are never derived", async () => {
    const { save, closed } = open();
    await flush();
    type($("dialog input[autofocus]"), "holds");
    expect($$("dialog input[type=checkbox]").map((b) => b.parentElement.textContent)).toEqual(["Channel", "Household"]);
    const household = $$("dialog input[type=checkbox]")[1];
    household.checked = true;
    household.dispatchEvent(new Event("change", { bubbles: true }));
    button("Create relationship type").click();
    await closed;
    const sent = save.mock.calls[0][0];
    expect(sent).toEqual({ id: "holds", label: "holds", same_traits: ["household"] });
    expect(sent).not.toHaveProperty("inverse_label");
  });

  it("the data field needs both parts: the object, then one of its ref or list fields", async () => {
    const { save, closed } = open();
    await flush();
    type($("dialog input[autofocus]"), "holds");
    const fieldSelect = $("dialog select[aria-label='Field']");
    expect(fieldSelect.disabled).toBe(true);
    type($("dialog select[aria-label='Data object of the field']"), "policy");
    expect([...fieldSelect.options].map((o) => o.value)).toEqual(["", "holder", "covered"]); // premium is a number: not a relationship
    expect(button("Create relationship type").disabled).toBe(true);
    type(fieldSelect, "holder");
    expect(button("Create relationship type").disabled).toBe(false);
    button("Create relationship type").click();
    await closed;
    expect(save.mock.calls[0][0].field).toEqual({ object: "policy", name: "holder" });
  });

  it("delete says in how many constellations it is used", async () => {
    const source = relationshipTypes[1];
    open({ mode: "edit", source });
    await flush();
    expect($(".uc-foot-note").textContent).toBe("Used in 2 constellations");
    button("Delete").click();
    await flush();
    expect($(".uc-foot-msg").textContent).toContain("Used in 2 constellations.");
  });
});

describe("constellation dialog", () => {
  const source = { ...constellations[0], relationships: [...constellations[0].relationships] };
  const open = (extra = {}) => {
    const save = ok();
    const closed = openConstellationDialog({ mode: "edit", source, pool: () => pool(), takenIds: () => new Set(), save, remove: vi.fn(), ...extra });
    return { save, closed };
  };

  it("lists the relationships as from / type / to selects with the note, and the members from the ends", async () => {
    open();
    await flush();
    const rows = $$(".uc-rel-row");
    expect(rows).toHaveLength(3);
    expect($$("select", rows[1]).map((s) => s.selectedOptions[0].textContent)).toEqual(["Maria", "is parent of", "Leo"]);
    expect($("input[aria-label='Relationship 2 note']").value).toBe("Primary caregiver");
    expect($$(".uc-rel-members .uc-participant-name").map((p) => p.textContent)).toEqual(["Maria", "Jon", "Leo", "Household liability policy"]);
  });

  it("the To select can show the longest participant name: it is the widest column and carries the name as its title (design review R3)", async () => {
    open();
    await flush();
    const to = $$(".uc-rel-to");
    expect(to).toHaveLength(3);
    expect(to[2].selectedOptions[0].textContent).toBe("Household liability policy");
    expect(to[2].dataset.tooltip).toBe("Household liability policy");
    expect(to[2].getAttribute("aria-label")).toBe("Relationship 3 to");
  });

  it("an end that is no participant and a relationship to oneself are warnings: Save stays possible", async () => {
    const { save, closed } = open();
    await flush();
    expect(relationshipWarnings({ from: "grandma-ida", type: "parent-of", to: "maria", note: "" }, pool(), indexById(relationshipTypes))[0].message).toBe("grandma-ida is neither a persona nor an entity. Add it to the world or pick a participant from the list.");
    expect(relationshipWarnings({ from: "maria", type: "partner-of", to: "maria", note: "" }, pool(), indexById(relationshipTypes))[0].message).toBe("Maria is partner of Maria: a relationship needs two different participants.");
    $("button.uc-link-btn").click(); // Add relationship
    await flush();
    const added = $$(".uc-rel-row").at(-1);
    type($$("select", added)[0], "maria");
    type($$("select", added)[1], "partner-of");
    type($$("select", added)[2], "maria");
    expect($(".uc-foot-msg").textContent).toBe("1 warning · you can save anyway");
    expect(button("Save constellation").disabled).toBe(false);
    button("Save constellation").click();
    await closed;
    expect(save.mock.calls[0][0].relationships.at(-1)).toEqual({ from: "maria", type: "partner-of", to: "maria" });
  });

  it("an unfinished relationship row blocks Save and says so once the row was left", async () => {
    open();
    await flush();
    $("button.uc-link-btn").click();
    await flush();
    expect(button("Save constellation").disabled).toBe(true);
    const added = $$(".uc-rel-row").at(-1);
    expect($(".uc-field-error:not([hidden])")).toBeNull(); // not yet: the row has not been left
    added.querySelector("select").focus();
    added.querySelector("select").blur();
    added.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    await flush();
    expect($(".uc-field-error:not([hidden])").textContent).toBe("Pick from, a type and to.");
    expect(button("Save constellation").disabled).toBe(true);
  });

  it("the note of a relationship and a generated marker survive a save; an untouched save sends the same relationships", async () => {
    const generated = { ...source, generated: true };
    const { save, closed } = open({ source: generated });
    await flush();
    expect($(".uc-generated")).toBeTruthy();
    button("Save constellation").click();
    await closed;
    const sent = save.mock.calls[0][0];
    expect(sent.relationships).toEqual(source.relationships);
    expect(sent.generated).toBe(true);
    expect(sent.traits).toEqual({ household: "two-parents" });
  });

  it("traits: constellation dimensions first, a stored trait of a persona dimension stays and is labelled", async () => {
    open({ source: { ...source, traits: { household: "two-parents", channel: "app" } } });
    await flush();
    const labels = $$(".uc-cst-trait-grid .uc-trait-label").map((l) => l.textContent.replace(/\s+/g, " ").trim());
    expect(labels).toEqual(["Household", "Channel · personas"]);
  });

  it("deletes after asking", async () => {
    const remove = vi.fn(async () => ({ ok: true, data: {} }));
    const { closed } = open({ remove, usage: async () => "Used by 3 use cases." });
    await flush();
    expect($(".uc-foot-note").textContent).toBe("Used by 3 use cases");
    button("Delete").click();
    await flush();
    button("Delete Two parents, one child").click();
    await flush();
    expect(remove).toHaveBeenCalledWith("two-parents");
    expect((await closed).deleted).toBe(true);
  });
});

describe("persona kind", () => {
  it("a new persona starts as a human and sends the kind; one stored without a kind stays without until the select is used", async () => {
    const save = ok();
    openPersonaDialog({ mode: "edit", source: { id: "dana", name: "Dana", traits: {} }, pool: () => pool(), takenIds: () => new Set(), save, remove: vi.fn() });
    await flush();
    const select = $("dialog select[aria-label='Kind']");
    expect(select.value).toBe("");
    expect([...select.options].map((o) => o.textContent)).toEqual(["Not stated", "Human", "Agent", "Service", "Organization"]);
    button("Save persona").click();
    await flush();
    expect(save.mock.calls[0][0]).not.toHaveProperty("kind");
    document.body.innerHTML = "";
    openPersonaDialog({ mode: "edit", source: { id: "dana", name: "Dana", kind: "agent", traits: {} }, pool: () => pool(), takenIds: () => new Set(), save, remove: vi.fn() });
    await flush();
    expect($(".uc-kind-preview .icon").textContent).toBe("smart_toy");
    type($("dialog select[aria-label='Kind']"), "");
    button("Save persona").click();
    await flush();
    expect(save.mock.calls[1][0].kind).toBeNull(); // cleared: the key is removed
  });

  it("shows only persona dimensions as traits, plus a stored trait of the other scope labelled with it", async () => {
    openPersonaDialog({ mode: "edit", source: { id: "dana", name: "Dana", traits: { household: "two-parents" } }, pool: () => pool(), takenIds: () => new Set(), save: ok(), remove: vi.fn() });
    await flush();
    expect($$(".uc-trait-row .uc-trait-label").map((l) => l.textContent.replace(/\s+/g, " ").trim())).toEqual(["Channel", "Household · constellations"]);
    document.body.innerHTML = "";
    openPersonaDialog({ mode: "new", source: null, pool: () => pool(), takenIds: () => new Set(), save: ok(), remove: vi.fn() });
    await flush();
    expect($$(".uc-trait-row .uc-trait-label").map((l) => l.textContent.trim())).toEqual(["Channel"]);
  });
});

describe("dimension scope", () => {
  it("'Describes' is Personas or Constellations; the key is written when it is not the default or already stored", async () => {
    const save = ok();
    openDimensionDialog({ mode: "new", source: null, takenIds: () => new Set(), save, remove: vi.fn() });
    await flush();
    type($("dialog input[autofocus]"), "Household");
    $$("dialog .uc-value-row input").forEach((input, i) => type(input, `Value ${i}`));
    expect($("dialog .uc-segmented [aria-checked=true]").textContent).toBe("Personas");
    button("Create dimension").click();
    await flush();
    expect(save.mock.calls[0][0]).not.toHaveProperty("scope");
    document.body.innerHTML = "";
    openDimensionDialog({ mode: "new", source: null, takenIds: () => new Set(), save, remove: vi.fn() });
    await flush();
    type($("dialog input[autofocus]"), "Household");
    $$("dialog .uc-value-row input").forEach((input, i) => type(input, `Value ${i}`));
    $$("dialog .uc-segmented button").find((b) => b.textContent === "Constellations").click();
    button("Create dimension").click();
    await flush();
    expect(save.mock.calls[1][0].scope).toBe("constellations");
  });
});

describe("generate: the target switch", () => {
  const dryRun = { ok: true, data: { dry_run: true, strategy: "pairwise", target: "constellations", total: 6, skipped_covered: 3, would_create: 3, constellations: [{ id: "a", name: "A · 1", traits: { household: "blended" } }, { id: "b", name: "B · 2", traits: {} }, { id: "c", name: "C · 3", traits: {} }] } };

  it("offers only the dimensions of the chosen scope, sends `target` for constellations and says how many it creates", async () => {
    const generate = vi.fn(async (input) => (input.dry_run ? dryRun : { ok: true, data: { created: 3, ids: [] } }));
    const closed = openGenerateDialog({ pool: () => pool(), generate });
    await flush();
    expect($$("dialog .uc-gen-dims input").map((i) => i.parentElement.textContent)).toEqual(["Channel (2)"]);
    $$("dialog .uc-segmented button").find((b) => b.textContent === "Constellations").click();
    await flush();
    expect($$("dialog .uc-gen-dims input").map((i) => i.parentElement.textContent)).toEqual(["Household (3)"]);
    expect($(".uc-gen-dims").textContent).toContain("Channel has the scope Personas and is not offered here.");
    $$("dialog button").find((b) => b.textContent.includes("Preview")).click();
    await flush();
    expect(generate.mock.calls[0][0]).toEqual({ strategy: "pairwise", target: "constellations", limit: 100, dry_run: true });
    expect($(".uc-preview-summary").textContent).toContain("3 would be created");
    expect($(".uc-preview-summary").textContent).toContain("already covered by existing constellations");
    expect($$(".uc-preview-list li")).toHaveLength(3);
    expect($(".uc-preview").textContent).toContain("Generated constellations start without relationships");
    expect(button("Create 3 constellations")).toBeTruthy();
    button("Create 3 constellations").click();
    const result = await closed;
    expect(generate.mock.calls[1][0]).toEqual({ strategy: "pairwise", target: "constellations", limit: 100 });
    expect(result).toMatchObject({ created: 3, target: "constellations" });
  });

  it("opens on the constellations target when the World tab asks for it; switching invalidates a preview", async () => {
    const generate = vi.fn(async () => dryRun);
    openGenerateDialog({ pool: () => pool(), generate, target: "constellations" });
    await flush();
    expect($("dialog .uc-segmented [aria-checked=true]").textContent).toBe("Constellations");
    $$("dialog button").find((b) => b.textContent.includes("Preview")).click();
    await flush();
    expect($(".uc-preview-summary")).toBeTruthy();
    $$("dialog .uc-segmented button").find((b) => b.textContent === "Personas").click();
    await flush();
    expect($(".uc-preview-summary")).toBeNull();
    expect(button("Create personas").disabled).toBe(true);
  });

  it("with no dimension of the scope the preview is disabled and the note says what to do", async () => {
    const onlyPersonas = pool({ dimensions: [pool().dimensions[0]] });
    openGenerateDialog({ pool: () => onlyPersonas, generate: vi.fn(), target: "constellations" });
    await flush();
    expect($("dialog").textContent).toContain("Give a dimension the scope Constellations first.");
    expect($$("dialog button").find((b) => b.textContent.includes("Preview")).disabled).toBe(true);
  });
});
