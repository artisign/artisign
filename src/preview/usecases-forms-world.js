// Use Cases tab — the dialogs of the world pool (ADR-011, CHR-1154): main entities, relationship types and constellations. All write
// through set_use_cases and delete through delete_entity (the fixed wrappers of usecases-api.js). A shape error blocks Save; a
// reference problem (an unknown participant, a relationship of a participant with itself) is a warning and never does.

import { h, icon, fill } from "./usecases-dom.js";
import { createDialog, field, textInput, textArea, selectInput, removeButton, nextId } from "./usecases-dialog.js";
import { avatar, saveErrorText } from "./usecases-parts.js";
import { entityAvatar } from "./usecases-world-parts.js";
import { footer, confirmDeleteInline } from "./usecases-forms-pool.js";
import { participantName, participantOptions, entitiesOf } from "./usecases-forms-rows.js";
import { showFieldErrors, touchScope } from "./usecases-variant-edit.js";
import { buildEntityPayload, buildRelationshipTypePayload, buildConstellationPayload, relationshipDraft, draftMembers, participantWarning } from "./usecases-world-edit.js";
import { AVATAR_EMOJIS, slugify, uniqueId, initials, plural, avatarOf } from "./usecases-data.js";

/** Dimension rows for a trait editor: constellation-scoped first, then the others labelled with their scope (a stored trait of any dimension stays). */
function traitRows(pool, traits, onChange) {
  const dims = [...pool.dimensions].sort((a, b) => Number((a.scope ?? "personas") === "personas") - Number((b.scope ?? "personas") === "personas"));
  if (dims.length === 0) return [h("p", { class: "uc-muted" }, "No dimensions yet. Add some in the Personas view to give entities traits.")];
  return dims.map((dimension) => {
    const select = selectInput({ options: [{ value: "", label: "Any" }, ...dimension.values.map((v) => ({ value: v.id, label: v.label }))], value: traits[dimension.id] ?? "", ariaLabel: dimension.name, onChange: (value) => { traits[dimension.id] = value; onChange(); } });
    return h("div", { class: "uc-trait-row" }, h("span", { class: "uc-trait-label" }, dimension.name, (dimension.scope ?? "personas") === "constellations" ? null : h("span", { class: "uc-label-hint" }, " · personas")), select);
  });
}

const infoNote = (text) => h("span", { class: "uc-foot-note" }, text);

// --- Entity -----------------------------------------------------------------------------------------------------------

/**
 * @param {{ mode: "new" | "edit", source: Record<string, any> | null, pool: () => any, takenIds: () => Set<string>, save: (payload: Record<string, any>) => Promise<any>, remove: (id: string) => Promise<any>, usage?: (id: string) => Promise<string> }} options
 * @returns {Promise<{ id: string, data: any, deleted?: boolean } | null>}
 */
