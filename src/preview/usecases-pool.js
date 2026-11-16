// Use Cases tab — the persona pool and the data objects: left lists and the main pages (dimensions table, persona cards,
// data-object cards). Personas may number in the thousands (generate_personas), so cards and list rows are shown in
// growing pages ("Show more"), never all at once.

import { h, icon } from "./usecases-dom.js";
import { avatar, traitChip } from "./usecases-parts.js";
import { avatarOf, matchesPersonaQuery, traitCounts, plural, formatCount, fieldTypeLabel, formatValue } from "./usecases-data.js";

export const CARD_PAGE = 24;
export const LIST_PAGE = 60;

function usageLine(persona, usage) {
  if (!usage) return "";
  const n = usage.get(persona.id);
  if (n === undefined) return usage.complete ? "Not used in any use case yet" : "";
  return `In ${plural(n, "use case")}`;
}

/** The left list of the personas section: search + "Written by people" / "Generated from dimensions". */
export function renderPersonaList(el, { pool, query, selectedId, limit, handlers }) {
  const personas = pool.personas.filter((p) => matchesPersonaQuery(p, query));
  const written = personas.filter((p) => !p.generated);
  const generated = personas.filter((p) => p.generated);
  const budget = { left: limit };
  const group = (title, list) => {
    if (list.length === 0) return null;
    const shown = list.slice(0, Math.max(0, budget.left));
    budget.left -= shown.length;
    return h(
      "div",
      { class: "uc-plist-group" },
      h("h3", { class: "uc-plist-title" }, `${title} · ${formatCount(list.length)}`),
      shown.map((p) =>
        h("button", { type: "button", class: `uc-plist-row${p.id === selectedId ? " is-selected" : ""}`, onClick: () => handlers.onSelect(p.id) }, avatar(avatarOf(p.id, pool.personasById), "sm"), h("span", { class: "uc-plist-name" }, p.name), p.role ? h("span", { class: "uc-plist-role" }, p.role) : null),
      ),
      shown.length < list.length ? h("button", { type: "button", class: "uc-link-btn", onClick: handlers.onMore }, `Show ${formatCount(list.length - shown.length)} more`) : null,
    );
  };
  el.replaceChildren(
    ...[
      group("Written by people", written),
      group("Generated from dimensions", generated),
      personas.length === 0 ? h("p", { class: "uc-list-status" }, pool.personas.length === 0 ? "No personas yet." : "No persona matches.") : null,
    ].filter(Boolean),
  );
  return { total: personas.length };
}

function personaCard(persona, pool, usage, handlers, selected) {
  const av = avatarOf(persona.id, pool.personasById);
  const traits = Object.entries(persona.traits ?? {}).map(([dimension, value]) => {
    const dim = pool.dimensionsById.get(dimension);
    return traitChip(dim?.label ?? dimension, dim?.values.find((v) => v.id === value)?.label ?? value);
  });
  const open = pool.dimensions.filter((d) => !(d.id in (persona.traits ?? {}))).slice(0, 4).map((d) => traitChip(d.label, "any", true));
  return h(
    "article",
    { class: `uc-persona-card${persona.generated ? " is-generated" : ""}${selected ? " is-selected" : ""}`, dataset: { persona: persona.id } },
    h(
      "button",
      { type: "button", class: "uc-persona-open", "aria-label": `Edit ${persona.name}`, onClick: () => handlers.onEdit(persona.id) },
      h("div", { class: "uc-persona-head" }, avatar(av, "lg"), h("div", { class: "uc-persona-id" }, h("span", { class: "uc-persona-name" }, persona.name), h("span", { class: "uc-persona-role" }, [persona.role, persona.id].filter(Boolean).join(" · "))), persona.generated ? h("span", { class: "uc-generated", title: "Generated from dimensions" }, icon("auto_awesome"), "Generated") : null),
      h("div", { class: "uc-persona-traits" }, traits.length === 0 ? h("span", { class: "uc-trait is-any" }, "no traits — stands for anyone") : traits, open),
      h("p", { class: "uc-persona-goals" }, (persona.goals ?? []).length > 0 ? persona.goals.join(" · ") : persona.description && !persona.generated ? persona.description : h("span", { class: "uc-muted" }, persona.generated ? "No goals yet. Ask your agent to fill them in, or edit by hand." : "No goals yet.")),
      h("div", { class: "uc-persona-usage" }, usageLine(persona, usage) || " "),
    ),
  );
}

