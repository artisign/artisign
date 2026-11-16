// Use Cases tab — the reusable pieces of the uc-* design components (avatar, status, diff badge, target chip, data card,
// variant / filter chip, segmented control). One builder per component so every view draws them identically.

import { h, icon } from "./usecases-dom.js";
import { STATUS_LABELS, exampleLines, safeColor } from "./usecases-data.js";

/** `uc-avatar`: the emoji (or initials) on the persona's own colour — persona data, set as `--avatar-color`, not a token. */
export function avatar(av, size = "md", title = "") {
  if (av.kind === "system") return h("span", { class: "uc-avatar", dataset: { size, kind: "system" }, title: title || "System" }, icon("memory"));
  return h("span", { class: "uc-avatar", dataset: { size, kind: av.kind }, style: safeColor(av.color) ? { "--avatar-color": safeColor(av.color) } : null, title }, av.text);
}

export function statusBadge(status) {
  const label = STATUS_LABELS[status] ?? status;
  return h("span", { class: "uc-status", dataset: { status } }, h("span", { class: "uc-status-dot", "aria-hidden": "true" }), label);
}

export function statusDot(status) {
  return h("span", { class: "uc-status-dot", dataset: { status }, title: STATUS_LABELS[status] ?? status, role: "img", "aria-label": STATUS_LABELS[status] ?? status });
}

const DIFF = {
  changed: { icon: "edit", label: "Changed" },
  added: { icon: "add", label: "Added" },
  removed: { icon: "remove", label: "Removed" },
  base: { icon: "check", label: "From base" },
};

/** `uc-diff-badge`: changed / added / removed / base. */
export function diffBadge(kind) {
  const spec = DIFF[kind] ?? DIFF.changed;
  return h("span", { class: "uc-diff", dataset: { kind } }, icon(spec.icon), spec.label);
}

const SCOPE = {
  element: { icon: "ads_click", label: "Element" },
  screen: { icon: "web_asset", label: "Screen" },
  stale: { icon: "link_off", label: "Stale" },
};

/** `uc-target-chip`: badge (Element / Screen / Stale) + screen › node. `onClick` makes it a button that opens the mapping view. */
export function targetChip(scope, screen, node, onClick) {
  const spec = SCOPE[scope] ?? SCOPE.screen;
  const body = [
    h("span", { class: "uc-target-badge" }, icon(spec.icon), spec.label),
    // Truncation takes the screen part and keeps the node id.
    h("span", { class: "uc-target-label" }, h("span", { class: "uc-target-screen" }, screen), node ? h("span", { class: "uc-target-sep", "aria-hidden": "true" }, "›") : null, node ? h("span", { class: "uc-target-node" }, node) : null),
  ];
  const props = { class: "uc-target", dataset: { scope } };
  if (!onClick) return h("span", props, body);
  return h("button", { ...props, type: "button", onClick, title: scope === "stale" ? "Mapping is stale — open the mapping view" : "Show this step on its screen" }, body);
}

/** `uc-data-card`: before (dashed, muted) or after (raised); changed fields carry the accent highlight. */
export function dataCard(kind, objectName, example, highlight) {
  const lines = exampleLines(example, highlight);
  return h(
    "div",
    { class: "uc-data-card", dataset: { kind } },
    h("div", { class: "uc-data-head" }, h("span", null, kind === "before" ? "Before" : "After"), h("span", { class: "uc-data-object" }, objectName)),
    h(
      "div",
      { class: "uc-data-body" },
      lines.length === 0
        ? h("span", { class: "uc-muted" }, "none yet")
        : lines.map((line) => h("div", { class: line.changed ? "uc-data-line is-changed" : "uc-data-line" }, `${line.key}: ${line.text}`)),
    ),
  );
}

/** `uc-variant-chip` (default / selected / add). */
export function variantChip({ label, meta, selected = false, add = false, onClick, title }) {
  if (add) return h("button", { type: "button", class: "uc-variant-chip", dataset: { kind: "add" }, onClick, title }, icon("add"), label);
  return h("button", { type: "button", class: "uc-variant-chip", "aria-pressed": selected ? "true" : "false", onClick, title }, h("span", null, label), meta ? h("span", { class: "uc-variant-meta" }, meta) : null);
}

/** `uc-filter-chip`: inactive (label + chevron), active (label + × clears) or a toggle. */
export function filterChip({ label, active = false, open = false, toggle = false, onClick, onClear }) {
  if (toggle) {
    return h("button", { type: "button", class: "uc-filter-chip", dataset: { state: active ? "on" : "off", kind: "toggle" }, "aria-pressed": active ? "true" : "false", onClick }, icon(active ? "check_box" : "check_box_outline_blank"), label);
  }
  const main = h("button", { type: "button", class: "uc-filter-chip-main", "aria-haspopup": "menu", "aria-expanded": open ? "true" : "false", onClick }, label, active ? null : icon(open ? "expand_less" : "expand_more"));
  const chip = h("span", { class: "uc-filter-chip", dataset: { state: active ? "active" : open ? "open" : "idle" } }, main);
  if (active) chip.append(h("button", { type: "button", class: "uc-filter-clear", "aria-label": `Clear ${label}`, onClick: onClear }, icon("close")));
  return chip;
}

/** `uc-segmented`: a radiogroup of text options. Updates itself on selection (no re-render), so focus stays put. */
export function segmented({ label, options, value, onChange, name }) {
  let current = value;
  const group = h("div", { class: "uc-segmented", role: "radiogroup", "aria-label": label });
  const buttons = options.map((option) => h("button", { type: "button", role: "radio", dataset: { value: option.value, name }, onClick: () => select(option.value) }, option.label));
  const paint = () => buttons.forEach((button) => {
    const on = button.dataset.value === current;
    button.setAttribute("aria-checked", on ? "true" : "false");
    button.tabIndex = on ? 0 : -1;
  });
  function select(next, focus = false) {
    if (next !== current) {
      current = next;
      onChange?.(next);
    }
    paint();
    if (focus) buttons.find((button) => button.dataset.value === next)?.focus();
  }
  group.append(...buttons);
  group.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = options.findIndex((o) => o.value === current);
    event.preventDefault();
    select(options[(index + (event.key === "ArrowRight" ? 1 : options.length - 1)) % options.length].value, true);
  });
  paint();
  group.setValue = (next) => {
    current = next;
    paint();
  };
  return group;
}

/** A dimension/value pill: "Project size | large". */
export function traitChip(label, value, any = false) {
  return h("span", { class: any ? "uc-trait is-any" : "uc-trait" }, h("span", { class: "uc-trait-dim" }, label), h("span", { class: "uc-trait-value" }, value));
}
