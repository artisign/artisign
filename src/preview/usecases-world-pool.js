// Use Cases tab — the World pool as a read view (ADR-011, design usecases-world / usecases-world-empty): entities, relationship
// types and constellations from GET /api/world. The editors (new / edit / delete / generate) are CHR-1154 and not drawn here.

import { h } from "./usecases-dom.js";
import { traitChip } from "./usecases-parts.js";
import { entityAvatar } from "./usecases-world-parts.js";
import { initials, plural } from "./usecases-data.js";
import { constellationMembers } from "./usecases-world-data.js";

export const WORLD_PARTS = [
  { id: "entities", label: "Entities", hint: "things with identity" },
  { id: "relationship_types", label: "Relationship types", hint: "how participants relate" },
  { id: "constellations", label: "Constellations", hint: "starting worlds" },
];

const none = () => h("span", { class: "uc-muted" }, "None");
const dimensionOf = (pool, id) => pool.dimensionsById.get(id);

function traits(pool, map) {
  const entries = Object.entries(map ?? {});
  if (entries.length === 0) return none();
  return h("span", { class: "uc-cst-traits" }, entries.map(([dimension, value]) => traitChip(dimensionOf(pool, dimension)?.label ?? dimension, dimensionOf(pool, dimension)?.values.find((v) => v.id === value)?.label ?? value)));
}

export const isWorldEmpty = (world) => world.entities.length + world.relationship_types.length + world.constellations.length === 0;

/** The left panel: the three parts with their counts. */
export function renderWorldNav(el, { world, selected, onSelect }) {
  el.replaceChildren(
    ...WORLD_PARTS.map((part) =>
      h(
        "button",
        { type: "button", class: `uc-world-nav-item${selected === part.id ? " is-selected" : ""}`, "aria-pressed": selected === part.id ? "true" : "false", dataset: { part: part.id }, onClick: () => onSelect(part.id) },
        h("span", { class: "uc-world-nav-name" }, part.label),
        h("span", { class: "uc-world-nav-hint" }, `${world[part.id].length} · ${part.hint}`),
      ),
    ),
    h("p", { class: "uc-world-nav-note" }, "The world works without a data model. An entity or a relationship type can point at a data object later."),
  );
}

function table(label, columns, rows) {
  return h("div", { class: "uc-state-wrap uc-world-table", role: "region", "aria-label": label, tabindex: "0" }, h("table", { class: "uc-state" }, h("thead", null, h("tr", null, columns.map((c) => h("th", { scope: "col" }, c)))), h("tbody", null, rows)));
}

function section(part, sub, body) {
  const meta = WORLD_PARTS.find((p) => p.id === part);
  return h("section", { class: "uc-section", id: `uc-world-${part}`, "aria-labelledby": `uc-world-${part}-h` }, h("div", { class: "uc-h2-row" }, h("h2", { class: "uc-h2", id: `uc-world-${part}-h` }, meta.label, h("span", { class: "uc-h2-meta" }, sub))), body);
}

/** The page: the empty guide for an empty world, else the three sections. */
export function renderWorldPage(root, { world, pool, selected }) {
  if (isWorldEmpty(world)) {
    root.replaceChildren(
      h(
        "div",
        { class: "uc-guide" },
        h("h1", { class: "uc-guide-title" }, "Describe the world your use cases start in"),
        h("p", { class: "uc-guide-lede" }, "The world is optional. Add it when a case depends on what exists before its first step: a child on the policy, who is whose parent, which household the case plays in. Use cases keep working without it."),
        h("ol", { class: "uc-world-steps" }, h("li", null, "Add the things that are not actors, such as a child or a policy."), h("li", null, "Name how participants relate to each other."), h("li", null, "Group personas and entities into constellations, by hand or from dimensions that describe constellations.")),
        h("p", { class: "uc-muted" }, "Ask your agent to create them with set_use_cases."),
      ),
    );
    return;
  }
  const entities = world.entities.map((e) =>
    h(
      "tr",
      { dataset: { id: e.id } },
      h("th", { scope: "row" }, h("span", { class: "uc-subject" }, entityAvatar({ text: e.avatar?.emoji || initials(e.name) }, "sm", e.name), e.name)),
      h("td", null, e.type ?? none()),
      h("td", { class: "uc-mono" }, e.id),
      h("td", null, traits(pool, e.traits)),
      h("td", { class: "uc-mono" }, e.object ?? none()),
    ),
  );
  const types = world.relationship_types.map((t) =>
    h(
      "tr",
      { dataset: { id: t.id } },
      h("th", { scope: "row" }, t.label),
      h("td", null, t.inverse_label ?? none()),
      h("td", { class: "uc-mono" }, t.id),
      h("td", null, (t.same_traits ?? []).length > 0 ? h("span", { class: "uc-cst-traits" }, t.same_traits.map((id) => h("span", { class: "uc-trait" }, h("span", { class: "uc-trait-value uc-world-share" }, dimensionOf(pool, id)?.label ?? id)))) : none()),
      h("td", { class: "uc-mono" }, t.field ? `${t.field.object}.${t.field.name}` : none()),
    ),
  );
  const nameOf = (id) => world.entities.find((e) => e.id === id)?.name ?? pool.personasById.get(id)?.name ?? id;
  const cards = world.constellations.map((c) => {
    const members = constellationMembers(c).map(nameOf);
    return h(
      "article",
      { class: `uc-cst${c.generated ? " is-generated" : ""}`, dataset: { constellation: c.id } },
      h("header", { class: "uc-cst-head" }, h("h3", { class: "uc-cst-name" }, c.name, c.generated ? h("span", { class: "uc-chip uc-world-generated" }, "Generated") : null), Object.keys(c.traits ?? {}).length > 0 ? traits(pool, c.traits) : h("span", { class: "uc-muted" }, "No traits")),
      h("p", { class: "uc-muted uc-world-card-sub" }, c.relationships.length === 0 ? "No relationships yet. Add them to give the world its members." : `${plural(c.relationships.length, "relationship")} · ${members.join(", ")}`),
    );
  });
  root.replaceChildren(
    h(
      "div",
      { class: "uc-world-page", dataset: { selected } },
      section("entities", "Things in the domain that are not actors: a child, a policy", world.entities.length > 0 ? table("Entities", ["Name", "Type", "ID", "Traits", "Data object"], entities) : h("p", { class: "uc-muted" }, "No entities yet.")),
      section("relationship_types", "Read from left to right: Maria is parent of Leo", world.relationship_types.length > 0 ? table("Relationship types", ["Label", "Inverse label", "ID", "Both ends share", "Data field"], types) : h("p", { class: "uc-muted" }, "No relationship types yet.")),
      section("constellations", "Starting worlds. Members come from the relationship ends.", cards.length > 0 ? h("div", { class: "uc-cst-grid" }, cards) : h("p", { class: "uc-muted" }, "No constellations yet.")),
    ),
  );
}
