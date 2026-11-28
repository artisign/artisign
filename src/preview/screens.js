// Sidebar screen list: search-filterable, each row shows the screen name
// and its tags as chips. Screens that name a `variant_of` parent (CHR-727)
// nest under it as a tree at any depth. Filter and expand state live in
// app.js — this module only filters/renders what it's given.

import { icon } from "./icons.js";

/**
 * Case-insensitive substring match over a screen's name and its tags.
 * @param {{ name: string, tags: string[] }[]} screens
 * @param {string} filter
 * @returns {{ name: string, tags: string[] }[]}
 */
export function filterScreens(screens, filter) {
  const needle = filter.trim().toLowerCase();
  if (!needle) return screens;
  return screens.filter(
    (screen) => screen.name.toLowerCase().includes(needle) || screen.tags.some((tag) => tag.toLowerCase().includes(needle)),
  );
}

/** Indentation per nesting level, in px — mirrored by `--depth` in style.css. */
export const TREE_INDENT_PX = 14;

/** Chips shown per row before the rest fold into a "+N" chip. */
const MAX_VISIBLE_TAGS = 2;

/**
 * Builds the variant tree from the flat screen list. Roots and siblings keep
 * the input order. A screen whose `variant_of` names a missing screen (or
 * itself, or closes a cycle) is a root — the server already strips dangling
 * parents, this is the client-side defence.
 * @param {{ name: string, tags: string[], variant_of?: string, variant_kind?: string }[]} screens
 * @returns {{ roots: TreeNode[], nodes: Map<string, TreeNode> }}
 */
export function buildScreenTree(screens) {
  const nodes = new Map(
    screens.map((screen) => [
      screen.name,
      { screen, name: screen.name, parent: null, children: [], depth: 0, total: 0 },
    ]),
  );
  for (const node of nodes.values()) {
    const parent = nodes.get(node.screen.variant_of);
    if (parent && parent !== node) node.parent = parent;
  }
  for (const node of nodes.values()) {
    const seen = new Set([node]);
    for (let p = node.parent; p; p = p.parent) {
      if (seen.has(p)) {
        node.parent = null;
        break;
      }
      seen.add(p);
    }
  }
  const roots = [];
  for (const node of nodes.values()) (node.parent ? node.parent.children : roots).push(node);
  const measure = (node, depth) => {
    node.depth = depth;
    node.total = 0;
    for (const child of node.children) node.total += 1 + measure(child, depth + 1);
    return node.total;
  };
  for (const root of roots) measure(root, 0);
  return { roots, nodes };
}

/**
 * The name shown for a row. Below the root, a name that starts with its
 * parent's name shows only what follows it (the parent's name and the
 * separator are dropped, no ellipsis); anything else shows in full. Display
 * only — the screen's real name is never changed (the row's title keeps it).
 * @param {TreeNode} node
 * @returns {string}
 */
export function displayName(node) {
  const parent = node.parent;
  if (parent && node.name.length > parent.name.length && node.name.startsWith(parent.name)) {
    const rest = node.name.slice(parent.name.length).replace(/^[\s\-_./:]+/, "");
    if (rest !== "") return rest;
  }
  return node.name;
}

/** Ancestor names of `name`, root first, excluding `name` itself. Empty for a root or an unknown name. */
export function ancestorNames(tree, name) {
  const names = [];
  for (let p = tree.nodes.get(name)?.parent; p; p = p.parent) names.unshift(p.name);
  return names;
}

/** `node` plus every descendant, depth-first. */
export function subtreeNames(node) {
  return [node.name, ...node.children.flatMap(subtreeNames)];
}

/**
 * Splits `text` around the first case-insensitive occurrence of `needle`.
 * @param {string} text
 * @param {string} needle
 * @returns {{ text: string, match: boolean }[]}
 */
export function highlightParts(text, needle) {
  const at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at < 0) return [{ text, match: false }];
  return [
    { text: text.slice(0, at), match: false },
    { text: text.slice(at, at + needle.length), match: true },
    { text: text.slice(at + needle.length), match: false },
  ].filter((part) => part.text !== "");
}

