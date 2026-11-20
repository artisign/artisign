// Use Cases tab — the row editors of the world model dialogs (CHR-1154): condition rows (a state trigger, a branch's `when`),
// starting-state rows (a case, and a variant that merges into it, with unset), and the subject select they share. Every row is a
// `role="group"` with a numbered name; hints sit under the field they belong to and are listed in `aria-describedby` only while
// shown (see showFieldErrors). The models are the drafts of usecases-world-edit.js, edited in place.

import { h, icon, fill } from "./usecases-dom.js";
import { textInput, selectInput, removeButton, nextId } from "./usecases-dialog.js";
import { openMenu } from "./usecases-menu.js";
import { touchScope } from "./usecases-variant-edit.js";
import { CONDITION_WORDS, CONDITION_SYMBOLS, VALUE_HELP, blankCondition, blankState } from "./usecases-world-edit.js";

/** The world pool of a pool view (entities of GET /api/world); an older pool without one reads as empty. */
export const entitiesOf = (pool) => pool.world?.entities ?? [];

/** What an id names: a persona, an entity, the system, else the id itself. */
export function participantName(pool, id) {
  if (id === "system") return "System";
  return pool.personasById?.get(id)?.name ?? entitiesOf(pool).find((e) => e.id === id)?.name ?? id;
}

/** The subjects a state or condition can name: the system, the personas (a generated one only when it is the current value), the entities. An unknown stored id stays selectable under its own id. */
export function participantOptions(pool, current = "") {
  const personas = pool.personas.filter((p) => !p.generated || p.id === current).map((p) => ({ value: p.id, label: p.name }));
  const entities = entitiesOf(pool).filter((e) => !pool.personasById.has(e.id)).map((e) => ({ value: e.id, label: e.name }));
  const options = [{ value: "", label: "Subject…" }, { value: "system", label: "System" }, ...personas, ...entities];
  if (current !== "" && !options.some((o) => o.value === current)) options.push({ value: current, label: current });
  return options;
}

export function participantSelect({ pool, value, ariaLabel, onChange }) {
  return selectInput({ options: participantOptions(pool, value), value, ariaLabel, onChange });
}

const hint = (path) => h("p", { class: "uc-field-error", id: nextId("uc-err"), hidden: true, dataset: { path } });
const warn = (path) => h("p", { class: "uc-field-warn", id: nextId("uc-warn"), hidden: true, dataset: { path } });

/** Marks a field as the owner of an error path and links it to its hint. */
function bind(field, path, hintEl) {
  field.dataset.errorPath = path;
  field.dataset.hint = hintEl.id;
  return field;
}

/**
 * Condition rows: subject, property, operator (as words), value. A row is one condition; all must hold. "is one of" takes a comma list.
 * @param {{ rows: any[], pool: () => any, path: string, label: string, markDirty: () => void, refresh: () => void, legend?: boolean }} spec
 */
