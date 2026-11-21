// Use Cases tab — the small forms: persona, dimension, data object, and "Generate from dimensions" (dry-run preview, then
// create). All write through set_use_cases / generate_personas / delete_entity, the same tools the MCP server offers;
// a save's reference problems come back as warnings; a delete of an entry that is still referenced is refused until the human chooses
// "Delete anyway". Payload builders are exported for the tests.

import { h, icon, fill } from "./usecases-dom.js";
import { createDialog, field, textInput, textArea, selectInput, removeButton, nextId } from "./usecases-dialog.js";
import { segmented, avatar, saveErrorText } from "./usecases-parts.js";
import { KIND_ICONS } from "./usecases-world-data.js";
import { AVATAR_COLORS, AVATAR_EMOJIS, FIELD_TYPES, slugify, uniqueId, isValidId, initials, formatExampleValue, parseExampleValue, plural, formatCount } from "./usecases-data.js";

const REMOVE_NOTE = "Nothing is repaired: use cases that still name it keep a warning.";
const REFUSE_NOTE = "If something still refers to it, the delete is refused and you can review what first.";

// --- Pure payload builders --------------------------------------------------------------------------------------------

export function buildPersonaPayload({ id, draft, source }) {
  const errors = [];
  if (draft.name.trim() === "") errors.push("A name is required.");
  if (!isValidId(id)) errors.push("The id must be lowercase kebab-case (a-z, 0-9, -).");
  if (errors.length > 0) return { errors };
  const goals = draft.goals.split("\n").map((g) => g.trim()).filter(Boolean);
  const traits = Object.fromEntries(Object.entries(draft.traits).filter(([, value]) => value !== ""));
  // A colour is sent only when there is one: a persona stored without a colour stays without one until a swatch is clicked.
  const avatar = { ...(draft.emoji ? { emoji: draft.emoji } : {}), ...(draft.color ? { color: draft.color } : {}) };
  const payload = {
    id,
    name: draft.name.trim(),
    ...(draft.kind !== "" ? { kind: draft.kind } : source?.kind !== undefined ? { kind: null } : {}),
    ...(Object.keys(avatar).length > 0 || source?.avatar !== undefined ? { avatar } : {}),
    traits,
    ...(draft.role.trim() !== "" ? { role: draft.role.trim() } : source?.role !== undefined ? { role: null } : {}),
    ...(goals.length > 0 ? { goals } : source?.goals !== undefined ? { goals: null } : {}),
    ...(draft.description.trim() !== "" ? { description: draft.description.trim() } : source?.description !== undefined ? { description: null } : {}),
    ...(draft.generated ? { generated: true } : source?.generated ? { generated: null } : {}),
  };
  return { payload };
}

export function buildDimensionPayload({ id, draft, source }) {
  const errors = [];
  if (draft.name.trim() === "") errors.push("A name is required.");
  if (!isValidId(id)) errors.push("The id must be lowercase kebab-case (a-z, 0-9, -).");
  const taken = new Set();
  const values = draft.values
    .filter((v) => v.label.trim() !== "" || v.id !== "")
    .map((v) => {
      const vid = v.id || uniqueId(slugify(v.label), taken);
      taken.add(vid);
      if (!isValidId(vid)) errors.push(`The value "${v.label}" needs an id of lowercase letters, digits and dashes.`);
      return { id: vid, label: v.label.trim() || vid };
    });
  if (values.length === 0) errors.push("Add at least one value.");
  if (new Set(values.map((v) => v.id)).size !== values.length) errors.push("Two values share an id.");
  if (errors.length > 0) return { errors };
  return {
    payload: {
      id,
      name: draft.name.trim(),
      values,
      // `scope` is written when it is not the default or the dimension already stores one: a stored file never gains a key by accident.
      ...(draft.scope === "constellations" || source?.scope !== undefined ? { scope: draft.scope } : {}),
      ...(draft.description.trim() !== "" ? { description: draft.description.trim() } : source?.description !== undefined ? { description: null } : {}),
    },
  };
}

