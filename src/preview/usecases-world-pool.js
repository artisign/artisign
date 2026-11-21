// Use Cases tab — the World pool (ADR-011, design usecases-world / usecases-world-empty): entities, relationship types and
// constellations from GET /api/world, each section with its New button and each entry opening its dialog (CHR-1154).

import { h, icon } from "./usecases-dom.js";
import { traitChip } from "./usecases-parts.js";
import { entityAvatar } from "./usecases-world-parts.js";
import { initials, plural } from "./usecases-data.js";
import { constellationMembers } from "./usecases-world-data.js";
import { hiddenNote } from "./usecases-orphans.js";

/**
 * An entity's data object. One the pool no longer has is marked as missing; that is only said while the pool has data objects at all
 * (the tool raises it only while data-objects.json exists, and the preview cannot tell an absent file from an empty list otherwise).
 */
function objectCell(entity, pool) {
  if (entity.object === undefined) return none();
  if (pool.objectsById?.size > 0 && !pool.objectsById.has(entity.object)) {
    return h("span", { class: "uc-orphan-note", dataset: { orphan: "entity_object" }, title: "This data object no longer exists" }, entity.object, icon("warning"), hiddenNote("this data object no longer exists"));
  }
  return entity.object;
}

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
  return h("span", { class: "uc-cst-traits" }, entries.map(([dimension, value]) => traitChip(dimensionOf(pool, dimension)?.name ?? dimension, dimensionOf(pool, dimension)?.values.find((v) => v.id === value)?.label ?? value)));
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

function section(part, sub, body, ...actions) {
  const meta = WORLD_PARTS.find((p) => p.id === part);
  return h("section", { class: "uc-section", id: `uc-world-${part}`, "aria-labelledby": `uc-world-${part}-h` }, h("div", { class: "uc-h2-row" }, h("h2", { class: "uc-h2", id: `uc-world-${part}-h` }, meta.label, h("span", { class: "uc-h2-meta" }, sub)), h("span", { class: "uc-map-spacer" }), ...actions), body);
}

const newButton = (label, onClick) => h("button", { type: "button", class: "chrome-btn", onClick }, label);
/** An entry's name as the button that opens its dialog. */
const editName = (text, label, onClick) => h("button", { type: "button", class: "uc-link-row", "aria-label": `Edit ${label} ${text}`, onClick }, text);