/**
 * Flattens the tree into the rows the sidebar shows, in display order.
 *
 * Without a filter a node's children show iff the node is in `expanded`.
 * With a filter, matches (name or tag, same rule as filterScreens) show
 * with their ancestor path as `context` rows; only that path auto-expands,
 * and non-matching siblings fold into one `hidden` row with their count.
 * A match the user expanded shows all its children (`plain` rows).
 * @param {{ roots: TreeNode[] }} tree
 * @param {{ expanded?: Set<string>, filter?: string }} [opts]
 * @returns {{ rows: SidebarRow[], matchCount: number, contextCount: number }}
 */
export function flattenTree(tree, { expanded = new Set(), filter = "" } = {}) {
  const needle = filter.trim().toLowerCase();
  const matches = new Set();
  const pathNodes = new Set();
  if (needle) {
    const visit = (node) => {
      if (matchesFilter(node.screen, needle)) matches.add(node);
      for (const child of node.children) visit(child);
    };
    for (const root of tree.roots) visit(root);
    for (const node of matches) for (let p = node.parent; p; p = p.parent) pathNodes.add(p);
  }
  const visible = new Set([...matches, ...pathNodes]);

  const rows = [];
  const emit = (node) => {
    const userOpen = expanded.has(node.name);
    const open = node.children.length > 0 && (userOpen || pathNodes.has(node));
    rows.push({
      type: "screen",
      node,
      depth: node.depth,
      state: matches.has(node) ? "match" : visible.has(node) ? "context" : "plain",
      expanded: open,
      // Held open by the filter: a match lies below, so the toggle can't close it.
      forcedOpen: open && pathNodes.has(node),
    });
    if (!open) return;
    // A node on a match's path folds its non-matching children even when the
    // user expanded it; a match or plain node the user expanded shows all.
    const showAll = !needle || (userOpen && !pathNodes.has(node));
    let hidden = 0;
    for (const child of node.children) {
      if (showAll || visible.has(child)) emit(child);
      else hidden += 1;
    }
    if (hidden > 0) rows.push({ type: "hidden", depth: node.depth + 1, count: hidden });
  };
  for (const root of tree.roots) if (!needle || visible.has(root)) emit(root);
  return {
    rows,
    matchCount: matches.size,
    contextCount: pathNodes.size - [...pathNodes].filter((n) => matches.has(n)).length,
  };
}

function matchesFilter(screen, needle) {
  return (
    screen.name.toLowerCase().includes(needle) ||
    screen.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}

// Material Symbols per screen kind; "main" is a screen without a `variant_kind` (a root of the tree). The screen view's breadcrumb and its popover use these.
const KIND_ICONS = { main: "phone_iphone", state: "description", overlay: "web_asset", step: "subdirectory_arrow_right" };

/**
 * The kind icon (main / state / overlay / step) shared by the screen view's breadcrumb and its popover.
 * @param {string | undefined} kind
 * @returns {HTMLSpanElement | null} null for an unknown or absent kind
 */
export function createKindIcon(kind) {
  if (!(kind in KIND_ICONS)) return null;
  const node = icon(KIND_ICONS[kind], "kind-icon");
  node.dataset.kind = kind;
  return node;
}

/** Frames at least this wide (a tablet and up) read as desktop in the nav tree (CHR-1267); a phone frame is about 390 wide. */
export const DESKTOP_MIN_WIDTH = 700;

/**
 * The icon name for a screen's viewport: a monitor for a wide frame, a phone otherwise — also when the size is unknown (the default frame is a phone).
 * @param {{ width: number } | undefined} viewport
 * @returns {"desktop_windows" | "smartphone"}
 */
export function viewportIconName(viewport) {
  return viewport && viewport.width >= DESKTOP_MIN_WIDTH ? "desktop_windows" : "smartphone";
}

/**
 * The leading icon of a nav tree row: an overlay and a step variant keep their own glyph, everything else shows the viewport.
 * @param {{ variant_kind?: string } | undefined} screen
 * @param {boolean} isVariant
 * @param {{ width: number } | undefined} viewport
 * @returns {HTMLSpanElement}
 */
function rowIcon(screen, isVariant, viewport) {
  const kind = isVariant ? screen?.variant_kind : undefined;
  if (kind === "overlay" || kind === "step") return icon(KIND_ICONS[kind], "kind-icon");
  const node = icon(viewportIconName(viewport), "kind-icon");
  node.dataset.viewport = viewportIconName(viewport) === "desktop_windows" ? "desktop" : "mobile";
  return node;
}

/**
 * Appends the tag chips of one row: matching ones first while filtering, the overflow folded into a "+N" chip.
 * @param {HTMLElement} parent
 * @param {string[]} tags
 * @param {string} needle lower-cased filter
 */
function appendTagRow(parent, tags, needle) {
  const tagRow = document.createElement("div");
  tagRow.className = "tag-row";
  const tagMatches = (tag) => needle !== "" && tag.toLowerCase().includes(needle);
  const ordered = [...tags].sort((a, b) => Number(tagMatches(b)) - Number(tagMatches(a)));
  const rest = ordered.length > MAX_VISIBLE_TAGS ? ordered.length - MAX_VISIBLE_TAGS : 0;
  for (const tag of ordered.slice(0, ordered.length - rest)) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    if (tagMatches(tag)) chip.classList.add("match");
    chip.textContent = tag;
    chip.title = tag;
    tagRow.appendChild(chip);
  }
  if (rest > 0) {
    const more = document.createElement("span");
    more.className = "tag-chip tag-more";
    if (ordered.slice(MAX_VISIBLE_TAGS).some(tagMatches)) more.classList.add("match");
    more.textContent = `+${rest}`;
    more.title = ordered.join(", ");
    tagRow.appendChild(more);
  }
  parent.appendChild(tagRow);
}