export function buildObjectPayload({ id, draft, source }) {
  const errors = [];
  if (draft.name.trim() === "") errors.push("A name is required.");
  if (!isValidId(id)) errors.push("The id must be lowercase kebab-case (a-z, 0-9, -).");
  const names = new Set();
  const fields = draft.fields
    .filter((f) => f.name.trim() !== "")
    .map((f) => {
      const name = f.name.trim();
      if (names.has(name)) errors.push(`The field ${name} appears twice.`);
      names.add(name);
      const out = { name, type: f.type };
      if (f.type === "enum") {
        const values = f.values.split(",").map((v) => v.trim()).filter(Boolean);
        if (values.length > 0) out.values = values;
      }
      if (f.type === "ref" && f.ref !== "") out.ref = f.ref;
      if (f.description) out.description = f.description;
      if (f.example.trim() !== "") out.example = parseExampleValue(f.example.trim());
      return out;
    });
  if (errors.length > 0) return { errors };
  return { payload: { id, name: draft.name.trim(), fields, ...(draft.description.trim() !== "" ? { description: draft.description.trim() } : source?.description !== undefined ? { description: null } : {}) } };
}

// --- Shared bits ------------------------------------------------------------------------------------------------------

export function footer(dialog, { saveLabel, onSave, onDelete, deleteLabel, note }) {
  const save = h("button", { type: "button", class: "chrome-btn chrome-btn--primary", onClick: onSave }, saveLabel);
  const list = [{ label: "Cancel", onClick: () => dialog.requestClose() }, save];
  if (onDelete) list.unshift(h("button", { type: "button", class: "chrome-btn uc-btn-danger uc-btn-start", onClick: onDelete }, deleteLabel), ...(note ? [note] : []));
  dialog.setActions(list);
  return save;
}

const humanize = (id) => {
  const words = String(id).replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(id);
};
/** "borrow-book" -> "Borrow book"; "borrow-book#staff-lee" -> "Borrow book, variant staff lee". */
const humanRef = (ref) => {
  const [base, variant] = ref.split("#");
  return variant ? `${humanize(base)}, variant ${variant.replace(/[-_]+/g, " ")}` : humanize(base);
};
const noun = (text, n) => text.replace(/y\(ies\)/g, n === 1 ? "y" : "ies").replace(/\(s\)/g, n === 1 ? "" : "s");

/**
 * The human sentence for a refused delete (`conflict` of delete_entity), built from the groups of the server message
 * (`<kind> "<id>" is still referenced by <n> <what>: <ids>`): "Staff lee is still used by 1 use case: Borrow book." The server message
 * itself, written for agents, is unchanged. `name` is the entry's display name; without it the id is made readable.
 */
export function refusalText(message, name) {
  const files = /failed to load: (.*?) — repair/.exec(message);
  if (message.startsWith("cannot safely delete") && files) return `The reference check is incomplete: ${files[1]} could not be read.`;
  const groups = message.split(" — ")[0].split("; ");
  const sentences = groups.map((group, index) => {
    const m = /^\S+(?: \S+)? "(.+?)" is still referenced by (\d+) (.+?): (.+)$/.exec(group);
    if (!m) return `${group.charAt(0).toUpperCase()}${group.slice(1)}.`;
    const [, id, count, what, refs] = m;
    const n = Number(count);
    const more = /, \+(\d+) more$/.exec(refs);
    const list = refs.replace(/, \+\d+ more$/, "").split(", ").map(humanRef).join(", ") + (more ? ` and ${more[1]} more` : "");
    const subject = index === 0 ? humanize(name ?? id) : "It";
    return `${subject} ${index === 0 ? "is" : "is also"} still used by ${n} ${noun(what, n)}: ${list}.`;
  });
  return sentences.join(" ");
}

/**
 * Delete with an inline confirm line in the footer. A referenced entry is refused by the server (`conflict`): the dialog then
 * lists what refers to it and offers "Delete anyway", which repeats the delete with force; without that second choice
 * `remove` is never called with force.
 */
export function confirmDeleteInline(dialog, { name, remove, done, used = "" }) {
  const finish = async (force) => {
    const response = await remove(force);
    if (!response.ok) {
      if (!force && response.code === "conflict") return offerForce(response.message);
      return dialog.setMessage(saveErrorText(response.message), "error");
    }
    dialog.setDirty(false);
    dialog.close(done(response));
  };
  const offerForce = (message) => {
    dialog.setMessage(`${refusalText(message, name)} Delete anyway leaves these references broken. ${REMOVE_NOTE}`, "warning");
    dialog.showActions([
      { label: "Keep it", autofocus: true, onClick: () => dialog.restoreActions() },
      { label: "Delete anyway", id: "delete-anyway", danger: true, onClick: () => finish(true) },
    ]);
  };
  dialog.setMessage(`Delete ${name}? ${used ? `${used} ` : ""}${REFUSE_NOTE} ${REMOVE_NOTE}`, "warning");
  dialog.showActions([
    { label: "Keep it", autofocus: true, onClick: () => dialog.restoreActions() },
    { label: `Delete ${name}`, danger: true, onClick: () => finish(false) },
  ]);
}