export function conditionRows({ rows, pool, path, label, markDirty, refresh, legend = true }) {
  const box = h("div", { class: "uc-cond-rows" });
  const redraw = (focusLast = false) => {
    fill(
      box,
      ...rows.map((row, j) => {
        const at = () => rows.indexOf(row);
        const p = (suffix = "") => `${path}.${at()}${suffix}`;
        const rowHint = hint(p());
        const valueHint = hint(p(".value"));
        const subjectWarn = warn(p(".subject"));
        const subject = participantSelect({ pool: pool(), value: row.subject, ariaLabel: `${label} ${j + 1} subject`, onChange: (value) => { row.subject = value; markDirty(); } });
        const property = bind(textInput({ value: row.property, mono: true, placeholder: "premium-change", ariaLabel: `${label} ${j + 1} property`, onInput: (value) => { row.property = value; markDirty(); } }), p(), rowHint);
        const op = selectInput({ options: CONDITION_WORDS, value: row.op, ariaLabel: `${label} ${j + 1} operator`, onChange: (value) => { row.op = value; valueInput.placeholder = value === "in" ? "draft, ready" : "0.15"; markDirty(); } });
        const valueInput = bind(textInput({ value: row.value, mono: true, placeholder: row.op === "in" ? "draft, ready" : "0.15", ariaLabel: `${label} ${j + 1} value`, onInput: (value) => { row.value = value; markDirty(); } }), p(".value"), valueHint);
        subject.dataset.path = p(".subject");
        const group = h("div", { class: "uc-cond-row", role: "group", "aria-label": `${label} ${j + 1}` }, h("div", { class: "uc-cond-fields" }, subject, property, op, valueInput, removeButton(`Remove ${label.toLowerCase()} ${j + 1}`, () => { rows.splice(at(), 1); markDirty(); redraw(); })), rowHint, valueHint, subjectWarn);
        touchScope(group, row, refresh);
        return group;
      }),
      h("div", { class: "uc-cond-foot" }, h("button", { type: "button", class: "uc-link-btn", onClick: () => { rows.push(blankCondition()); markDirty(); redraw(true); } }, icon("add"), "Add condition"), h("span", { class: "uc-form-note" }, "Conditions are documentation. artisign checks the subjects, it never evaluates the values.")),
      legend ? operatorLegend() : null,
    );
    if (focusLast) [...box.querySelectorAll(".uc-cond-row")].at(-1)?.querySelector("select")?.focus();
    if (ready) refresh();
  };
  let ready = false; // the first draw happens while the dialog is still being built: its warning pass is not ready yet
  redraw();
  ready = true;
  return { el: box, redraw };
}

/** The operator words with the symbols the detail view shows for them, and the value rule. */
export function operatorLegend() {
  return h(
    "div",
    { class: "uc-op-legend" },
    h("p", { class: "uc-op-legend-title" }, "Operator list and how the detail shows each one"),
    h("dl", { class: "uc-op-legend-list" }, CONDITION_WORDS.flatMap((w) => [h("dt", null, w.label), h("dd", null, CONDITION_SYMBOLS[w.value])])),
    h("p", { class: "uc-form-note" }, `${VALUE_HELP} "Is one of" takes a comma-separated list, each item read the same way. The words are the select labels and the accessible names of the symbols.`),
  );
}

const iconButton = (label, name, onClick) => h("button", { type: "button", class: "chrome-icon-btn chrome-icon-btn--sm", "aria-label": label, title: label, onClick }, icon(name));

/**
 * Starting-state rows of a case: subject, property, value. A repeated (subject, property) is an error on the second row.
 * With `baseRows` it is a variant's list: a row that names a key of the base shows "base <value>" with a reset and an Unset switch,
 * any other row is "new"; entries of the base the variant does not touch collapse into one "From base" line with Override.
 * The annotations follow the typing in place (no redraw), so focus never moves under the user.
 * @param {{ rows: any[], baseRows?: () => any[], pool: () => any, path: string, label: string, markDirty: () => void, refresh: () => void }} spec
 */