/**
 * The nav tree (CHR-1267): a flat `role="tree"` list whose rows carry `aria-level`; screens that name a `variant_of` parent nest under it, a chevron collapses them. Each row has the viewport icon, the name, its tag chips and the variant count; the open screen is the teal row. Filter and expand state live in app.js — this module only filters/renders what it's given.
 * @param {HTMLElement} listEl
 * @param {{ name: string, tags: string[], variant_of?: string, variant_kind?: "state" | "overlay" | "step" }[]} screens
 * @param {string | null} activeScreen
 * @param {(screen: string) => void} onSelect
 * @param {string} [filter]
 * @param {{
 *   pinned?: Set<string>,
 *   onTogglePin?: (screen: string, subtree: string[]) => void,
 *   expanded?: Set<string>,
 *   onToggleExpand?: (screen: string) => void,
 *   showTags?: boolean,
 *   viewports?: Map<string, { width: number, height: number }>,
 *   compare?: { reference: string, family: string[], selected: string[], cap: number, onToggle: (screen: string) => void },
 * }} [opts]
 *   CHR-624 — omitting `onTogglePin` (the default) renders no pin button at all. `onTogglePin` receives the screen plus its whole subtree (just `[screen]` on a leaf); a group row counts as pinned only once every member is.
 *
 *   CHR-738 — while compare is on, `compare` puts a checkbox on every row of the reference's family: the reference's is ticked and locked, the others toggle their membership until `cap` members are ticked, then the unticked ones are disabled. Rows outside the family get none.
 */
export function renderScreenList(listEl, screens, activeScreen, onSelect, filter = "", opts = {}) {
  listEl.innerHTML = "";
  const tree = buildScreenTree(screens);
  const { rows } = flattenTree(tree, { expanded: opts.expanded ?? new Set(), filter });
  appendScreenRows(listEl, rows, { tree, filter, activeScreen, onSelect, ...opts });
}

/**
 * The Board's list (CHR-1271): the same rows, grouped under headings. With a filter: "Matches" (what the filter finds) and "Pinned" (pinned screens it does not find — they stay on the board). Without one: "Pinned" and "All screens". A group is a set of top-level screens with their variants; its count is that number of rows. A pin toggle on every row, always visible.
 * @param {HTMLElement} listEl
 * @param {{ name: string, tags: string[], variant_of?: string, variant_kind?: string }[]} screens
 * @param {string | null} activeScreen
 * @param {(screen: string) => void} onSelect
 * @param {string} filter
 * @param {Parameters<typeof renderScreenList>[5]} opts as renderScreenList; `onTogglePin` and `pinned` are what the toggles use
 * @returns {{ title: string, count: number }[]} the groups drawn (heading and number of rows)
 */
