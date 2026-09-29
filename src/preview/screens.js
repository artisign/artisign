// Sidebar screen list: search-filterable, each row shows the screen name
// and its tags as chips. Screens that name a `variant_of` parent (CHR-727)
// nest under it as a tree at any depth. Filter and expand state live in
// app.js — this module only filters/renders what it's given.

// The `$pin-button` design-system component's inline map-pin glyph (CHR-624)
// — a static SVG, not an emoji (poor contrast on the accent fill, and
// inconsistent rendering across OSes, per the component's own usage note).
// Exported so board-view.js's board-tile pin buttons render the identical
// glyph without a second copy of this markup.
export const PIN_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"></path></svg>';

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
 * parent's name shows only the suffix behind an ellipsis; anything else
 * shows in full. Display only — the screen's real name is never changed.
 * @param {TreeNode} node
 * @returns {string}
 */
export function displayName(node) {
  const parent = node.parent;
  if (parent && node.name.length > parent.name.length && node.name.startsWith(parent.name)) {
    return `…${node.name.slice(parent.name.length)}`;
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

const KIND_GLYPH = { state: "", overlay: "", step: "↪" };

/**
 * The variant-kind glyph (state / overlay / step) shared by the sidebar tree
 * and the screen view's breadcrumb, popover and tree map.
 * @param {string | undefined} kind
 * @returns {HTMLSpanElement | null} null for an unknown or absent kind
 */
export function createKindIcon(kind) {
  if (!(kind in KIND_GLYPH)) return null;
  const icon = document.createElement("span");
  icon.className = `kind-icon kind-${kind}`;
  icon.dataset.kind = kind;
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = KIND_GLYPH[kind];
  return icon;
}

/**
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
 * }} [opts]
 *   CHR-624 — omitting `onTogglePin` (the default) renders no pin button at
 *   all, so every OTHER caller of this widely-used function (and its
 *   existing tests) is unaffected. `pinned` only needs to cover screens
 *   actually rendered here — the sidebar only ever shows filter MATCHES
 *   (plus their ancestor path as context), never a pinned-but-non-matching
 *   screen; that distinction is the board's own `outside-filter` tile
 *   treatment.
 *
 *   CHR-731 — `onTogglePin` receives the screen plus its whole subtree
 *   (just `[screen]` on a leaf); a group row counts as pinned only once
 *   every member is. A project without any `variant_of` renders the flat
 *   list: no disclosure, no depth guides, no kind icons.
 */
export function renderScreenList(
  listEl,
  screens,
  activeScreen,
  onSelect,
  filter = "",
  { pinned, onTogglePin, expanded = new Set(), onToggleExpand, showTags = true } = {},
) {
  listEl.innerHTML = "";
  const tree = buildScreenTree(screens);
  const treeMode = tree.roots.length !== screens.length;
  const needle = filter.trim().toLowerCase();
  const { rows } = flattenTree(tree, { expanded, filter });

  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "screen-item-row";
    if (treeMode) {
      li.dataset.depth = String(row.depth);
      li.style.setProperty("--depth", String(row.depth));
    }

    if (row.type === "hidden") {
      li.classList.add("screen-hidden-row");
      li.textContent = `${row.count} hidden`;
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
    button.setAttribute("aria-current", String(screen.name === activeScreen));

    const shown = displayName(node);
    if (treeMode) {
      button.classList.add("in-tree");
      if (shown !== node.name) {
        button.title = `${node.name}\n${[...ancestorNames(tree, node.name), node.name].join(" › ")}`;
      }
    }

    const nameEl = document.createElement("div");
    nameEl.className = "screen-item-name";
    if (treeMode && node.parent) {
      const icon = createKindIcon(screen.variant_kind);
      if (icon) nameEl.appendChild(icon);
    }
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
    if (node.children.length > 0) {
      const total = document.createElement("span");
      total.className = "screen-item-total";
      total.textContent = String(node.total);
      total.title = `${node.total} variant${node.total === 1 ? "" : "s"}`;
      nameEl.appendChild(total);
    }
    button.appendChild(nameEl);

    if (showTags && screen.tags.length > 0) {
      const tagRow = document.createElement("div");
      tagRow.className = "tag-row";
      // While filtering, the chips that match come first so the reason for
      // the row is visible without opening the "+N".
      const tagMatches = (tag) => needle !== "" && tag.toLowerCase().includes(needle);
      const ordered = [...screen.tags].sort(
        (a, b) => Number(tagMatches(b)) - Number(tagMatches(a)),
      );
      const rest = ordered.length > MAX_VISIBLE_TAGS ? ordered.length - MAX_VISIBLE_TAGS : 0;
      for (const tag of ordered.slice(0, ordered.length - rest)) {
        const chip = document.createElement("span");
        chip.className = "tag-chip";
        if (tagMatches(tag)) chip.classList.add("match");
        chip.textContent = tag;
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
      button.appendChild(tagRow);
    }

    button.addEventListener("click", () => onSelect(screen.name));
    li.appendChild(button);

    if (node.children.length > 0) {
      // Sibling of the select button for the same reason as the pin button
      // below — nested interactive elements are invalid HTML.
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "screen-item-toggle";
      toggle.setAttribute("aria-expanded", String(row.expanded));
      toggle.setAttribute("aria-label", `${row.expanded ? "Collapse" : "Expand"} ${screen.name}`);
      toggle.textContent = row.expanded ? "▾" : "▸";
      // Disabled while the filter holds the row open — a click would change
      // the saved expand state without any visible effect.
      if (row.forcedOpen) toggle.disabled = true;
      toggle.addEventListener("click", (evt) => {
        evt.stopPropagation();
        onToggleExpand?.(screen.name);
      });
      // Before the select button in DOM order so Tab follows the visual
      // order (the toggle is positioned at the row's left edge).
      li.insertBefore(toggle, button);
    }

    if (onTogglePin) {
      const subtree = subtreeNames(node);
      const isPinned = subtree.every((name) => pinned?.has(name));
      const label =
        node.children.length > 0
          ? `${screen.name} and its ${node.total} variant${node.total === 1 ? "" : "s"}`
          : screen.name;
      // A sibling of `button.screen-item`, not a child — two nested
      // interactive elements would be invalid HTML (and unfocusable via
      // keyboard for the inner one in most browsers).
      const pinButton = document.createElement("button");
      pinButton.type = "button";
      pinButton.className = "screen-item-pin pin-button";
      pinButton.classList.toggle("pinned", isPinned);
      pinButton.setAttribute("aria-label", `${isPinned ? "Unpin" : "Pin"} ${label}`);
      pinButton.setAttribute("aria-pressed", String(isPinned));
      pinButton.innerHTML = PIN_ICON_SVG;
      pinButton.addEventListener("click", (evt) => {
        // NOT guarding `button.screen-item`'s own select handler — it's a
        // SIBLING of this button, not an ancestor, so bubbling from here
        // could never reach it regardless. This stops the click at `li`
        // instead, in case a delegated click handler is ever added on the
        // row or the list (review fix 7).
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