export async function openEntityDialog(options) {
  const { mode, source } = options;
  const pool = options.pool();
  const draft = { name: source?.name ?? "", type: source?.type ?? "", description: source?.description ?? "", emoji: source?.avatar?.emoji ?? "", traits: { ...(source?.traits ?? {}) }, object: source?.object ?? "" };
  const dialog = createDialog({ title: mode === "new" ? "New entity" : "Edit entity" });
  let id = source?.id ?? "";
  let idTouched = mode === "edit";
  let result = null;
  const touch = () => {
    dialog.setDirty(true);
    refresh();
  };
  const avatarButton = h("button", { type: "button", class: "uc-avatar-btn uc-entity-avatar-btn", "aria-label": "Choose an emoji", "aria-expanded": "false" });
  const drawAvatar = () => avatarButton.replaceChildren(entityAvatar({ text: draft.emoji || initials(draft.name) || "·" }, "md", draft.name));
  const picker = h("div", { class: "uc-emoji-picker", hidden: true });
  picker.append(...AVATAR_EMOJIS.map((emoji) => h("button", { type: "button", class: "uc-emoji", "aria-label": emoji, onClick: () => { draft.emoji = emoji; drawAvatar(); touch(); picker.hidden = true; avatarButton.setAttribute("aria-expanded", "false"); } }, emoji)));
  avatarButton.addEventListener("click", () => {
    picker.hidden = !picker.hidden;
    avatarButton.setAttribute("aria-expanded", String(!picker.hidden));
  });
  const nameInput = textInput({ value: draft.name, autofocus: true, placeholder: "Leo", onInput: (value) => { draft.name = value; if (!idTouched) { id = uniqueId(slugify(value), options.takenIds()); idInput.value = id; } if (!draft.emoji) drawAvatar(); touch(); } });
  const typeInput = textInput({ value: draft.type, placeholder: "Child", onInput: (value) => { draft.type = value; touch(); } });
  const idInput = textInput({ value: id, mono: true, readonly: mode === "edit", placeholder: "derived from the name", onInput: (value) => { id = value; idTouched = true; touch(); } });
  const idHint = h("p", { class: "uc-field-warn", role: "status", hidden: true });
  const descArea = textArea({ value: draft.description, rows: 2, placeholder: "Maria's son, co-insured on the household policy until he turns 18.", onInput: (value) => { draft.description = value; touch(); } });
  const objects = pool.objects ?? [];
  const objectSelect = selectInput({ options: [{ value: "", label: "None" }, ...objects.map((o) => ({ value: o.id, label: o.name }))], value: draft.object, ariaLabel: "Data object", onChange: (value) => { draft.object = value; touch(); } });
  objectSelect.disabled = objects.length === 0 && draft.object === "";

  function refresh() {
    const finalId = id || uniqueId(slugify(draft.name), options.takenIds());
    const built = buildEntityPayload({ id: finalId, draft, source });
    saveButton.disabled = Boolean(built.errors);
    const shared = pool.personasById?.has(finalId);
    idHint.hidden = !shared;
    idHint.textContent = shared ? `A persona has the id ${finalId}. A reference to it resolves to the persona. Pick another id to keep the two apart.` : "";
    dialog.setMessage(built.errors && (dialog.isDirty() || finalId === "system") ? built.errors[0] : "", "error");
  }
  async function save() {
    const finalId = id || uniqueId(slugify(draft.name), options.takenIds());
    if (mode === "new" && options.takenIds().has(finalId)) return dialog.setMessage(`The id ${finalId} is already taken.`, "error");
    const built = buildEntityPayload({ id: finalId, draft, source });
    if (built.errors) return;
    saveButton.disabled = true;
    const response = await options.save(built.payload);
    if (!response.ok) {
      saveButton.disabled = false;
      return dialog.setMessage(saveErrorText(response.message), "error");
    }
    result = { id: finalId, data: response.data };
    dialog.setDirty(false);
    dialog.close(result);
  }
  dialog.body.append(
    h(
      "div",
      { class: "uc-form" },
      h("div", { class: "uc-entity-top" }, avatarButton, h("div", { class: "uc-entity-fields" }, h("div", { class: "uc-form-row" }, field("Name", nameInput), field("Type", typeInput, { hint: "free text" })))),
      picker,
      field("ID", idInput, { hint: 'shared with personas: one id names one participant; "system" is reserved' }),
      idHint,
      field("Description", descArea),
      h("div", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "Traits", h("span", { class: "uc-label-hint" }, " · optional")), ...traitRows(pool, draft.traits, touch)),
      field("Data object", objectSelect, { hint: "optional, refines the entity once a data model exists" }),
    ),
  );
  const saveButton = footer(dialog, {
    saveLabel: mode === "new" ? "Create entity" : "Save entity",
    onSave: save,
    deleteLabel: "Delete",
    onDelete: mode === "edit" ? async () => confirmDeleteInline(dialog, { name: source.name, used: await (options.usage?.(source.id) ?? ""), remove: (force) => (force ? options.remove(source.id, true) : options.remove(source.id)), done: (response) => (result = { id: source.id, data: response.data, deleted: true }) }) : undefined,
  });
  if (mode === "edit") {
    // Where the entity is used, under its fields: a member of constellations, a subject in use cases.
    const members = pool.world?.constellations?.filter((c) => draftMembers(c.relationships).includes(source.id)).length ?? 0;
    const note = h("p", { class: "uc-form-note uc-entity-usage" }, icon("hub"), `${members > 0 ? `A member of ${plural(members, "constellation")}` : "In no constellation"}`);
    dialog.body.querySelector(".uc-form").append(note);
    options.usage?.(source.id).then((text) => text && note.append(` · ${text.replace(/\.$/, "").toLowerCase()}`));
  }
  drawAvatar();
  const closed = dialog.open();
  refresh();
  await closed;
  return result;
}