/** Main page of the personas section: header with the two actions, the dimensions table and the persona cards. */
export function renderPersonaPage(el, { pool, query, selectedId, limit, usage, handlers }) {
  const counts = traitCounts(pool.dimensions, pool.personas);
  const personas = pool.personas.filter((p) => matchesPersonaQuery(p, query));
  const generatedCount = pool.personas.filter((p) => p.generated).length;
  const shown = personas.slice(0, limit);

  const dimensions = pool.dimensions.map((dimension) => {
    const open = pool.personas.filter((p) => !(dimension.id in (p.traits ?? {})));
    return h(
      "div",
      { class: "uc-dim-row", dataset: { dimension: dimension.id } },
      h("div", { class: "uc-dim-id" }, h("button", { type: "button", class: "uc-dim-name", onClick: () => handlers.onEditDimension(dimension.id), title: "Edit dimension" }, dimension.label), h("span", { class: "uc-mono uc-muted" }, dimension.id)),
      h(
        "div",
        { class: "uc-dim-values" },
        dimension.values.map((value) => {
          const n = counts[dimension.id][value.id];
          return h("span", { class: n === 0 ? "uc-value-chip is-empty" : "uc-value-chip" }, value.label, h("span", { class: "uc-value-count" }, String(n)));
        }),
        dimension.values.some((v) => counts[dimension.id][v.id] === 0) ? h("span", { class: "uc-warn-text" }, "No persona has this value") : null,
        open.length > 0 && pool.personas.length > 0 ? h("span", { class: "uc-muted uc-dim-note" }, `${plural(open.length, "persona")} ${open.length === 1 ? "leaves" : "leave"} it open (any value)`) : null,
      ),
    );
  });

  el.replaceChildren(
    h(
      "div",
      { class: "uc-page" },
      h(
        "header",
        { class: "uc-page-head" },
        h("div", null, h("h1", { class: "uc-page-title" }, "User pool"), h("p", { class: "uc-page-lede" }, "Dimensions are the ways your users differ. Personas pick one value per dimension. A trait left open means any value, so one persona can stand for a whole group.")),
        h("div", { class: "uc-actions" }, h("button", { type: "button", class: "chrome-btn", onClick: handlers.onGenerate, disabled: pool.dimensions.length === 0, title: pool.dimensions.length === 0 ? "Add a dimension first" : "" }, icon("auto_awesome"), "Generate from dimensions"), h("button", { type: "button", class: "chrome-btn chrome-btn--primary", onClick: () => handlers.onNew() }, icon("person_add"), "New persona")),
      ),
      h("section", { class: "uc-section" }, h("h2", { class: "uc-h2" }, "Dimensions", h("span", { class: "uc-h2-meta" }, "The number on each value counts the personas that have it"), h("button", { type: "button", class: "uc-link-btn uc-h2-action", onClick: () => handlers.onEditDimension(null) }, icon("add"), "Dimension")), pool.dimensions.length === 0 ? h("p", { class: "uc-muted" }, "No dimensions yet. Add one (for example Project size or Actor type) to describe how your users differ.") : h("div", { class: "uc-dim-table" }, dimensions)),
      h(
        "section",
        { class: "uc-section" },
        h("h2", { class: "uc-h2" }, "Personas", h("span", { class: "uc-h2-meta" }, `${formatCount(pool.personas.length)}${generatedCount > 0 ? ` · ${formatCount(generatedCount)} generated` : ""}${query ? ` · ${formatCount(personas.length)} match` : ""}`)),
        h("div", { class: "uc-persona-grid" }, shown.map((p) => personaCard(p, pool, usage, handlers, p.id === selectedId)), query === "" ? h("button", { type: "button", class: "uc-persona-new", onClick: () => handlers.onNew() }, icon("person_add"), "New persona") : null),
        shown.length < personas.length ? h("button", { type: "button", class: "chrome-btn uc-show-more", onClick: handlers.onMore }, `Show ${formatCount(Math.min(CARD_PAGE * 2, personas.length - shown.length))} more of ${formatCount(personas.length - shown.length)}`) : null,
      ),
    ),
  );
}

