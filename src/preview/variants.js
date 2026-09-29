// CHR-732 — the screen view's variant context: a breadcrumb bar above the
// canvas, a variant tree map beside it, and the inspector's "Variant" and
// "Also reached from" cards. Everything is derived from /api/screens (the
// stored `variant_of` chain — never the flow arrival path) and /api/flows.
// The pure functions come first, the DOM wiring (createVariantUI) last.

import { buildScreenTree, displayName, createKindIcon } from "./screens.js";

/** The screen part of a flow ref — "screen" or "screen.node-id". */
export function screenOfRef(ref) {
  const dot = ref.indexOf(".");
  return dot === -1 ? ref : ref.slice(0, dot);
}

/**
 * The variant cluster context of `name`, or null for a plain screen (no
 * parent, no variants) or an unknown name. A dangling parent never reaches
 * here — buildScreenTree already treats it as a root.
 * @param {ReturnType<typeof buildScreenTree>} tree
 * @param {string | null} name
 */
export function variantContext(tree, name) {
  const node = name ? tree.nodes.get(name) : undefined;
  if (!node || (!node.parent && node.children.length === 0)) return null;
  const chain = [];
  for (let n = node; n; n = n.parent) chain.unshift(n);
  return {
    node,
    chain,
    root: chain[0],
    parent: node.parent,
    kind: node.screen.variant_kind,
    /** 1-based: the number of crumbs, so a direct variant of the root is depth 2. */
    depth: chain.length,
    children: node.children,
    siblings: node.parent ? node.parent.children.filter((c) => c !== node) : [],
  };
}

/**
 * Distinct screens with a flow edge into `name` (screen- or node-targeted),
 * in first-seen order. Excludes `name` itself and its variant_of parent —
 * the "home" is already the breadcrumb.
 * @param {{ from: string, to: string }[]} flows
 * @param {string} name
 * @param {string | null} parentName
 * @returns {string[]}
 */
export function alsoReachedFrom(flows, name, parentName) {
  const sources = [];
  for (const flow of flows) {
    if (screenOfRef(flow.to) !== name) continue;
    const from = screenOfRef(flow.from);
    if (from === name || from === parentName || sources.includes(from)) continue;
    sources.push(from);
  }
  return sources;
}