/** The page: the empty guide for an empty world, else the three sections. */
export function renderWorldPage(root, { world, pool, selected, error = "", handlers }) {
  if (error) {
    root.replaceChildren(h("div", { class: "uc-guide" }, h("h1", { class: "uc-guide-title" }, "The world could not be read"), h("p", { class: "uc-warn", role: "alert" }, error), h("p", { class: "uc-guide-lede" }, "Fix usecases/world.json or ask your agent to rewrite it.")));
    return;
  }
  if (isWorldEmpty(world)) {
    root.replaceChildren(
      h(
        "div",
        { class: "uc-guide" },
        h("h1", { class: "uc-guide-title" }, "Describe the world your use cases start in"),
        h("p", { class: "uc-guide-lede" }, "The world is optional. Add it when a case depends on what exists before its first step: a child on the policy, who is whose parent, which household the case plays in. Use cases keep working without it."),
        h(
          "ol",
          { class: "uc-guide-steps" },
          h("li", null, h("span", { class: "uc-guide-num" }, "1"), h("div", null, h("p", null, "Add the things that are not actors, such as a child or a policy."), h("div", { class: "uc-guide-actions" }, h("button", { type: "button", class: "chrome-btn", onClick: () => handlers.onNewEntity() }, icon("add"), "New entity")))),
          h("li", null, h("span", { class: "uc-guide-num" }, "2"), h("div", null, h("p", null, "Name how participants relate to each other."), h("div", { class: "uc-guide-actions" }, h("button", { type: "button", class: "chrome-btn", onClick: () => handlers.onNewRelationshipType() }, icon("add"), "New relationship type")))),
          h("li", null, h("span", { class: "uc-guide-num" }, "3"), h("div", null, h("p", null, "Group personas and entities into constellations, by hand or from dimensions that describe constellations."), h("div", { class: "uc-guide-actions" }, h("button", { type: "button", class: "chrome-btn", onClick: () => handlers.onNewConstellation() }, icon("add"), "New constellation"), h("button", { type: "button", class: "chrome-btn chrome-btn--ghost", onClick: () => handlers.onGenerate() }, "Generate constellations")))),
        ),
        h("p", { class: "uc-guide-lede uc-world-guide-note" }, "Ask your agent to create them with set_use_cases."),
      ),
    );
    return;
  }
  const entities = world.entities.map((e) =>
    h(
      "tr",
      { dataset: { id: e.id } },
      h("th", { scope: "row" }, h("span", { class: "uc-subject" }, entityAvatar({ text: e.avatar?.emoji || initials(e.name) }, "sm", e.name), editName(e.name, "entity", () => handlers.onEditEntity(e.id)))),
      h("td", null, e.type ?? none()),
      h("td", { class: "uc-mono" }, e.id),
      h("td", null, traits(pool, e.traits)),
      h("td", { class: "uc-mono" }, objectCell(e, pool)),
    ),
  );
  const types = world.relationship_types.map((t) =>
    h(
      "tr",
      { dataset: { id: t.id } },
      h("th", { scope: "row" }, editName(t.label, "relationship type", () => handlers.onEditRelationshipType(t.id))),
      h("td", null, t.inverse_label ?? none()),
      h("td", { class: "uc-mono" }, t.id),
      h("td", null, (t.same_traits ?? []).length > 0 ? h("span", { class: "uc-cst-traits" }, t.same_traits.map((id) => h("span", { class: "uc-trait" }, h("span", { class: "uc-trait-value uc-world-share" }, dimensionOf(pool, id)?.name ?? id)))) : none()),
      h("td", { class: "uc-mono" }, t.field ? `${t.field.object}.${t.field.name}` : none()),
    ),
  );
  const nameOf = (id) => world.entities.find((e) => e.id === id)?.name ?? pool.personasById.get(id)?.name ?? id;
  const cards = world.constellations.map((c) => {
    const members = constellationMembers(c).map(nameOf);
    return h(
      "article",
      { class: `uc-cst${c.generated ? " is-generated" : ""}`, dataset: { constellation: c.id } },
      h("header", { class: "uc-cst-head" }, h("h3", { class: "uc-cst-name" }, editName(c.name, "constellation", () => handlers.onEditConstellation(c.id)), c.generated ? h("span", { class: "uc-chip uc-world-generated" }, "Generated") : null), Object.keys(c.traits ?? {}).length > 0 ? traits(pool, c.traits) : h("span", { class: "uc-muted" }, "No traits")),
      h("p", { class: "uc-muted uc-world-card-sub" }, c.relationships.length === 0 ? "No relationships yet. Add them to give the world its members." : `${plural(c.relationships.length, "relationship")} · ${members.join(", ")}`),
    );
  });
  root.replaceChildren(
    h(
      "div",
      { class: "uc-world-page", dataset: { selected } },
      section("entities", "Things in the domain that are not actors: a child, a policy", world.entities.length > 0 ? table("Entities", ["Name", "Type", "ID", "Traits", "Data object"], entities) : h("p", { class: "uc-muted" }, "No entities yet."), newButton("New entity", () => handlers.onNewEntity())),
      section("relationship_types", "Read from left to right: Maria is parent of Leo", world.relationship_types.length > 0 ? table("Relationship types", ["Label", "Inverse label", "ID", "Both ends share", "Data field"], types) : h("p", { class: "uc-muted" }, "No relationship types yet."), newButton("New relationship type", () => handlers.onNewRelationshipType())),
      section("constellations", "Starting worlds. Members come from the relationship ends.", cards.length > 0 ? h("div", { class: "uc-cst-grid" }, cards) : h("p", { class: "uc-muted" }, "No constellations yet."), newButton("Generate…", () => handlers.onGenerate()), newButton("New constellation", () => handlers.onNewConstellation())),
    ),
  );
}