// --- Relationship type ------------------------------------------------------------------------------------------------

export async function openRelationshipTypeDialog(options) {
  const { mode, source } = options;
  const pool = options.pool();
  const draft = {
    label: source?.label ?? "",
    inverse: source?.inverse_label ?? "",
    description: source?.description ?? "",
    sameTraits: [...(source?.same_traits ?? [])],
    fieldObject: source?.field?.object ?? "",
    fieldName: source?.field?.name ?? "",
  };
  const dialog = createDialog({ title: mode === "new" ? "New relationship type" : "Edit relationship type" });
  let id = source?.id ?? "";
  let idTouched = mode === "edit";
  let result = null;
  const touch = () => {
    dialog.setDirty(true);
    refresh();
  };
  const labelInput = textInput({ value: draft.label, autofocus: true, placeholder: "is parent of", onInput: (value) => { draft.label = value; if (!idTouched) { id = uniqueId(slugify(value), options.takenIds()); idInput.value = id; } drawReads(); touch(); } });
  const inverseInput = textInput({ value: draft.inverse, placeholder: "is child of", onInput: (value) => { draft.inverse = value; drawReads(); touch(); } });
  const idInput = textInput({ value: id, mono: true, readonly: mode === "edit", placeholder: "derived from the label", onInput: (value) => { id = value; idTouched = true; touch(); } });
  const descArea = textArea({ value: draft.description, rows: 2, placeholder: "A parent who can act for the child on the policy.", onInput: (value) => { draft.description = value; touch(); } });

  // "Reads as": the label read left to right, with two participants of the pool as the example.
  const reads = h("div", { class: "uc-reads", role: "group", "aria-label": "Reads as" });
  const sample = () => {
    // A persona and an entity of the pool read best ("Maria is parent of Leo"); fewer of either falls back to what there is.
    const names = [pool.personas[0]?.name, entitiesOf(pool)[0]?.name, pool.personas[1]?.name].filter(Boolean);
    return [names[0] ?? "A", names[1] ?? "B"];
  };
  const readLine = (from, text, to) => h("p", { class: "uc-reads-line" }, h("strong", null, from), h("span", { class: "uc-reads-type" }, h("span", { "aria-hidden": "true" }, "—"), text, icon("arrow_forward")), h("strong", null, to));
  const drawReads = () => {
    const [a, b] = sample();
    fill(reads, h("span", { class: "uc-label-hint" }, "Reads as"), draft.label.trim() !== "" ? readLine(a, draft.label.trim(), b) : h("p", { class: "uc-muted" }, "Type a label to see how it reads."), draft.inverse.trim() !== "" ? readLine(b, draft.inverse.trim(), a) : null);
  };

  const shareBox = h("div", { class: "uc-share-row" }, pool.dimensions.map((d) => h("label", { class: "uc-check" }, h("input", { type: "checkbox", checked: draft.sameTraits.includes(d.id), onChange: (e) => { draft.sameTraits = e.target.checked ? [...draft.sameTraits, d.id] : draft.sameTraits.filter((x) => x !== d.id); touch(); } }), d.name)));
  const objects = pool.objects ?? [];
  const fieldsOf = (objectId) => (pool.objectsById?.get(objectId)?.fields ?? []).filter((f) => f.type === "ref" || f.type === "list");
  const objectSelect = selectInput({ options: [{ value: "", label: objects.length === 0 ? "No data object" : "No data object" }, ...objects.map((o) => ({ value: o.id, label: o.name }))], value: draft.fieldObject, ariaLabel: "Data object of the field", onChange: (value) => { draft.fieldObject = value; draft.fieldName = ""; drawField(); touch(); } });
  const fieldSelect = h("select", { class: "chrome-field uc-select", "aria-label": "Field" });
  const drawField = () => {
    fill(fieldSelect, h("option", { value: "" }, "Field"), ...fieldsOf(draft.fieldObject).map((f) => h("option", { value: f.name }, f.name)), draft.fieldName !== "" && !fieldsOf(draft.fieldObject).some((f) => f.name === draft.fieldName) ? h("option", { value: draft.fieldName }, `${draft.fieldName} (unknown)`) : null);
    fieldSelect.value = draft.fieldName;
    fieldSelect.disabled = draft.fieldObject === "";
  };
  fieldSelect.addEventListener("change", () => {
    draft.fieldName = fieldSelect.value;
    touch();
  });
  objectSelect.disabled = objects.length === 0 && draft.fieldObject === "";

  function refresh() {
    const built = buildRelationshipTypePayload({ id: id || uniqueId(slugify(draft.label), options.takenIds()), draft, source });
    saveButton.disabled = Boolean(built.errors);
    dialog.setMessage(built.errors && dialog.isDirty() ? built.errors[0] : "", "error");
  }
  async function save() {
    const finalId = id || uniqueId(slugify(draft.label), options.takenIds());
    if (mode === "new" && options.takenIds().has(finalId)) return dialog.setMessage(`The id ${finalId} is already taken.`, "error");
    const built = buildRelationshipTypePayload({ id: finalId, draft, source });
    if (built.errors) return;
    saveButton.disabled = true;
    const response = await options.save(built.payload);
    if (!response.ok) {
      saveButton.disabled = false;
      return dialog.setMessage(saveErrorText(response.message), "error");
    }
    result = { id: finalId, data: response.data };
    dialog.setDirty(false);
    dialog.close(result);
  }
  dialog.body.append(
    h(
      "div",
      { class: "uc-form" },
      h("div", { class: "uc-form-row" }, field("Label", labelInput), field("Inverse label", inverseInput, { hint: "optional, never derived" })),
      field("ID", idInput, { hint: mode === "edit" ? "fixed once used" : undefined }),
      reads,
      field("Description", descArea),
      h("div", { class: "uc-field" }, h("span", { class: "uc-label" }, "Both ends share"), pool.dimensions.length === 0 ? h("p", { class: "uc-muted" }, "No dimensions yet.") : shareBox, h("p", { class: "uc-form-note" }, "A constellation warns when the two ends have different values for a shared dimension.")),
      h("div", { class: "uc-field" }, h("span", { class: "uc-label" }, "Data field", h("span", { class: "uc-label-hint" }, " · optional, the field that stores this relationship")), h("div", { class: "uc-form-row" }, objectSelect, fieldSelect)),
    ),
  );
  const usedIn = pool.world?.constellations?.filter((c) => c.relationships.some((r) => r.type === source?.id)).length ?? 0;
  const saveButton = footer(dialog, {
    saveLabel: mode === "new" ? "Create relationship type" : "Save relationship type",
    onSave: save,
    deleteLabel: "Delete",
    note: mode === "edit" ? infoNote(usedIn > 0 ? `Used in ${plural(usedIn, "constellation")}` : "Used in no constellation") : undefined,
    onDelete: mode === "edit" ? () => confirmDeleteInline(dialog, { name: source.label, used: usedIn > 0 ? `Used in ${plural(usedIn, "constellation")}.` : "", remove: (force) => (force ? options.remove(source.id, true) : options.remove(source.id)), done: (response) => (result = { id: source.id, data: response.data, deleted: true }) }) : undefined,
  });
  drawReads();
  drawField();
  const closed = dialog.open();
  refresh();
  await closed;
  return result;
}