// --- Persona ----------------------------------------------------------------------------------------------------------

/**
 * @param {{ mode: "new" | "edit", source: Record<string, any> | null, pool: () => any, takenIds: () => Set<string>, save: (payload: Record<string, any>) => Promise<any>, remove: (id: string) => Promise<any> }} options
 * @returns {Promise<{ id: string, data: any, deleted?: boolean } | null>}
 */
export async function openPersonaDialog(options) {
  const { mode, source } = options;
  const pool = options.pool();
  const draft = {
    name: source?.name ?? "",
    role: source?.role ?? "",
    // A persona stored without a kind stays without one until the select is used; a new one starts as a human (the design's default).
    kind: source?.kind ?? (mode === "new" ? "human" : ""),
    emoji: source?.avatar?.emoji ?? (mode === "new" ? "🧑" : ""),
    // Edit mode keeps the stored colour as stored (a named colour included, "" when there is none); only a swatch click changes it.
    color: mode === "edit" ? source?.avatar?.color ?? "" : source?.avatar?.color || AVATAR_COLORS[pool.personas.length % AVATAR_COLORS.length],
    traits: { ...(source?.traits ?? {}) },
    description: source?.description ?? "",
    goals: (source?.goals ?? []).join("\n"),
    generated: Boolean(source?.generated),
  };
  const dialog = createDialog({ title: mode === "new" ? "New persona" : "Edit persona", chip: source?.id, marker: source?.generated ? "Generated" : undefined });
  let id = source?.id ?? "";
  let idTouched = mode === "edit";
  let result = null;
  const touch = () => {
    dialog.setDirty(true);
    refresh();
  };

  const avatarButton = h("button", { type: "button", class: "uc-avatar-btn", "aria-label": "Choose an emoji", "aria-expanded": "false" });
  const drawAvatar = () => avatarButton.replaceChildren(avatar({ kind: draft.emoji ? "emoji" : "initials", text: draft.emoji || initials(draft.name), color: draft.color }, "xl"));
  const picker = h("div", { class: "uc-emoji-picker", hidden: true });
  const customEmoji = textInput({ value: "", placeholder: "Or type one", ariaLabel: "Custom emoji", onInput: (value) => { if (value.trim()) { draft.emoji = [...value.trim()][0]; drawAvatar(); touch(); } } });
  picker.append(...AVATAR_EMOJIS.map((emoji) => h("button", { type: "button", class: "uc-emoji", "aria-label": emoji, onClick: () => { draft.emoji = emoji; drawAvatar(); touch(); picker.hidden = true; avatarButton.setAttribute("aria-expanded", "false"); } }, emoji)), customEmoji);
  avatarButton.addEventListener("click", () => {
    picker.hidden = !picker.hidden;
    avatarButton.setAttribute("aria-expanded", String(!picker.hidden));
  });
  const swatches = h("div", { class: "uc-swatches", role: "radiogroup", "aria-label": "Avatar colour" });
  const drawSwatches = () =>
    swatches.replaceChildren(...AVATAR_COLORS.map((color) => h("button", { type: "button", class: "uc-swatch-btn", role: "radio", "aria-checked": String(color === draft.color), "aria-label": color, style: { "--avatar-color": color }, onClick: () => { draft.color = color; drawAvatar(); drawSwatches(); touch(); } })));

  const nameInput = textInput({ value: draft.name, autofocus: true, onInput: (value) => { draft.name = value; if (!idTouched) { id = uniqueId(slugify(value), options.takenIds()); idInput.value = id; } if (!draft.emoji) drawAvatar(); touch(); } });
  const roleListId = nextId("uc-roles");
  const roles = [...new Set(pool.personas.map((p) => p.role).filter(Boolean))];
  const roleInput = textInput({ value: draft.role, list: roleListId, placeholder: "Member", onInput: (value) => { draft.role = value; touch(); } });
  const idInput = textInput({ value: id, mono: true, readonly: mode === "edit", placeholder: "derived from the name", onInput: (value) => { id = value; idTouched = true; touch(); } });
  const kindIcon = h("span", { class: "uc-kind-preview" });
  const drawKind = () => kindIcon.replaceChildren(...(KIND_ICONS[draft.kind] ? [icon(KIND_ICONS[draft.kind].icon)] : []));
  const kindSelect = selectInput({ options: [{ value: "", label: "Not stated" }, ...Object.entries(KIND_ICONS).map(([value, spec]) => ({ value, label: spec.label }))], value: draft.kind, ariaLabel: "Kind", onChange: (value) => { draft.kind = value; drawKind(); touch(); } });
  const hint = h("p", { class: "uc-hint", role: "status" });

  // Personas are described by persona-scoped dimensions; a trait on a dimension of the other scope that is already stored still shows, labelled with its scope.
  const traitRows = pool.dimensions
    .filter((dimension) => (dimension.scope ?? "personas") === "personas" || draft.traits[dimension.id] !== undefined)
    .map((dimension) => {
      const select = selectInput({ options: [{ value: "", label: "Any" }, ...dimension.values.map((v) => ({ value: v.id, label: v.label }))], value: draft.traits[dimension.id] ?? "", ariaLabel: dimension.name, onChange: (value) => { draft.traits[dimension.id] = value; touch(); } });
      return h("div", { class: "uc-trait-row" }, h("span", { class: "uc-trait-label" }, dimension.name, (dimension.scope ?? "personas") === "personas" ? null : h("span", { class: "uc-label-hint" }, " · constellations")), select);
    });
  const goalsArea = textArea({ value: draft.goals, rows: 4, placeholder: "Find a book to borrow", onInput: (value) => { draft.goals = value; touch(); } });
  const descArea = textArea({ value: draft.description, rows: 2, placeholder: "Borrows books and returns them on time.", onInput: (value) => { draft.description = value; touch(); } });
  const generatedBox = source?.generated ? h("label", { class: "uc-check" }, h("input", { type: "checkbox", checked: true, onChange: (e) => { draft.generated = e.target.checked; touch(); } }), "Mark as generated from dimensions") : null;

  function refresh() {
    const counts = {};
    for (const dimension of pool.dimensions) for (const value of dimension.values) counts[`${dimension.id}:${value.id}`] = pool.personas.filter((p) => p.id !== source?.id && p.traits?.[dimension.id] === value.id).length;
    const firsts = Object.entries(draft.traits).filter(([dimension, value]) => value !== "" && counts[`${dimension}:${value}`] === 0);
    hint.textContent = firsts.length === 0 ? "" : `First persona with ${firsts.map(([dimension, value]) => `${pool.dimensionsById.get(dimension)?.name ?? dimension} ${pool.dimensionsById.get(dimension)?.values.find((v) => v.id === value)?.label ?? value}`).join(", ")}. It fills a gap in the pool.`;
    hint.hidden = hint.textContent === "";
    const built = buildPersonaPayload({ id: id || uniqueId(slugify(draft.name), options.takenIds()), draft, source });
    saveButton.disabled = Boolean(built.errors);
    if (built.errors) dialog.setMessage(draft.name.trim() === "" && !dialog.isDirty() ? "" : built.errors[0], "error");
    else dialog.setMessage("");
  }

  async function save() {
    const finalId = id || uniqueId(slugify(draft.name), options.takenIds());
    if (mode === "new" && options.takenIds().has(finalId)) return dialog.setMessage(`The id ${finalId} is already taken.`, "error");
    const built = buildPersonaPayload({ id: finalId, draft, source });
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
      h("div", { class: "uc-persona-form-top" }, h("div", { class: "uc-avatar-edit" }, avatarButton, swatches), h("div", { class: "uc-persona-form-fields" }, h("div", { class: "uc-form-row" }, field("Name", nameInput), field("Role", roleInput), h("datalist", { id: roleListId }, roles.map((r) => h("option", { value: r })))), h("div", { class: "uc-kind-row" }, field("Kind", kindSelect, { hint: "optional, shown as an icon next to the name" }), kindIcon), field("ID", idInput, { hint: mode === "edit" ? "fixed once used" : "from the name, stable once used" }))),
      picker,
      h("div", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "Traits", h("span", { class: "uc-label-hint" }, " · leave a dimension on Any to stand for all its values")), traitRows.length === 0 ? h("p", { class: "uc-muted" }, "No dimensions yet. Add some in the Personas view to give personas traits.") : traitRows, hint),
      field("Description", descArea),
      field("Goals", goalsArea, { hint: "one per line" }),
      generatedBox,
    ),
  );
  const saveButton = footer(dialog, {
    saveLabel: mode === "new" ? "Create persona" : "Save persona",
    onSave: save,
    deleteLabel: "Delete",
    onDelete: mode === "edit" ? () => confirmDeleteInline(dialog, { name: source.name, remove: (force) => (force ? options.remove(source.id, true) : options.remove(source.id)), done: (response) => (result = { id: source.id, data: response.data, deleted: true }) }) : undefined,
  });
  drawAvatar();
  drawSwatches();
  drawKind();
  const closed = dialog.open();
  refresh();
  await closed;
  return result;
}

