// Use Cases tab — pure logic (no DOM, no fetch): list queries, the group tree and its flattening for the
// virtual list, the variant difference against the base, the coverage matrix, example text round-trips and
// the id helpers. Everything the DOM modules need to decide lives here so it is unit-testable; the shapes
// are the ones documented in the use-case spec.

/** Spec maturity only (ADR-010): there is no priority and no "implemented". */
export const STATUSES = ["draft", "ready"];
export const STATUS_LABELS = { draft: "Draft", ready: "Ready" };
/** What list_use_cases can sort by (no "recently changed": the case files carry no timestamp the tool reports). */
export const SORTS = [
  { id: "group", label: "Group A–Z" },
  { id: "title", label: "Title" },
  { id: "status", label: "Status" },
];

export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ID_MAX = 80;
export const FIELD_TYPES = ["string", "number", "boolean", "date", "datetime", "enum", "ref", "list", "object"];
export const AVATAR_COLORS = ["#4F7CAC", "#B05C8A", "#6E8B3D", "#C27A3A", "#7B5EA7", "#8A7F6B"];
export const AVATAR_EMOJIS = ["👨", "👩", "🧑", "👵", "👴", "🧒", "👧", "👦", "🧓", "🧑‍💼", "🧑‍🔧", "🧑‍🎓"];

// --- Ids and text ---------------------------------------------------------------------------------------------

/** The text of a trigger, whichever form it has: a stored string, or the object `get_use_case` always returns. */
export function triggerText(trigger) {
  if (trigger === undefined || trigger === null) return "";
  return typeof trigger === "string" ? trigger : (trigger.text ?? "");
}

/** A comparable form of a trigger: a string and its object form `{ text }` are the same trigger. */
export function triggerKey(trigger) {
  if (trigger === undefined || trigger === null) return "";
  const t = typeof trigger === "string" ? { text: trigger } : trigger;
  return JSON.stringify([t.text ?? "", t.actor ?? null, t.via ?? null, t.at ?? null, t.state ?? null]);
}

/**
 * The trigger to store after the text was edited. A stored structured trigger keeps actor / via / state / at and only its
 * text changes (never overwritten by a string); an untouched trigger is written back exactly as stored.
 */
export function triggerWithText(stored, text, original) {
  if (stored !== null && typeof stored === "object") return text === original ? stored : { ...stored, text };
  return text;
}

/** Lowercase kebab-case id from free text ("Map a Step!" -> "map-a-step"); "" when nothing usable is left. */
export function slugify(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ID_MAX)
    .replace(/-+$/g, "");
}

export function isValidId(id) {
  return typeof id === "string" && id.length <= ID_MAX && ID_RE.test(id);
}