// --- Constellation ----------------------------------------------------------------------------------------------------

/** The participants a relationship end can name (no `system`): personas (a generated one only when it is the current value), entities. */
const endOptions = (pool, current) => participantOptions(pool, current).filter((o) => o.value !== "system").map((o) => (o.value === "" ? { value: "", label: "Participant…" } : o));

/** Warnings of one relationship row (never blocking): an end that is no participant, an end that relates to itself, a type the pool lacks. */
export function relationshipWarnings(row, pool, typesById) {
  const ends = { personasById: pool.personasById ?? new Map(), entitiesById: new Map(entitiesOf(pool).map((e) => [e.id, e])) };
  const warnings = [];
  for (const side of ["from", "to"]) {
    const text = participantWarning(row[side], ends).replace("or pick another subject.", "or pick a participant from the list.");
    if (text) warnings.push({ path: side, message: text });
  }
  if (row.from !== "" && row.from === row.to) warnings.push({ path: "to", message: `${participantName(pool, row.from)} ${typesById.get(row.type)?.label ?? row.type} ${participantName(pool, row.to)}: a relationship needs two different participants.` });
  if (row.type !== "" && !typesById.has(row.type)) warnings.push({ path: "type", message: `${row.type} is not a relationship type of the world. Create it in World or pick another one.` });
  return warnings;
}