// --- Dimension --------------------------------------------------------------------------------------------------------

export async function openDimensionDialog(options) {
  const { mode, source } = options;
  const draft = { name: source?.name ?? "", description: source?.description ?? "", scope: source?.scope ?? "personas", values: (source?.values ?? [{ id: "", label: "" }, { id: "", label: "" }]).map((v) => ({ id: v.id, label: v.label, fixed: Boolean(v.id) })) };
  const dialog = createDialog({ title: mode === "new" ? "New dimension" : "Edit dimension", chip: source?.id });
  let id = source?.id ?? "";
  let idTouched = mode === "edit";
  let result = null;
  const touch = () => {
    dialog.setDirty(true);
    refresh();
  };
  const nameInput = textInput({ value: draft.name, autofocus: true, placeholder: "Project size", onInput: (value) => { draft.name = value; if (!idTouched) { id = uniqueId(slugify(value), options.takenIds()); idInput.value = id; } touch(); } });
  const idInput = textInput({ value: id, mono: true, readonly: mode === "edit", placeholder: "derived from the name", onInput: (value) => { id = value; idTouched = true; touch(); } });
  const descInput = textInput({ value: draft.description, onInput: (value) => { draft.description = value; touch(); } });
  const scopeControl = segmented({ label: "Describes", name: "scope", value: draft.scope, options: [{ value: "personas", label: "Personas" }, { value: "constellations", label: "Constellations" }], onChange: (value) => { draft.scope = value; touch(); } });
  const valuesBox = h("div", { class: "uc-values-edit" });
  const drawValues = (focus = null) => {
    valuesBox.replaceChildren(
      ...draft.values.map((value, index) => {
        const idSpan = h("span", { class: "uc-mono uc-muted uc-value-id" }, value.id || "—");
        return h(
          "div",
          { class: "uc-value-row" },
          textInput({ value: value.label, placeholder: "Label", ariaLabel: `Value ${index + 1} label`, onInput: (text) => { value.label = text; idSpan.textContent = (value.fixed ? value.id : slugify(text)) || "—"; touch(); } }),
          idSpan,
          removeButton(`Remove value ${index + 1}`, () => { draft.values.splice(index, 1); touch(); drawValues(); }),
        );
      }),
      h("button", { type: "button", class: "uc-link-btn", onClick: () => { draft.values.push({ id: "", label: "", fixed: false }); touch(); drawValues(draft.values.length - 1); } }, icon("add"), "Value"),
    );
    if (focus !== null) valuesBox.querySelectorAll("input")[focus]?.focus();
  };
  function refresh() {
    const built = buildDimensionPayload({ id: id || uniqueId(slugify(draft.name), options.takenIds()), draft: { ...draft, values: draft.values.map((v) => ({ id: v.fixed ? v.id : slugify(v.label), label: v.label })) }, source });
    saveButton.disabled = Boolean(built.errors);
    dialog.setMessage(built.errors && dialog.isDirty() ? built.errors[0] : "", "error");
  }
  async function save() {
    const finalId = id || uniqueId(slugify(draft.name), options.takenIds());
    if (mode === "new" && options.takenIds().has(finalId)) return dialog.setMessage(`The id ${finalId} is already taken.`, "error");
    const built = buildDimensionPayload({ id: finalId, draft: { ...draft, values: draft.values.map((v) => ({ id: v.fixed ? v.id : slugify(v.label), label: v.label })) }, source });
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
  dialog.body.append(h("div", { class: "uc-form" }, h("div", { class: "uc-form-row" }, field("Name", nameInput), field("ID", idInput, { hint: mode === "edit" ? "fixed once used" : undefined })), field("Description", descInput), field("Describes", scopeControl, { hint: "personas are people and actors, constellations are starting worlds" }), h("div", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "Values", h("span", { class: "uc-label-hint" }, " · the ways users differ along this dimension")), valuesBox)));
  const saveButton = footer(dialog, {
    saveLabel: mode === "new" ? "Create dimension" : "Save dimension",
    onSave: save,
    deleteLabel: "Delete",
    onDelete: mode === "edit" ? () => confirmDeleteInline(dialog, { name: source.name, remove: (force) => (force ? options.remove(source.id, true) : options.remove(source.id)), done: (response) => (result = { id: source.id, data: response.data, deleted: true }) }) : undefined,
  });
  drawValues();
  const closed = dialog.open();
  refresh();
  await closed;
  return result;
}