/** `base`, or `base-2`, `base-3`… — the first one not in `taken` (a Set or array). */
export function uniqueId(base, taken) {
  const used = taken instanceof Set ? taken : new Set(taken);
  if (base === "" || !used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, ID_MAX - String(n).length - 1)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function formatCount(count) {
  return Number(count).toLocaleString("en-US");
}

export function plural(count, one, many = `${one}s`) {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

export function initials(name) {
  const words = String(name ?? "")
    .split(/[\s·-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** A persona colour that is safe to put into CSS: hex, rgb()/hsl() with plain numbers. Anything else (url(...), var(...), text) is dropped. */
export function safeColor(value) {
  const color = String(value ?? "").trim();
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^(rgb|hsl)a?\(\s*[0-9.]+(deg|%)?\s*([,\s/]\s*[0-9.]+%?\s*){2,3}\)$/i.test(color)) return color;
  return "";
}

/** How a persona id shows as an avatar: the emoji on the persona's colour, initials when it has none, a plain "system" mark for the system actor. */
export function avatarOf(id, personasById) {
  if (id === "system") return { kind: "system", text: "", color: "" };
  const persona = personasById?.get?.(id);
  if (!persona) return { kind: "unknown", text: initials(id), color: "" };
  const emoji = persona.avatar?.emoji;
  return { kind: emoji ? "emoji" : "initials", text: emoji || initials(persona.name), color: safeColor(persona.avatar?.color) };
}

export function actorName(id, personasById) {
  if (id === "system") return "System";
  return personasById?.get?.(id)?.name ?? id;
}

export function indexById(list) {
  return new Map((list ?? []).map((item) => [item.id, item]));
}

// --- List queries -----------------------------------------------------------------------------------------------

export const EMPTY_FILTERS = Object.freeze({ query: "", persona: "", status: "", tag: "", screen: "", hasVariants: false });

/** The list_use_cases input for a filter state: only what is set, so an untouched list sends nothing but paging. */
export function buildQuery(filters, extra = {}) {
  const input = {};
  if (filters.query?.trim()) input.query = filters.query.trim();
  if (filters.persona) input.persona = filters.persona;
  if (filters.status) input.status = filters.status;
  if (filters.tag) input.tag = filters.tag;
  if (filters.screen) input.screen = filters.screen;
  if (filters.hasVariants) input.has_variants = true;
  return { ...input, ...extra };
}

export function hasActiveFilters(filters) {
  return Object.keys(buildQuery(filters)).length > 0;
}

// --- Group tree ---------------------------------------------------------------------------------------------------

const collator = new Intl.Collator();

/**
 * The group-path tree from the `group` facet ({ "mapping/elements": 38, … }): every node carries `count` (all use cases at or
 * below it) and `direct` (exactly at that path). Children sort by name.
 */
export function buildGroupTree(groupFacet) {
  const byPath = new Map();
  const roots = [];
  const ensure = (segments) => {
    const path = segments.join("/");
    let node = byPath.get(path);
    if (node) return node;
    node = { path, name: segments[segments.length - 1], depth: segments.length - 1, count: 0, direct: 0, children: [] };
    byPath.set(path, node);
    if (segments.length === 1) roots.push(node);
    else ensure(segments.slice(0, -1)).children.push(node);
    return node;
  };
  for (const [path, count] of Object.entries(groupFacet ?? {})) {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    ensure(segments).direct += count;
    for (let i = 1; i <= segments.length; i++) byPath.get(segments.slice(0, i).join("/")).count += count;
  }
  const sortChildren = (nodes) => {
    nodes.sort((a, b) => collator.compare(a.name, b.name));
    nodes.forEach((node) => sortChildren(node.children));
  };
  sortChildren(roots);
  return { roots, byPath };
}

/** A group string the tree can address by path: no empty string, no leading / trailing / doubled slash. Others make the list fall back to the flat mode, where every case is reachable. */
export function isCanonicalGroup(group) {
  return group !== "" && group === String(group).split("/").filter(Boolean).join("/");
}

/** Every ancestor path of `group` including itself: "a/b/c" -> ["a", "a/b", "a/b/c"]. */
export function groupAncestors(group) {
  const segments = String(group ?? "").split("/").filter(Boolean);
  return segments.map((_, i) => segments.slice(0, i + 1).join("/"));
}

export const ROW_HEIGHT = { group: 28, ungrouped: 28, case: 46, more: 26, loading: 26, header: 26, error: 52 };
/** How many cases a group shows before "Show N more", and how many each click adds. */
export const GROUP_FIRST_PAGE = 4;
export const GROUP_PAGE = 25;
export const FLAT_PAGE = 100;
/** Largest single request the list makes (the most list_use_cases returns). */
export const PAGE_MAX = 100;

/**
 * One flat array of the rows currently visible in the grouped tree (what the virtual list renders from). `groupState`
 * maps a path to { rows, loading }; `ungrouped` is { count, rows, loading } for cases without a group.
 */
export function flattenTree({ roots, expanded, groupState, ungrouped }) {
  const rows = [];
  const walk = (node) => {
    const open = expanded.has(node.path);
    rows.push({ kind: "group", key: `g:${node.path}`, path: node.path, name: node.name, depth: node.depth, count: node.count, open });
    if (!open) return;
    const state = groupState.get(node.path);
    const loaded = state?.rows.length ?? 0;
    for (const u of state?.rows ?? []) rows.push({ kind: "case", key: `c:${u.id}`, u, depth: node.depth + 1 });
    if (state?.loading) rows.push({ kind: "loading", key: `l:${node.path}`, depth: node.depth + 1 });
    else if (node.direct > loaded) rows.push({ kind: "more", key: `m:${node.path}`, path: node.path, depth: node.depth + 1, remaining: node.direct - loaded });
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  if (ungrouped && ungrouped.count > 0) {
    const open = expanded.has("");
    rows.push({ kind: "ungrouped", key: "g:", path: "", name: "No group", depth: 0, count: ungrouped.count, open });
    if (open) {
      for (const u of ungrouped.rows) rows.push({ kind: "case", key: `c:${u.id}`, u, depth: 1 });
      if (ungrouped.loading) rows.push({ kind: "loading", key: "l:", depth: 1 });
      else if (ungrouped.count > ungrouped.rows.length) rows.push({ kind: "more", key: "m:", path: "", depth: 1, remaining: ungrouped.count - ungrouped.rows.length });
    }
  }
  return rows;
}

/** The flat list (any sort but group, or more groups than the facet reports): the loaded summaries, with a header row where the group changes when `withHeaders`. */
export function flattenFlat({ items, withHeaders, total, loading, error = "" }) {
  const rows = [];
  let last = null;
  items.forEach((u, index) => {
    const group = u.group ?? "";
    if (withHeaders && group !== last) {
      last = group;
      rows.push({ kind: "header", key: `h:${index}`, name: group === "" ? "No group" : group.split("/").join(" › "), depth: 0 });
    }
    rows.push({ kind: "case", key: `c:${u.id}`, u, depth: withHeaders ? 1 : 0 });
  });
  if (loading) rows.push({ kind: "loading", key: "l:flat", depth: 0 });
  else if (error) rows.push({ kind: "error", key: "e:flat", message: error, depth: 0 });
  else if (items.length < total) rows.push({ kind: "more", key: "m:flat", path: null, depth: 0, remaining: total - items.length });
  return rows;
}

// --- Virtual list -------------------------------------------------------------------------------------------------

/** Top offset of every row and the total height, from the per-kind heights. */
export function rowTops(rows, heights = ROW_HEIGHT) {
  const tops = new Array(rows.length);
  let y = 0;
  for (let i = 0; i < rows.length; i++) {
    tops[i] = y;
    y += heights[rows[i].kind] ?? 28;
  }
  return { tops, total: y };
}

/** The slice [start, end) of rows to render for a scroll position — binary search over the tops, plus an overscan on both sides. */
export function visibleWindow(tops, scrollTop, viewport, overscan = 6) {
  const count = tops.length;
  if (count === 0) return { start: 0, end: 0 };
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= scrollTop) lo = mid;
    else hi = mid - 1;
  }
  let end = lo;
  while (end < count && tops[end] < scrollTop + viewport) end++;
  return { start: Math.max(0, lo - overscan), end: Math.min(count, end + overscan) };
}

/**
 * Tree keyboard model over the visible rows: Up/Down move, Home/End jump, Right opens a closed group (or moves into it),
 * Left closes an open group (or moves to the parent group), Enter acts on the active row. Returns the next active key and
 * the action the caller has to run ({type: "toggle", path} / {type: "open", id} / {type: "more", path}).
 */
export function treeKeyNav(rows, activeKey, key) {
  if (rows.length === 0) return { activeKey: null, action: null };
  const index = rows.findIndex((row) => row.key === activeKey);
  const current = rows[index];
  const to = (i) => ({ activeKey: rows[Math.max(0, Math.min(rows.length - 1, i))].key, action: null });
  if (key === "ArrowDown") return to(index + 1);
  if (key === "ArrowUp") return to(index < 0 ? 0 : index - 1);
  if (key === "Home") return to(0);
  if (key === "End") return to(rows.length - 1);
  if (!current) return to(0);
  const isGroup = current.kind === "group" || current.kind === "ungrouped";
  if (key === "ArrowRight" && isGroup) return current.open ? to(index + 1) : { activeKey: current.key, action: { type: "toggle", path: current.path } };
  if (key === "ArrowLeft") {
    if (isGroup && current.open) return { activeKey: current.key, action: { type: "toggle", path: current.path } };
    // The parent is the nearest row above that is a group or the "No group" row and sits one level up.
    for (let i = index - 1; i >= 0; i--) if ((rows[i].kind === "group" || rows[i].kind === "ungrouped") && rows[i].depth < current.depth) return to(i);
    return { activeKey: current.key, action: null };
  }
  if (key === "Enter" || key === " ") {
    if (isGroup) return { activeKey: current.key, action: { type: "toggle", path: current.path } };
    if (current.kind === "case") return { activeKey: current.key, action: { type: "open", id: current.u.id } };
    if (current.kind === "more") return { activeKey: current.key, action: { type: "more", path: current.path } };
  }
  return { activeKey: current.key, action: null };
}

// --- Data cards ---------------------------------------------------------------------------------------------------

/** Display text of an example value: strings plain, everything else as compact JSON. */
export function formatValue(value) {
  if (value === undefined) return "—";
  if (value === null) return "null";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The keys of `after` that are new or differ from `before` — what the after card highlights. */
export function changedKeys(before, after) {
  const changed = new Set();
  for (const [key, value] of Object.entries(after ?? {})) {
    if (!before || !Object.hasOwn(before, key) || JSON.stringify(before[key]) !== JSON.stringify(value)) changed.add(key);
  }
  return changed;
}

/** `key: value` lines of an example, in key order, each flagged when it is in `highlight`. */
export function exampleLines(example, highlight = new Set()) {
  return Object.entries(example ?? {}).map(([key, value]) => ({ key, text: formatValue(value), changed: highlight.has(key) }));
}

export function fieldTypeLabel(field) {
  if (field.type === "ref") return field.ref ? `ref → ${field.ref}` : "ref";
  return field.type;
}

/** The table rows of one input/output: every field of the data object (declared order) plus example keys the object does not declare. */
export function fieldRows(dataObject, example) {
  const rows = [];
  const seen = new Set();
  for (const field of dataObject?.fields ?? []) {
    seen.add(field.name);
    rows.push({ name: field.name, type: fieldTypeLabel(field), hasExample: Object.hasOwn(example ?? {}, field.name), example: example?.[field.name], declared: true });
  }
  for (const [key, value] of Object.entries(example ?? {})) {
    if (!seen.has(key)) rows.push({ name: key, type: "", hasExample: true, example: value, declared: false });
  }
  return rows;
}

/** Keys of an output example that differ from the input example of the same object — the rows the detail view highlights. */
export function ioChangedKeys(output, inputs) {
  const input = (inputs ?? []).find((item) => item.object === output.object);
  return changedKeys(input?.example, output.example);
}

// --- Example text ("scope: element, node: btn-mapping") -----------------------------------------------------------

function looksTyped(text) {
  return /^(-?\d+(\.\d+)?|true|false|null)$/.test(text) || /^[{["]/.test(text);
}

/** The text form of one value, quoted when plain text would read back as another type. */
export function formatExampleValue(value) {
  if (typeof value === "string") return value === "" || looksTyped(value) || /^\s|\s$|,\s*[\w.-]+\s*:/.test(value) ? JSON.stringify(value) : value;
  return JSON.stringify(value);
}

const KEY_RE = /^[\p{L}\p{N}_.-]+$/u;

/**
 * Object -> text. Friendly single-line `key: value, key: value` when that reads back to exactly the same object (checked, not
 * assumed); otherwise the JSON of the object, which always does. Values that would read back as another type are quoted.
 */
export function formatExample(example) {
  const object = example ?? {};
  const friendly = Object.entries(object)
    .map(([key, value]) => `${key}: ${formatExampleValue(value)}`)
    .join(", ");
  const back = parseExample(friendly);
  return back.ok && JSON.stringify(back.value) === JSON.stringify(object) ? friendly : JSON.stringify(object);
}

/** One typed scalar from text: true / false / null / numbers / JSON objects and arrays, anything else stays a string. */
export function parseExampleValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (/^[{["]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Splits at commas that are outside quotes / brackets and followed by `key:`. */
function splitEntries(source) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth <= 0 && /^\s*[\p{L}\p{N}_.-]+\s*:/u.test(source.slice(i + 1))) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

/** The example an edited text stands for: the original object when the text is untouched (never rewrite what the user did not change), else the parsed text. */
export function parseOrKeep(text, original) {
  if (original !== undefined && text === formatExample(original)) return { ok: true, value: original };
  return parseExample(text);
}

/** `key: value, key: value` (or a JSON object) text -> { ok, value } / { ok: false, error }. A comma only separates entries when a `key:` follows outside quotes. */
export function parseExample(text) {
  const source = String(text ?? "").trim();
  if (source === "") return { ok: true, value: {} };
  if (source.startsWith("{")) {
    // The JSON form (what formatExample falls back to): any string key, any value, no ambiguity.
    try {
      const parsed = JSON.parse(source);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, value: parsed };
    } catch {
      // not JSON: fall through to the key: value reading, which reports what is wrong
    }
  }
  const value = {};
  for (const part of splitEntries(source)) {
    const at = part.indexOf(":");
    const key = part.slice(0, at).trim();
    if (at < 1 || !KEY_RE.test(key) || key === "__proto__") return { ok: false, error: `"${part.trim().slice(0, 30)}" is not key: value` };
    value[key] = parseExampleValue(part.slice(at + 1).trim());
  }
  return { ok: true, value };
}

/** Example keys not declared by the data object (a warning, never an error). */
export function undeclaredExampleKeys(dataObject, example) {
  if (!dataObject) return [];
  const declared = new Set(dataObject.fields.map((field) => field.name));
  return Object.keys(example ?? {}).filter((key) => !declared.has(key));
}

/**
 * "Leave unmapped" for one step of the view shown: drops its target in the place the step lives. With a variant selected that is the
 * variant's op that produces the effective step (the last op carrying the step id: an append followed by a replace of the same step
 * is edited in the replace) when there is one, else the base step (an unchanged one). Returns
 * { changed: false } when there is nothing to change, so a caller never reports a success that did not happen.
 */
export function removeStepTarget(source, stepId, variantId) {
  const strip = (step) => {
    const rest = { ...step };
    delete rest.target;
    return rest;
  };
  if (variantId) {
    const variants = source.variants ?? [];
    const variant = variants.find((v) => v.id === variantId);
    const ops = variant?.steps ?? [];
    const index = ops.findLastIndex((op) => op.step?.id === stepId);
    if (variant && index >= 0) {
      if (!ops[index].step.target) return { changed: false }; // the variant's own step has no target: the base step is not what the view shows
      const next = variants.map((v) => (v === variant ? { ...v, steps: v.steps.map((op, i) => (i === index ? { ...op, step: strip(op.step) } : op)) } : v));
      return { changed: true, patch: { variants: next }, where: "variant" };
    }
  }
  const at = (source.steps ?? []).findIndex((step) => step.id === stepId && step.target);
  if (at < 0) return { changed: false };
  return { changed: true, patch: { steps: source.steps.map((step, i) => (i === at ? strip(step) : step)) }, where: "base" };
}

// --- Flow rows and the variant difference ---------------------------------------------------------------------

/** Scope badge of a step: "element" (target.node), "screen" (target without node), "stale" (mapping_stale), "none" (no target). */
export function stepScope(step, mapping) {
  if (!step?.target) return "none";
  if (mapping?.stale) return "stale";
  return step.target.node ? "element" : "screen";
}

/** The bundle's mapping of a step (screens[].mappings[]) with its screen entry; the base flow's own mapping wins over a variant-only one of the same step id. */
export function mappingFor(bundle, stepId) {
  let fallback = null;
  for (const screen of bundle?.screens ?? []) {
    for (const mapping of screen.mappings ?? []) {
      if (mapping.step !== stepId) continue;
      if (!mapping.variants || mapping.variants.length === 0) return { mapping, screen };
      fallback ??= { mapping, screen };
    }
  }
  return fallback;
}

/**
 * Rows of the flow for the detail view. Without a variant: one row per step. With one: the effective flow in order, each step
 * flagged changed / added / unchanged ("base"), what changed against `baseSteps` ("was"), and the removed base steps as ghost
 * rows after the step they followed.
 */
export function buildFlowRows({ steps, removedSteps = [], baseSteps = [], variantSelected = false }) {
  const baseById = new Map(baseSteps.map((step) => [step.id, step]));
  const rows = [];
  const ghosts = (afterId) => {
    for (const step of removedSteps) if ((step.after ?? null) === afterId) rows.push({ kind: "removed", step });
  };
  ghosts(null);
  let number = 0;
  for (const step of steps) {
    number++;
    const change = variantSelected ? (step.change ?? "base") : null;
    const base = baseById.get(step.id);
    rows.push({ kind: "step", step, number, change, was: change === "changed" && base ? stepWas(base, step) : null });
    ghosts(step.id);
  }
  return rows;
}

function targetKey(step) {
  return step.target ? `${step.target.screen}${step.target.node ? ` › ${step.target.node}` : ""}` : "";
}

function stepWas(base, step) {
  const was = {};
  if (base.actor !== step.actor) was.actor = base.actor;
  if (base.action !== step.action) was.action = base.action;
  if (targetKey(base) !== targetKey(step)) was.target = targetKey(base) || "none";
  return was;
}

/**
 * Number of differences a variant carries, for the chip meta ("4 changes"): its step ops, replaced inputs / outputs and each
 * actor swap that changes at least one inherited base step (spec §4: an entry whose key equals its value, or whose key no base
 * step has, changes nothing). A step the variant removes or replaces is taken as written, so a swap only counts for base steps
 * the ops leave alone. `baseSteps` are the base case's steps; without them no swap can be counted.
 */
export function variantChangeCount(variant, baseSteps = []) {
  const rewritten = new Set((variant?.steps ?? []).filter((op) => op.op === "remove" || op.op === "replace").map((op) => op.step_id));
  const surviving = baseSteps.filter((step) => !rewritten.has(step.id));
  const swaps = Object.entries(variant?.actors ?? {}).filter(([from, to]) => from !== to && surviving.some((step) => step.actor === from)).length;
  return (variant?.steps?.length ?? 0) + (variant?.outputs ? 1 : 0) + (variant?.inputs ? 1 : 0) + swaps;
}

/** A `when` condition as readable entries: [{ dimension, label, values: [{ id, label }] }]. */
export function whenEntries(when, dimensionsById) {
  return Object.entries(when ?? {}).map(([dimension, values]) => {
    const dim = dimensionsById?.get?.(dimension);
    return {
      dimension,
      label: dim?.label ?? dimension,
      values: values.map((value) => ({ id: value, label: dim?.values.find((v) => v.id === value)?.label ?? value })),
    };
  });
}

/** Personas whose traits satisfy a `when` (any-of per dimension, all dimensions must match; a persona without the trait does not match). */
export function matchingPersonas(when, personas) {
  const entries = Object.entries(when ?? {});
  if (entries.length === 0) return [];
  return personas.filter((persona) => entries.every(([dimension, values]) => values.includes(persona.traits?.[dimension])));
}

// --- Coverage matrix ----------------------------------------------------------------------------------------------

/**
 * The coverage matrix: rows = Base and each variant, columns = the values of each dimension the persona pool uses.
 * Base row: a mark for every value held by the base use case's personas, "any" for a dimension where a base persona has no trait
 * (or there is no base persona). Variant row: a mark for each value its `when` names, "any" for every dimension its `when` does not
 * constrain. A column neither Base nor any variant covers is a gap. `uncovered` (the coverage of `suggest_use_case_variants`:
 * [{ dimension, uncovered: [valueId] }]) decides the gaps when given, so the UI and the tool agree; without it the same rule is
 * computed here (a base "any" covers every value, a variant only the values it names).
 */
export function coverageMatrix({ dimensions, pool, basePersonas, variants, uncovered }) {
  const tool = uncovered ? new Map(uncovered.map((c) => [c.dimension, new Set(c.uncovered)])) : null;
  const columns = [];
  const rows = [{ id: "base", title: "Base", kind: "base", dims: {} }, ...variants.map((v) => ({ id: v.id, title: v.title ?? v.id, kind: "variant", dims: {} }))];
  let gaps = 0;
  for (const dimension of dimensions) {
    const used = new Set(pool.flatMap((persona) => (persona.traits?.[dimension.id] ? [persona.traits[dimension.id]] : [])));
    const values = dimension.values.filter((value) => used.has(value.id));
    if (values.length === 0) continue;
    const baseAny = basePersonas.length === 0 || basePersonas.some((persona) => !persona.traits?.[dimension.id]);
    const baseValues = new Set(basePersonas.flatMap((persona) => (persona.traits?.[dimension.id] ? [persona.traits[dimension.id]] : [])));
    rows[0].dims[dimension.id] = baseAny ? { any: true } : { marks: new Set(baseValues) };
    variants.forEach((variant, i) => {
      const named = variant.when?.[dimension.id];
      rows[i + 1].dims[dimension.id] = named ? { marks: new Set(named) } : { any: true };
    });
    const cols = values.map((value) => {
      const covered = baseAny || baseValues.has(value.id) || variants.some((variant) => variant.when?.[dimension.id]?.includes(value.id));
      const gap = tool ? Boolean(tool.get(dimension.id)?.has(value.id)) : !covered;
      if (gap) gaps++;
      return { value: value.id, label: value.label, gap };
    });
    columns.push({ dimension: dimension.id, label: dimension.label, values: cols });
  }
  return { columns, rows, gaps };
}

// --- Persona pool -------------------------------------------------------------------------------------------------

/** How many personas hold each value of each dimension: { dimensionId: { valueId: n } }. */
export function traitCounts(dimensions, personas) {
  const counts = {};
  for (const dimension of dimensions) {
    counts[dimension.id] = Object.fromEntries(dimension.values.map((value) => [value.id, 0]));
    for (const persona of personas) {
      const value = persona.traits?.[dimension.id];
      if (value !== undefined && Object.hasOwn(counts[dimension.id], value)) counts[dimension.id][value]++;
    }
  }
  return counts;
}

export function matchesPersonaQuery(persona, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (needle === "") return true;
  const haystack = [persona.id, persona.name, persona.role, persona.description, ...(persona.goals ?? []), ...Object.entries(persona.traits ?? {}).flat()].filter(Boolean).join("\n").toLowerCase();
  return haystack.includes(needle);
}

// --- Messages -----------------------------------------------------------------------------------------------------

/** One short line for a write response's warnings: "2 warnings. Saving is never blocked." */
export function warningSummary(warnings, count) {
  const n = count ?? warnings?.length ?? 0;
  return n === 0 ? "" : `${plural(n, "warning")}. Saving is never blocked.`;
}

export function errorMessage(error) {
  return error?.message || error?.code || "Something went wrong.";
}