export function stateRows({ rows, baseRows = null, pool, path, label, markDirty, refresh }) {
  const box = h("div", { class: `uc-state-rows${baseRows ? " is-variant" : ""}` });
  const keyOf = (row) => (row.property.trim() === "" ? null : `${row.subject}\u0000${row.property.trim()}`);
  const baseOf = (row) => (baseRows && keyOf(row) ? baseRows().find((b) => keyOf(b) === keyOf(row)) : undefined);
  const inherited = h("div", { class: "uc-inherited" });
  const paintInherited = () => {
    if (!baseRows) return;
    const taken = new Set(rows.map(keyOf));
    const left = baseRows().filter((b) => keyOf(b) && !taken.has(keyOf(b)));
    fill(
      inherited,
      h("span", { class: "uc-inherited-from" }, "From base"),
      h("span", { class: "uc-inherited-value" }, left.length === 0 ? "nothing left to override" : left.map((b) => `${participantName(pool(), b.subject)} ${b.property} ${b.value}`).join(" · ")),
      h("button", { type: "button", class: "chrome-btn chrome-btn--ghost chrome-btn--compact", disabled: left.length === 0, "aria-haspopup": "menu", onClick: (event) => openMenu({ anchor: event.currentTarget, label: "Override a base entry", items: left.map((b, i) => ({ value: String(i), label: `${participantName(pool(), b.subject)} · ${b.property} · ${b.value}` })), onPick: (value) => { const b = left[Number(value)]; rows.push({ subject: b.subject, property: b.property, value: b.value, unset: false, orig: undefined, origText: undefined }); markDirty(); redraw(true); } }) }, "Override"),
    );
  };
  const redraw = (focusLast = false) => {
    const children = rows.map((row, j) => {
      const at = () => rows.indexOf(row);
      const p = (suffix = "") => `${path}.${at()}${suffix}`;
      const rowHint = hint(p());
      const propertyHint = hint(p(".property"));
      const valueHint = hint(p(".value"));
      const unknown = warn(p(".subject"));
      const missing = warn(p());
      const note = h("span", { class: "uc-state-note" });
      const rowEl = h("div", { class: "uc-state-row", role: "group", "aria-label": `${label} ${j + 1}` });
      const paintNote = () => {
        if (!baseRows) return;
        const base = baseOf(row);
        rowEl.dataset.kind = row.unset ? "unset" : base ? "changed" : "added";
        fill(note, base ? h("span", null, "base ", h("s", null, base.value)) : h("span", { class: "uc-state-new" }, "new"), base && !row.unset ? h("button", { type: "button", class: "uc-link-btn", onClick: () => { row.unset = true; markDirty(); redraw(); } }, "Unset") : null);
        paintInherited();
      };
      const subject = participantSelect({ pool: pool(), value: row.subject, ariaLabel: `${label} ${j + 1} subject`, onChange: (value) => { row.subject = value; markDirty(); paintNote(); } });
      subject.dataset.path = p(".subject");
      const property = bind(textInput({ value: row.property, mono: true, placeholder: "premium", ariaLabel: `${label} ${j + 1} property`, onInput: (value) => { row.property = value; markDirty(); paintNote(); } }), p(".property"), propertyHint);
      const valueInput = bind(textInput({ value: row.value, mono: true, placeholder: "120", ariaLabel: `${label} ${j + 1} value`, onInput: (value) => { row.value = value; markDirty(); } }), p(".value"), valueHint);
      const unsetBox = h("label", { class: "uc-unset" }, h("input", { type: "checkbox", checked: true, onChange: () => { row.unset = false; if (row.value === "") row.value = baseOf(row)?.value ?? ""; markDirty(); redraw(); } }), "Unset in this variant");
      const removeLabel = baseOf(row) ? `Reset ${label.toLowerCase()} ${j + 1} to base` : `Remove ${label.toLowerCase()} ${j + 1}`;
      rowEl.append(h("div", { class: "uc-state-fields" }, subject, property, row.unset ? unsetBox : valueInput, note, iconButton(removeLabel, baseOf(row) ? "undo" : "close", () => { rows.splice(at(), 1); markDirty(); redraw(); })), rowHint, propertyHint, valueHint, unknown, missing);
      paintNote();
      touchScope(rowEl, row, refresh);
      return rowEl;
    });
    fill(
      box,
      ...children,
      baseRows ? inherited : null,
      h(
        "div",
        { class: "uc-cond-foot" },
        h("button", { type: "button", class: "uc-link-btn", onClick: () => { rows.push(blankState()); markDirty(); redraw(true); } }, icon("add"), baseRows ? "Add or override state" : "Add state"),
        h("span", { class: "uc-form-note" }, baseRows ? "Unset removes a base entry. It needs a key the base has. Values are read as in the base: true or false, a number, or text." : `${VALUE_HELP} artisign stores the value, it never evaluates it.`),
      ),
    );
    paintInherited();
    if (focusLast) [...box.querySelectorAll(".uc-state-row")].at(-1)?.querySelector("select")?.focus();
    if (ready) refresh();
  };
  let ready = false;
  redraw();
  ready = true;
  return { el: box, redraw, paintInherited };
}