// --- Data object ------------------------------------------------------------------------------------------------------

export async function openObjectDialog(options) {
  const { mode, source } = options;
  const draft = {
    name: source?.name ?? "",
    description: source?.description ?? "",
    fields: (source?.fields ?? [{ name: "", type: "string" }]).map((f) => ({ name: f.name, type: f.type, values: (f.values ?? []).join(", "), ref: f.ref ?? "", example: f.example === undefined ? "" : formatExampleValue(f.example), description: f.description })),
  };
  const dialog = createDialog({ title: mode === "new" ? "New data object" : "Edit data object", chip: source?.id });
  let id = source?.id ?? "";
  let idTouched = mode === "edit";
  let result = null;
  const touch = () => {
    dialog.setDirty(true);
    refresh();
  };
  const nameInput = textInput({ value: draft.name, autofocus: true, placeholder: "Book", onInput: (value) => { draft.name = value; if (!idTouched) { id = uniqueId(slugify(value), options.takenIds()); idInput.value = id; } touch(); } });
  const idInput = textInput({ value: id, mono: true, readonly: mode === "edit", placeholder: "derived from the name", onInput: (value) => { id = value; idTouched = true; touch(); } });
  const descInput = textInput({ value: draft.description, onInput: (value) => { draft.description = value; touch(); } });
  const fieldsBox = h("div", { class: "uc-fields-edit" });
  const refOptions = () => [{ value: "", label: "ref to…" }, ...options.pool().objects.map((o) => ({ value: o.id, label: o.name }))];
  const drawFields = (focus = null) => {
    fieldsBox.replaceChildren(
      ...draft.fields.map((f, index) => {
        const extra = h("span", { class: "uc-field-extra" });
        const drawExtra = () => {
          fill(extra,
            f.type === "enum" ? textInput({ value: f.values, placeholder: "draft, ready", ariaLabel: `Field ${index + 1} values`, onInput: (v) => { f.values = v; touch(); } }) : null,
            f.type === "ref" ? selectInput({ options: refOptions(), value: f.ref, ariaLabel: `Field ${index + 1} ref`, onChange: (v) => { f.ref = v; touch(); } }) : null,
          );
        };
        drawExtra();
        return h(
          "div",
          { class: "uc-field-row" },
          textInput({ value: f.name, mono: true, placeholder: "field name", ariaLabel: `Field ${index + 1} name`, onInput: (v) => { f.name = v; touch(); } }),
          selectInput({ options: FIELD_TYPES.map((t) => ({ value: t, label: t })), value: f.type, ariaLabel: `Field ${index + 1} type`, onChange: (v) => { f.type = v; touch(); drawExtra(); } }),
          extra,
          textInput({ value: f.example, mono: true, placeholder: "example", ariaLabel: `Field ${index + 1} example`, onInput: (v) => { f.example = v; touch(); } }),
          removeButton(`Remove field ${index + 1}`, () => { draft.fields.splice(index, 1); touch(); drawFields(); }),
        );
      }),
      h("button", { type: "button", class: "uc-link-btn", onClick: () => { draft.fields.push({ name: "", type: "string", values: "", ref: "", example: "" }); touch(); drawFields(draft.fields.length - 1); } }, icon("add"), "Field"),
    );
    if (focus !== null) fieldsBox.querySelectorAll(".uc-field-row")[focus]?.querySelector("input")?.focus();
  };
  function refresh() {
    const built = buildObjectPayload({ id: id || uniqueId(slugify(draft.name), options.takenIds()), draft, source });
    saveButton.disabled = Boolean(built.errors);
    dialog.setMessage(built.errors && dialog.isDirty() ? built.errors[0] : "", "error");
  }
  async function save() {
    const finalId = id || uniqueId(slugify(draft.name), options.takenIds());
    if (mode === "new" && options.takenIds().has(finalId)) return dialog.setMessage(`The id ${finalId} is already taken.`, "error");
    const built = buildObjectPayload({ id: finalId, draft, source });
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
  dialog.body.append(h("div", { class: "uc-form" }, h("div", { class: "uc-form-row" }, field("Name", nameInput), field("ID", idInput, { hint: mode === "edit" ? "fixed once used" : undefined })), field("Description", descInput), h("div", { class: "uc-form-section" }, h("h2", { class: "uc-form-h" }, "Fields", h("span", { class: "uc-label-hint" }, " · name, type and an example value")), fieldsBox)));
  const saveButton = footer(dialog, {
    saveLabel: mode === "new" ? "Create data object" : "Save data object",
    onSave: save,
    deleteLabel: "Delete",
    onDelete: mode === "edit" ? () => confirmDeleteInline(dialog, { name: source.name, remove: (force) => (force ? options.remove(source.id, true) : options.remove(source.id)), done: (response) => (result = { id: source.id, data: response.data, deleted: true }) }) : undefined,
  });
  drawFields();
  const closed = dialog.open();
  refresh();
  await closed;
  return result;
}

// --- Generate from dimensions -----------------------------------------------------------------------------------------

const TARGETS = {
  personas: { noun: "persona", plural: "personas", scopeText: "traits on other dimensions are ignored", lede: "Expands your dimensions into generic personas. Existing personas that already cover a combination are skipped. Preview first: nothing is written until you create.", none: "No persona-scoped dimensions. Only persona-scoped dimensions apply here.", covered: "personas" },
  constellations: { noun: "constellation", plural: "constellations", scopeText: "only those with the scope Constellations", lede: "Expands the dimensions with the scope Constellations into starting worlds. A combination an existing constellation already covers is skipped. Nothing is written until you create.", none: "No constellation-scoped dimensions. Give a dimension the scope Constellations first.", covered: "constellations" },
};

/**
 * "Generate from dimensions": personas or constellations (the target switch), strategy, which dimensions, a limit; a dry run lists what
 * would be created before anything is written. Only the dimensions whose scope matches the target are offered.
 * @param {{ pool: () => any, generate: (input: Record<string, any>) => Promise<any>, target?: "personas" | "constellations" }} options
 * @returns {Promise<{ created: number, target: string, data: any } | null>}
 */
export async function openGenerateDialog(options) {
  const full = options.pool();
  const scoped = (target) => full.dimensions.filter((d) => (d.scope ?? "personas") === target);
  const state = { target: options.target ?? "personas", strategy: "pairwise", dimensions: new Set(), limit: "100", preview: null };
  state.dimensions = new Set(scoped(state.target).map((d) => d.id));
  const dialog = createDialog({ title: "Generate from dimensions" });
  let result = null;
  const previewBox = h("div", { class: "uc-preview", "aria-live": "polite" });
  const text = () => TARGETS[state.target];
  const invalidate = () => {
    state.preview = null;
    previewBox.replaceChildren();
    createButton.disabled = true;
    createButton.textContent = `Create ${text().plural}`;
    dialog.setMessage("");
  };
  const input = (dryRun) => ({
    strategy: state.strategy,
    ...(state.target === "constellations" ? { target: "constellations" } : {}),
    ...(state.dimensions.size < scoped(state.target).length ? { dimensions: [...state.dimensions] } : {}),
    limit: Math.max(1, Math.min(5000, Number.parseInt(state.limit, 10) || 100)),
    ...(dryRun ? { dry_run: true } : {}),
  });

  const targetControl = segmented({ label: "Generate", name: "target", value: state.target, options: [{ value: "personas", label: "Personas" }, { value: "constellations", label: "Constellations" }], onChange: (value) => { state.target = value; state.dimensions = new Set(scoped(value).map((d) => d.id)); drawDimensions(); invalidate(); } });
  const lede = h("p", { class: "uc-page-lede" });
  const strategy = segmented({ label: "Strategy", name: "strategy", value: state.strategy, options: [{ value: "pairwise", label: "Pairwise (recommended)" }, { value: "all", label: "All combinations" }], onChange: (value) => { state.strategy = value; invalidate(); } });
  const limit = textInput({ value: state.limit, ariaLabel: "Limit", onInput: (value) => { state.limit = value; invalidate(); } });
  limit.type = "number";
  limit.min = "1";
  limit.max = "5000";
  const dims = h("div", { class: "uc-gen-dims" });
  const dimsField = h("div", { class: "uc-field" });
  const drawDimensions = () => {
    const list = scoped(state.target);
    const other = full.dimensions.filter((d) => !list.includes(d));
    fill(
      dims,
      ...list.map((d) => h("label", { class: "uc-check" }, h("input", { type: "checkbox", checked: true, onChange: (e) => { if (e.target.checked) state.dimensions.add(d.id); else state.dimensions.delete(d.id); invalidate(); previewButton.disabled = state.dimensions.size === 0; } }), `${d.name} (${d.values.length})`)),
      list.length === 0 ? h("p", { class: "uc-muted", role: "status" }, text().none) : null,
      other.length > 0 ? h("p", { class: "uc-form-note" }, `${other.map((d) => d.name).join(", ")} ${other.length === 1 ? "has" : "have"} the scope ${state.target === "personas" ? "Constellations" : "Personas"} and ${other.length === 1 ? "is" : "are"} not offered here.`) : null,
    );
    fill(dimsField, h("span", { class: "uc-label" }, "Dimensions", h("span", { class: "uc-label-hint" }, ` · ${text().scopeText}`)), dims);
    lede.textContent = text().lede;
    previewButton.disabled = state.dimensions.size === 0;
  };
  const previewButton = h("button", { type: "button", class: "chrome-btn", onClick: runPreview }, icon("visibility"), "Preview");
  const createButton = h("button", { type: "button", class: "chrome-btn chrome-btn--primary", disabled: true, onClick: create }, "Create personas");

  async function runPreview() {
    previewButton.disabled = true;
    dialog.setMessage("Working out the combinations…");
    const response = await options.generate(input(true));
    previewButton.disabled = state.dimensions.size === 0;
    if (!response.ok) return dialog.setMessage(saveErrorText(response.message), "error");
    const data = response.data;
    state.preview = data;
    dialog.setMessage("");
    const list = data.constellations ?? data.personas ?? [];
    const noun = text();
    fill(
      previewBox,
      h("p", { class: "uc-preview-summary" }, h("strong", null, `${formatCount(data.would_create ?? 0)} would be created`), ` · ${formatCount(data.total ?? 0)} ${data.strategy === "all" ? "combinations" : "value pairs"} in total · ${formatCount(data.skipped_covered ?? 0)} already covered by existing ${noun.covered}${data.truncated ? " · cut off by the limit" : ""}`),
      data.partial ? h("p", { class: "uc-field-warn", role: "status" }, (data.warnings ?? []).find((w) => w.kind === "partial_result")?.message ?? "This is only part of the full result: narrow the dimensions and preview again.") : null,
      list.length === 0 ? h("p", { class: "uc-muted" }, "Nothing to create: every combination is already covered.") : h("ul", { class: "uc-preview-list" }, list.slice(0, 12).map((p) => h("li", null, h("span", { class: "uc-preview-name" }, p.name), h("span", { class: "uc-muted uc-mono" }, Object.entries(p.traits ?? {}).map(([k, v]) => `${k}=${v}`).join(" ")))), list.length > 12 ? h("li", { class: "uc-muted" }, `… and ${formatCount((data.would_create ?? list.length) - 12)} more`) : null),
      state.target === "constellations" && list.length > 0 ? h("p", { class: "uc-form-note" }, icon("info"), "Generated constellations start without relationships. Add them in each constellation.") : null,
    );
    createButton.disabled = (data.would_create ?? list.length) === 0;
    createButton.textContent = `Create ${plural(data.would_create ?? list.length, noun.noun)}`;
  }

  async function create() {
    createButton.disabled = true;
    const response = await options.generate(input(false));
    if (!response.ok) {
      createButton.disabled = false;
      return dialog.setMessage(saveErrorText(response.message), "error");
    }
    result = { created: response.data.created ?? 0, target: state.target, data: response.data };
    dialog.close(result);
  }

  dialog.body.append(h("div", { class: "uc-form" }, field("Generate", targetControl), lede, field("Strategy", strategy), dimsField, field("Limit", limit, { hint: "at most 5,000" }), h("div", { class: "uc-gen-preview-row" }, previewButton), previewBox));
  dialog.setActions([{ label: "Close", onClick: () => dialog.close(null) }, createButton]);
  drawDimensions();
  invalidate();
  const closed = dialog.open();
  await closed;
  return result;
}
