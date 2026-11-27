// CHR-1268 — the Inspect panel's variant cards (design `inspector-variant-reached-from`): "Variant" (path, depth, siblings, flows in and out) and "Also reached from" (the screens with a flow into this variant, other than its home). Shown only for a screen that is a variant; pure DOM, the context comes from variants.js.

import { alsoReachedFrom, flowCounts } from "./variants.js";

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/**
 * @param {HTMLElement} container the section; emptied and hidden for a plain screen
 * @param {ReturnType<typeof import("./variants.js").variantContext>} ctx
 * @param {{ from: string, to: string }[]} flows
 * @param {string | null} current the open screen
 * @param {(screen: string) => void} go opens a screen (human navigation)
 */
export function renderVariantInspector(container, ctx, flows, current, go) {
  container.replaceChildren();
  container.hidden = !ctx || !ctx.parent || current === null;
  if (container.hidden || !ctx || current === null) return;

  const counts = flowCounts(flows, current);
  const variant = el("div", "inspect-card");
  const head = el("div", "inspect-card-head");
  head.append(el("b", "", "Variant"), el("span", "inspect-card-meta", ctx.kind ?? ""));
  variant.append(head);
  const rows = [
    ["Path", ctx.chain.slice(0, -1).map((n) => n.name).join(" › ")],
    ["Depth", String(ctx.depth - 1)],
    ["Siblings", ctx.siblings.map((n) => n.name).join(", ") || "none"],
    ["Flows", `${counts.in} in, ${counts.out} out`],
  ];
  for (const [label, value] of rows) {
    const row = el("div", "inspect-kv");
    const v = el("span", "inspect-kv-value", value);
    v.title = value;
    row.append(el("span", "inspect-kv-label", label), v);
    variant.append(row);
  }
  container.append(variant);

  const sources = alsoReachedFrom(flows, current, ctx.parent.name);
  if (sources.length > 0) {
    const card = el("div", "inspect-card");
    const cardHead = el("div", "inspect-card-head");
    cardHead.append(el("b", "", "Also reached from"), el("span", "inspect-card-meta", `${sources.length} flow source${sources.length === 1 ? "" : "s"}`));
    card.append(cardHead);
    for (const source of sources) {
      const row = el("div", "inspect-kv");
      const link = el("button", "inspect-kv-value inspect-kv-link", source);
      link.type = "button";
      link.title = `Open ${source}`;
      link.dataset.screen = source;
      link.addEventListener("click", () => go(source));
      row.append(el("span", "inspect-kv-label", "Flow"), link);
      card.append(row);
    }
    container.append(card);
  }
}