/** Edge counts into / out of `name`, self-loops excluded. */
export function flowCounts(flows, name) {
  let into = 0;
  let out = 0;
  for (const flow of flows) {
    const from = screenOfRef(flow.from);
    const to = screenOfRef(flow.to);
    if (from === to) continue;
    if (to === name) into += 1;
    if (from === name) out += 1;
  }
  return { in: into, out };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const b = el("button", className, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * @param {{ barEl: HTMLElement, mapEl: HTMLElement, inspectorEl: HTMLElement, onSelect: (screen: string) => void }} els
 * @returns {{ update: (screens: object[], flows: object[], currentScreen: string | null) => boolean }}
 *   `update` re-renders everything and returns whether the bar/map are showing,
 *   so the caller can re-fit the canvas when that changes.
 */
export function createVariantUI({ barEl, mapEl, inspectorEl, onSelect }) {
  let openCrumb = null;
  let last = { screens: [], flows: [], currentScreen: null };
  // Where keyboard focus goes after the next render instead of the element
  // that had it: the popover's first row on open, the crumb's toggle on close.
  let focusNext = null;

  const rerender = () => update(last.screens, last.flows, last.currentScreen);
  const go = (name) => {
    openCrumb = null;
    onSelect(name);
  };

  document.addEventListener("click", (evt) => {
    if (openCrumb && !evt.target.closest?.(".crumb-group, .variant-pop")) {
      openCrumb = null;
      rerender();
    }
  });
  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape" && openCrumb) {
      // Closing the popover is this Escape's whole job — app.js's
      // inspect-mode Escape (registered later) must not also fire.
      evt.stopImmediatePropagation();
      focusNext = { cls: "crumb-toggle", screen: openCrumb };
      openCrumb = null;
      rerender();
    }
  });

  /** A render replaces every control, so focus is remembered by role + screen and put back. */
  function focusKey() {
    const active = document.activeElement;
    if (!active || ![barEl, mapEl, inspectorEl].some((c) => c.contains(active))) return null;
    return { cls: active.classList[0], screen: active.dataset.screen ?? active.closest("[data-screen]")?.dataset.screen };
  }

  function restoreFocus(key) {
    if (!key) return;
    for (const container of [barEl, mapEl, inspectorEl]) {
      for (const candidate of container.querySelectorAll(`.${key.cls}`)) {
        const screen = candidate.dataset.screen ?? candidate.closest("[data-screen]")?.dataset.screen;
        if (screen === key.screen) {
          candidate.focus();
          return;
        }
      }
    }
  }

  function popoverRow(name, current) {
    const row = button("variant-pop-row", "", () => go(name));
    row.dataset.screen = name;
    const kind = last.tree.nodes.get(name)?.screen.variant_kind;
    const icon = createKindIcon(kind);
    if (icon) row.appendChild(icon);
    row.appendChild(el("span", "variant-pop-name", name));
    if (name === current) {
      row.classList.add("current");
      row.appendChild(el("span", "variant-pop-current", "current"));
    }
    row.title = name;
    return row;
  }

  function renderPopover(node, current) {
    const pop = el("div", "variant-pop");
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", `Variants around ${node.name}`);
    if (node.children.length > 0) {
      pop.appendChild(el("h4", "", `Inside ${node.name} · ${node.children.length}`));
      for (const child of node.children) pop.appendChild(popoverRow(child.name, current));
    }
    const siblings = node.parent ? node.parent.children.filter((c) => c !== node) : [];
    if (siblings.length > 0) {
      pop.appendChild(el("h4", "", `Siblings in ${node.parent.name} · ${siblings.length}`));
      for (const sibling of siblings) pop.appendChild(popoverRow(sibling.name, current));
    }
    const itself = button("variant-pop-row variant-pop-itself", `Open ${node.name} itself`, () => go(node.name));
    if (node.name === current) itself.classList.add("current");
    pop.appendChild(itself);
    return pop;
  }

  function renderBar(ctx, current) {
    barEl.innerHTML = "";
    ctx.chain.forEach((node, i) => {
      if (i > 0) barEl.appendChild(el("span", "crumb-sep", "›"));
      const group = el("span", "crumb-group");
      group.dataset.screen = node.name;
      group.classList.toggle("on", node.name === current);
      group.classList.toggle("open", openCrumb === node.name);
      const crumb = button("crumb", "", () => go(node.name));
      crumb.setAttribute("aria-current", String(node.name === current));
      crumb.title = node.name;
      if (i === 0) crumb.appendChild(el("span", "crumb-home", "⌂"));
      else {
        const icon = createKindIcon(node.screen.variant_kind);
        if (icon) crumb.appendChild(icon);
      }
      const name = el("span", "crumb-name");
      // Long names truncate from the left (the distinguishing suffix stays);
      // <bdi> keeps the characters in reading order under direction: rtl.
      const text = document.createElement("bdi");
      text.textContent = node.name;
      name.appendChild(text);
      crumb.appendChild(name);
      const toggle = button("crumb-toggle", "▾", (evt) => {
        evt.stopPropagation();
        openCrumb = openCrumb === node.name ? null : node.name;
        focusNext = openCrumb ? { cls: "variant-pop-row", screen: null } : { cls: "crumb-toggle", screen: node.name };
        rerender();
      });
      toggle.setAttribute("aria-expanded", String(openCrumb === node.name));
      toggle.setAttribute("aria-label", `Variants around ${node.name}`);
      group.append(crumb, toggle);
      if (openCrumb === node.name) group.appendChild(renderPopover(node, current));
      barEl.appendChild(group);
    });
    barEl.appendChild(el("span", "variant-bar-spacer"));
    if (ctx.parent) {
      barEl.appendChild(el("span", "variant-chip", `depth ${ctx.depth}`));
      if (ctx.kind) barEl.appendChild(el("span", `variant-chip variant-chip-${ctx.kind}`, ctx.kind));
      barEl.appendChild(button("variant-back", `⤴ Back to ${ctx.root.name}`, () => go(ctx.root.name)));
    } else {
      barEl.appendChild(el("span", "variant-chip", `${ctx.node.total} variant${ctx.node.total === 1 ? "" : "s"}`));
    }
  }

  function renderMap(ctx, current) {
    mapEl.innerHTML = "";
    const card = el("div", "variant-map-card");
    card.appendChild(el("h3", "", `Variant tree · ${ctx.root.name}`));
    const onPath = new Set(ctx.chain);
    const visit = (node) => {
      const row = button("map-node", "", () => go(node.name));
      row.dataset.screen = node.name;
      row.style.setProperty("--indent", `${node.depth * 12}px`);
      row.classList.toggle("on", node.name === current);
      row.classList.toggle("dim", !onPath.has(node));
      row.setAttribute("aria-current", String(node.name === current));
      row.title = node.name;
      if (node === ctx.root) row.appendChild(el("span", "crumb-home", "⌂"));
      else {
        const icon = createKindIcon(node.screen.variant_kind);
        if (icon) row.appendChild(icon);
      }
      row.appendChild(el("span", "map-node-name", displayName(node)));
      const expanded = onPath.has(node);
      if (node === ctx.root) row.appendChild(el("span", "map-node-note", "base"));
      else if (!expanded && node.children.length > 0) row.appendChild(el("span", "map-node-note", `▸ ${node.total}`));
      card.appendChild(row);
      if (expanded) node.children.forEach(visit);
    };
    visit(ctx.root);
    mapEl.appendChild(card);
  }

  function renderInspector(ctx, flows, current) {
    inspectorEl.innerHTML = "";
    if (!ctx.parent) return false;
    const variant = el("div", "variant-card");
    variant.appendChild(el("h3", "", "Variant"));
    const counts = flowCounts(flows, current);
    const rows = [
      ["Path", ctx.chain.slice(0, -1).map((n) => n.name).join(" › ")],
      ["Kind", ctx.kind ?? "—"],
      ["Depth", String(ctx.depth)],
      ["Siblings", String(ctx.siblings.length)],
      ["Flows in / out", `${counts.in} / ${counts.out}`],
    ];
    for (const [label, value] of rows) {
      const kv = el("div", "variant-kv");
      kv.appendChild(el("span", "", label));
      const b = el("b", "", value);
      b.title = value;
      kv.appendChild(b);
      variant.appendChild(kv);
    }
    inspectorEl.appendChild(variant);

    const sources = alsoReachedFrom(flows, current, ctx.parent.name);
    if (sources.length > 0) {
      const card = el("div", "variant-card also-reached");
      card.appendChild(el("h3", "", `Also reached from · ${sources.length} flow source${sources.length === 1 ? "" : "s"}`));
      for (const source of sources) {
        const link = button("variant-link", source, () => go(source));
        link.dataset.screen = source;
        card.appendChild(link);
      }
      card.appendChild(el("p", "variant-home-note", `Home = ${ctx.parent.name} (only variant-of).`));
      inspectorEl.appendChild(card);
    }
    return true;
  }

  function update(screens, flows, currentScreen) {
    const key = focusNext ?? focusKey();
    focusNext = null;
    const shown = render(screens, flows, currentScreen);
    if (key?.cls === "variant-pop-row" && key.screen === null) barEl.querySelector(".variant-pop-row")?.focus();
    else restoreFocus(key);
    return shown;
  }

  function render(screens, flows, currentScreen) {
    const tree = buildScreenTree(screens);
    last = { screens, flows, currentScreen, tree };
    const ctx = variantContext(tree, currentScreen);
    if (!ctx) {
      openCrumb = null;
      barEl.hidden = true;
      mapEl.hidden = true;
      inspectorEl.hidden = true;
      barEl.innerHTML = "";
      mapEl.innerHTML = "";
      inspectorEl.innerHTML = "";
      return false;
    }
    if (openCrumb && !ctx.chain.some((n) => n.name === openCrumb)) openCrumb = null;
    renderBar(ctx, currentScreen);
    renderMap(ctx, currentScreen);
    inspectorEl.hidden = !renderInspector(ctx, flows, currentScreen);
    barEl.hidden = false;
    mapEl.hidden = false;
    return true;
  }

  return { update };
}