export function renderBoardScreenList(listEl, screens, activeScreen, onSelect, filter, opts = {}) {
  listEl.innerHTML = "";
  const tree = buildScreenTree(screens);
  const expanded = opts.expanded ?? new Set();
  const pinned = opts.pinned ?? new Set();
  const hasPin = (root) => subtreeNames(root).some((name) => pinned.has(name));
  const rowCount = (rows) => rows.filter((r) => r.type === "screen" && r.node.parent === null).length;
  const needle = filter.trim();
  /** @type {{ title: string, rows: SidebarRow[], emptyText?: string }[]} */
  const groups = [];
  if (needle) {
    const found = flattenTree(tree, { expanded, filter });
    const foundRoots = new Set(found.rows.filter((r) => r.type === "screen" && r.node.parent === null).map((r) => r.node.name));
    const pinnedOnly = tree.roots.filter((root) => !foundRoots.has(root.name) && hasPin(root));
    groups.push({ title: "Matches", rows: found.rows, emptyText: `No screen or tag matches \u201c${needle}\u201d.` });
    if (pinnedOnly.length > 0) groups.push({ title: "Pinned", rows: flattenTree({ roots: pinnedOnly }, { expanded }).rows });
  } else {
    const pinnedRoots = tree.roots.filter(hasPin);
    const rest = tree.roots.filter((root) => !hasPin(root));
    if (pinnedRoots.length > 0) groups.push({ title: "Pinned", rows: flattenTree({ roots: pinnedRoots }, { expanded }).rows });
    groups.push({ title: "All screens", rows: flattenTree({ roots: rest }, { expanded }).rows });
  }
  const drawn = [];
  for (const group of groups) {
    const count = rowCount(group.rows);
    if (count === 0 && !group.emptyText) continue; // an empty "All screens" (everything is pinned) has nothing to say
    // With nothing at all to show (no match, no pin) the line stands alone, under the status.
    if (count === 0 && groups.length === 1) {
      const none = document.createElement("li");
      none.className = "nav-empty";
      none.setAttribute("role", "presentation");
      none.textContent = group.emptyText ?? "";
      listEl.appendChild(none);
      drawn.push({ title: group.title, count });
      continue;
    }
    const head = document.createElement("li");
    head.className = "screen-section";
    head.setAttribute("role", "presentation");
    const title = document.createElement("span");
    title.className = "screen-section-title";
    title.textContent = group.title;
    const meta = document.createElement("span");
    meta.className = "screen-section-count";
    meta.textContent = String(count);
    head.append(title, meta);
    listEl.appendChild(head);
    if (count === 0) {
      const none = document.createElement("li");
      none.className = "nav-empty";
      none.setAttribute("role", "presentation");
      none.textContent = group.emptyText ?? "";
      listEl.appendChild(none);
    } else appendScreenRows(listEl, group.rows, { tree, filter: needle, activeScreen, onSelect, ...opts, alwaysPins: true });
    drawn.push({ title: group.title, count });
  }
  return drawn;
}