// --- Data objects --------------------------------------------------------------------------------------------------

export function renderObjectList(el, { pool, query, selectedId, handlers }) {
  const needle = query.trim().toLowerCase();
  const objects = pool.objects.filter((o) => needle === "" || `${o.id} ${o.name} ${o.description ?? ""} ${o.fields.map((f) => f.name).join(" ")}`.toLowerCase().includes(needle));
  el.replaceChildren(
    objects.length === 0
      ? h("p", { class: "uc-list-status" }, pool.objects.length === 0 ? "No data objects yet." : "No data object matches.")
      : h("div", { class: "uc-plist-group" }, objects.map((o) => h("button", { type: "button", class: `uc-plist-row${o.id === selectedId ? " is-selected" : ""}`, onClick: () => handlers.onSelect(o.id) }, icon("data_object", "uc-plist-icon"), h("span", { class: "uc-plist-name" }, o.name), h("span", { class: "uc-plist-role" }, plural(o.fields.length, "field"))))),
  );
}

export function renderObjectPage(el, { pool, query, selectedId, handlers }) {
  const needle = query.trim().toLowerCase();
  const objects = pool.objects.filter((o) => needle === "" || `${o.id} ${o.name} ${o.description ?? ""} ${o.fields.map((f) => f.name).join(" ")}`.toLowerCase().includes(needle));
  const cards = objects.map((object) =>
    h(
      "article",
      { class: `uc-io-card uc-object-card${object.id === selectedId ? " is-selected" : ""}`, dataset: { object: object.id } },
      h("div", { class: "uc-io-head" }, h("span", { class: "uc-io-name" }, object.name), h("span", { class: "uc-io-id" }, object.id), h("button", { type: "button", class: "chrome-icon-btn chrome-icon-btn--sm uc-io-pencil", "aria-label": `Edit ${object.name}`, title: "Edit data object", onClick: () => handlers.onEdit(object.id) }, icon("edit"))),
      object.description ? h("p", { class: "uc-object-desc" }, object.description) : null,
      h(
        "table",
        { class: "uc-table" },
        h("thead", null, h("tr", null, h("th", null, "Field"), h("th", null, "Type"), h("th", null, "Example"))),
        h("tbody", null, object.fields.length === 0 ? h("tr", null, h("td", { colspan: "3", class: "uc-muted" }, "No fields yet.")) : object.fields.map((field) => h("tr", null, h("td", { class: "uc-mono" }, field.name), h("td", { class: "uc-muted uc-mono" }, fieldTypeLabel(field)), h("td", { class: "uc-mono" }, field.example === undefined ? "—" : formatValue(field.example))))),
      ),
    ),
  );
  el.replaceChildren(
    h(
      "div",
      { class: "uc-page" },
      h("header", { class: "uc-page-head" }, h("div", null, h("h1", { class: "uc-page-title" }, "Data objects"), h("p", { class: "uc-page-lede" }, "Reusable shapes of the data your use cases read and write. Inputs, outputs and before/after cards refer to them by id.")), h("div", { class: "uc-actions" }, h("button", { type: "button", class: "chrome-btn chrome-btn--primary", onClick: () => handlers.onNew() }, icon("add"), "New data object"))),
      cards.length === 0 ? h("p", { class: "uc-muted" }, pool.objects.length === 0 ? "No data objects yet. Define one for each kind of data your flows touch." : "No data object matches.") : h("div", { class: "uc-object-grid" }, cards),
    ),
  );
}