export async function openConstellationDialog(options) {
  const { mode, source } = options;
  const pool = options.pool();
  const types = () => options.pool().world?.relationship_types ?? [];
  const typesById = () => new Map(types().map((t) => [t.id, t]));
  const draft = {
    name: source?.name ?? "",
    description: source?.description ?? "",
    traits: { ...(source?.traits ?? {}) },
    relationships: (source?.relationships ?? []).map(relationshipDraft),
    generated: Boolean(source?.generated),
  };
  const dialog = createDialog({ title: mode === "new" ? "New constellation" : "Edit constellation", wide: true, marker: source?.generated ? "Generated" : undefined });
  let id = source?.id ?? "";
  let idTouched = mode === "edit";
  let result = null;
  let ready = false;
  const touch = () => {
    dialog.setDirty(true);
    refresh();
  };
  const nameInput = textInput({ value: draft.name, autofocus: true, placeholder: "Two parents, one co-insured child", onInput: (value) => { draft.name = value; if (!idTouched) { id = uniqueId(slugify(value), options.takenIds()); idInput.value = id; } touch(); } });
  const idInput = textInput({ value: id, mono: true, readonly: mode === "edit", placeholder: "derived from the name", onInput: (value) => { id = value; idTouched = true; touch(); } });
  const descInput = textInput({ value: draft.description, placeholder: "Both parents live together, the teenage son is co-insured.", onInput: (value) => { draft.description = value; touch(); } });

  // Traits: constellation dimensions first; a stored trait of any dimension stays.
  const traitsBox = h("div", { class: "uc-cst-trait-grid" });
  const dims = [...pool.dimensions].sort((a, b) => Number((a.scope ?? "personas") === "personas") - Number((b.scope ?? "personas") === "personas"));
  const traitList = dims.filter((d) => (d.scope ?? "personas") === "constellations" || draft.traits[d.id] !== undefined);
  fill(
    traitsBox,
    ...traitList.map((dimension) => {
      const select = selectInput({ options: [{ value: "", label: "Any" }, ...dimension.values.map((v) => ({ value: v.id, label: v.label }))], value: draft.traits[dimension.id] ?? "", ariaLabel: dimension.name, onChange: (value) => { draft.traits[dimension.id] = value; touch(); } });
      return h("div", { class: "uc-trait-row" }, h("span", { class: "uc-trait-label" }, dimension.name, (dimension.scope ?? "personas") === "constellations" ? null : h("span", { class: "uc-label-hint" }, " · personas")), select);
    }),
  );

  // Relationships.
  const relBox = h("div", { class: "uc-rel-rows" });
  const members = h("div", { class: "uc-rel-members" });
  const drawMembers = () => {
    const ids = draftMembers(draft.relationships);
    fill(
      members,
      h("span", { class: "uc-label-hint" }, "Members, from the relationship ends"),
      ids.length === 0 ? h("span", { class: "uc-muted" }, "None yet") : ids.map((memberId) => {
        const persona = pool.personasById?.get(memberId);
        const entity = entitiesOf(pool).find((e) => e.id === memberId);
        const art = persona ? avatar(avatarOf(memberId, pool.personasById), "sm", persona.name) : entity ? entityAvatar({ text: entity.avatar?.emoji || initials(entity.name) }, "sm", entity.name) : null;
        return h("span", { class: `uc-participant${persona || entity ? "" : " is-unknown"}` }, art, h("span", { class: persona || entity ? "uc-participant-name" : "uc-mono" }, persona?.name ?? entity?.name ?? memberId));
      }),
    );
  };
  const drawRelationships = (focusLast = false) => {
    fill(
      relBox,
      h("div", { class: "uc-rel-head", "aria-hidden": "true" }, h("span", null, "From"), h("span", null, "Relationship"), h("span", null, "To"), h("span", null, "Note", h("span", { class: "uc-label-hint" }, " · optional")), h("span")),
      ...draft.relationships.map((row, j) => {
        const at = () => draft.relationships.indexOf(row);
        const rowHint = h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path: `relationship.${j}` } });
        const warn = h("p", { class: "uc-field-warn", hidden: true, dataset: { path: `relationship.${j}.warn` } });
        const typeOptions = () => [{ value: "", label: "Type…" }, ...types().map((t) => ({ value: t.id, label: t.label })), ...(row.type !== "" && !typesById().has(row.type) ? [{ value: row.type, label: row.type }] : [])];
        const fromSel = selectInput({ options: endOptions(pool, row.from), value: row.from, ariaLabel: `Relationship ${j + 1} from`, onChange: (value) => { row.from = value; touch(); drawMembers(); } });
        const typeSel = selectInput({ options: typeOptions(), value: row.type, ariaLabel: `Relationship ${j + 1} type`, onChange: (value) => { row.type = value; touch(); } });
        const toSel = selectInput({ options: endOptions(pool, row.to), value: row.to, ariaLabel: `Relationship ${j + 1} to`, className: "uc-rel-to", onChange: (value) => { row.to = value; touch(); drawMembers(); } });
        for (const sel of [fromSel, typeSel, toSel]) sel.addEventListener("change", () => (sel.dataset.tooltip = sel.selectedOptions[0]?.textContent ?? ""));
        const note = textInput({ value: row.note, placeholder: "Note", ariaLabel: `Relationship ${j + 1} note`, onInput: (value) => { row.note = value; touch(); } });
        const rowEl = h(
          "div",
          { class: "uc-rel-row", role: "group", "aria-label": `Relationship ${j + 1}` },
          h("div", { class: "uc-rel-fields" }, fromSel, typeSel, toSel, note, removeButton(`Remove relationship ${j + 1}`, () => { draft.relationships.splice(at(), 1); touch(); drawRelationships(); drawMembers(); })),
          rowHint,
          warn,
        );
        for (const sel of [fromSel, typeSel, toSel]) sel.dataset.tooltip = sel.selectedOptions[0]?.textContent ?? "";
        fromSel.dataset.warnPath = `relationship.${j}.warn`;
        rowEl.dataset.row = String(j);
        touchScope(rowEl, row, () => refresh());
        return rowEl;
      }),
      h("button", { type: "button", class: "uc-link-btn", onClick: () => { draft.relationships.push({ from: "", type: "", to: "", note: "" }); touch(); drawRelationships(true); drawMembers(); } }, icon("add"), "Add relationship"),
    );
    if (focusLast) [...relBox.querySelectorAll(".uc-rel-row")].at(-1)?.querySelector("select")?.focus();
    if (ready) refresh();
  };

  function refresh() {
    if (!ready) return;
    const finalId = id || uniqueId(slugify(draft.name), options.takenIds());
    const built = buildConstellationPayload({ id: finalId, draft, source });
    showFieldErrors(dialog.body, built.fieldErrors ?? []);
    const warnings = [];
    draft.relationships.forEach((row, j) => {
      const found = relationshipWarnings(row, options.pool(), typesById());
      const el = relBox.querySelectorAll(".uc-field-warn")[j];
      if (el) {
        el.hidden = found.length === 0;
        el.textContent = found.map((w) => w.message).join(" ");
      }
      warnings.push(...found);
    });
    saveButton.disabled = Boolean(built.errors);
    dialog.setMessage(built.errors ? (dialog.isDirty() ? built.errors[0] : "") : warnings.length > 0 ? `${plural(warnings.length, "warning")} · you can save anyway` : "", built.errors ? "error" : "warning");
  }
  async function save() {
    const finalId = id || uniqueId(slugify(draft.name), options.takenIds());
    if (mode === "new" && options.takenIds().has(finalId)) return dialog.setMessage(`The id ${finalId} is already taken.`, "error");
    const built = buildConstellationPayload({ id: finalId, draft, source });
    if (built.errors) return;
    saveButton.disabled = true;
    const response = await options.save(built.payload);
    if (!response.ok) {
      saveButton.disabled = false;
      return dialog.setMessage(saveErrorText(response.message), "error");
    }
    result = { id: finalId, data: response.data };
    dialog.setDirty(false);
    dialog.close(result);
  }

  dialog.body.append(
    h(
      "div",
      { class: "uc-form" },
      h("div", { class: "uc-form-row" }, field("Name", nameInput), field("ID", idInput, { hint: mode === "edit" ? "fixed once used" : undefined })),
      field("Description", descInput),
      h("div", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "Traits", h("span", { class: "uc-label-hint" }, " · constellation dimensions first; a stored trait of any dimension stays")), traitList.length === 0 ? h("p", { class: "uc-muted" }, "No constellation dimensions yet. Give a dimension the scope Constellations to describe starting worlds with it.") : traitsBox),
      h("div", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "Relationships", h("span", { class: "uc-label-hint" }, " · from, type, to; read left to right")), relBox, members),
    ),
  );
  const usage = infoNote("");
  const saveButton = footer(dialog, {
    saveLabel: mode === "new" ? "Create constellation" : "Save constellation",
    onSave: save,
    deleteLabel: "Delete",
    note: mode === "edit" ? usage : undefined,
    onDelete: mode === "edit" ? async () => confirmDeleteInline(dialog, { name: source.name, used: await (options.usage?.(source.id) ?? ""), remove: (force) => (force ? options.remove(source.id, true) : options.remove(source.id)), done: (response) => (result = { id: source.id, data: response.data, deleted: true }) }) : undefined,
  });
  if (mode === "edit") options.usage?.(source.id).then((text) => (usage.textContent = text.replace(/\.$/, "")));
  drawRelationships();
  drawMembers();
  const closed = dialog.open();
  ready = true;
  refresh();
  await closed;
  return result;
}