/** @param {HTMLElement} listEl @param {SidebarRow[]} rows @param {object} ctx the options of renderScreenList plus `tree`, `activeScreen`, `onSelect`, `filter`; `alwaysPins` marks the Board's list */
function appendScreenRows(listEl, rows, ctx) {
  const { tree, activeScreen, onSelect, pinned, onTogglePin, showTags = true, viewports = new Map(), compare, onToggleExpand, alwaysPins = false } = ctx;
  const needle = (ctx.filter ?? "").trim().toLowerCase();
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "screen-item-row";
    li.setAttribute("role", "none");
    li.dataset.depth = String(row.depth);
    li.style.setProperty("--depth", String(row.depth));

    if (row.type === "hidden") {
      li.classList.add("screen-hidden-row");
      li.textContent = `${row.count} hidden by the filter`;
      listEl.appendChild(li);
      continue;
    }

    const { node, state } = row;
    const screen = node.screen;
    if (state === "context") li.classList.add("context");
    if (state === "match") li.classList.add("match");
    li.dataset.screen = screen.name;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "screen-item";
    button.setAttribute("role", "treeitem");
    button.setAttribute("aria-level", String(row.depth + 1));
    const isActive = screen.name === activeScreen;
    button.setAttribute("aria-current", String(isActive));
    button.setAttribute("aria-selected", String(isActive));
    if (node.children.length > 0) button.setAttribute("aria-expanded", String(row.expanded));

    const shown = displayName(node);
    if (shown !== node.name) button.title = `${node.name}\n${[...ancestorNames(tree, node.name), node.name].join(" › ")}`;

    button.appendChild(rowIcon(screen, node.parent !== null, viewports.get(screen.name)));

    const mainEl = document.createElement("div");
    mainEl.className = "screen-item-main";
    const nameEl = document.createElement("div");
    nameEl.className = "screen-item-name";
    const textEl = document.createElement("span");
    textEl.className = "screen-item-text";
    for (const part of highlightParts(shown, state === "match" ? needle : "")) {
      if (part.match) {
        const mark = document.createElement("mark");
        mark.textContent = part.text;
        textEl.appendChild(mark);
      } else {
        textEl.append(part.text);
      }
    }
    nameEl.appendChild(textEl);
    mainEl.appendChild(nameEl);
    if (showTags && screen.tags.length > 0) appendTagRow(mainEl, screen.tags, needle);
    button.appendChild(mainEl);

    if (node.children.length > 0) {
      const total = document.createElement("span");
      total.className = "screen-item-total";
      total.textContent = String(node.total);
      total.title = `${node.total} variant${node.total === 1 ? "" : "s"}`;
      button.appendChild(total);
    }

    button.addEventListener("click", () => onSelect(screen.name));
    li.appendChild(button);

    if (node.children.length > 0) {
      // Sibling of the select button for the same reason as the pin button below — nested interactive elements are invalid HTML.
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "screen-item-toggle";
      toggle.setAttribute("aria-expanded", String(row.expanded));
      toggle.setAttribute("aria-label", `${row.expanded ? "Collapse" : "Expand"} ${screen.name}`);
      toggle.appendChild(icon(row.expanded ? "expand_more" : "chevron_right", "icon-xs"));
      // Disabled while the filter holds the row open — a click would change the saved expand state without any visible effect.
      if (row.forcedOpen) toggle.disabled = true;
      toggle.addEventListener("click", (evt) => {
        evt.stopPropagation();
        onToggleExpand?.(screen.name);
      });
      // Before the select button in DOM order so Tab follows the visual order (the toggle sits at the row's left edge).
      li.insertBefore(toggle, button);
    }

    if (compare?.family.includes(screen.name)) {
      const isReference = screen.name === compare.reference;
      const ticked = isReference || compare.selected.includes(screen.name);
      // A sibling of the select button, like the pin button — no nested interactive elements.
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "screen-item-compare";
      box.checked = ticked;
      box.disabled = isReference || (!ticked && compare.selected.length >= compare.cap);
      box.setAttribute("aria-label", isReference ? `${screen.name} is the compare reference` : `Compare ${screen.name}`);
      if (isReference) box.title = "The main screen is the locked reference";
      box.addEventListener("change", () => compare.onToggle(screen.name));
      li.classList.add("has-compare");
      li.appendChild(box);
    }

    if (onTogglePin) {
      const subtree = subtreeNames(node);
      const isPinned = subtree.every((name) => pinned?.has(name));
      const label = node.children.length > 0 ? `${screen.name} and its ${node.total} variant${node.total === 1 ? "" : "s"}` : screen.name;
      // A sibling of `button.screen-item`, not a child — two nested interactive elements would be invalid HTML (and unfocusable via keyboard for the inner one in most browsers).
      const pinButton = document.createElement("button");
      pinButton.type = "button";
      pinButton.className = "screen-item-pin pin-toggle";
      pinButton.classList.toggle("pinned", isPinned);
      pinButton.classList.toggle("always", alwaysPins);
      pinButton.setAttribute("aria-label", isPinned ? `Unpin ${label} from the board` : `Pin ${label} to the board`);
      pinButton.setAttribute("aria-pressed", String(isPinned));
      pinButton.appendChild(icon("keep", "icon-xs"));
      pinButton.addEventListener("click", (evt) => {
        evt.stopPropagation();
        onTogglePin(screen.name, subtree);
      });
      li.appendChild(pinButton);
    }

    listEl.appendChild(li);
  }
}

/**
 * @typedef {{ screen: object, name: string, parent: TreeNode | null, children: TreeNode[], depth: number, total: number }} TreeNode
 * @typedef {{ type: "screen", node: TreeNode, depth: number, state: "plain" | "match" | "context", expanded: boolean, forcedOpen: boolean } | { type: "hidden", depth: number, count: number }} SidebarRow
 */
