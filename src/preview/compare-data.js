// CHR-738 — the pure half of compare mode (side-by-side variant compare):
// which screens form a family, how the member selection changes, and how the
// `/api/compare` response flattens into the diff list. compare.js owns the DOM.

import { subtreeNames } from "./screens.js";

/** Columns are the reference plus at most this many members (the server accepts 1-3 `others`). */
export const COMPARE_MAX_MEMBERS = 3;

/**
 * The variant family of `name`: its main screen (the root of the `variant_of`
 * chain) is the reference, every descendant at any depth is a possible member.
 * @param {ReturnType<import("./screens.js").buildScreenTree>} tree
 * @param {string | null} name
 * @returns {{ reference: string, members: string[] } | null} null for an unknown name
 */
export function familyOf(tree, name) {
  let node = name ? tree.nodes.get(name) : undefined;
  if (!node) return null;
  while (node.parent) node = node.parent;
  return { reference: node.name, members: subtreeNames(node).slice(1) };
}

/** Whether `name`'s family has any screen besides the reference to compare against. */
export function canCompare(tree, name) {
  return (familyOf(tree, name)?.members.length ?? 0) > 0;
}

/**
 * The selection on entering compare: the open screen first (unless it is the
 * main screen itself), then the members stored for this reference that still
 * exist, capped.
 * @param {{ reference: string, members: string[] }} family
 * @param {string} open
 * @param {string[]} stored
 * @returns {string[]}
 */
export function mergeSelection(family, open, stored) {
  const wanted = [open, ...stored].filter((name) => family.members.includes(name));
  return [...new Set(wanted)].slice(0, COMPARE_MAX_MEMBERS);
}

/**
 * Ticks or unticks `name`. The reference, a screen outside the family and a
 * member beyond the cap leave the selection unchanged.
 * @param {string[]} selected
 * @param {string} name
 * @param {{ reference: string, members: string[] }} family
 * @returns {string[]}
 */
export function toggleMember(selected, name, family) {
  if (selected.includes(name)) return selected.filter((n) => n !== name);
  if (!family.members.includes(name) || selected.length >= COMPARE_MAX_MEMBERS) return selected;
  return [...selected, name];
}

const SIGNS = [
  ["added", "+"],
  ["changed", "~"],
  ["removed", "−"],
];

/**
 * One row per node id and member for the compare panel's diff list: added,
 * then changed, then removed, members in response order within each.
 * @param {{ members: { screen: string, status: string, added: string[], changed: string[], removed: { id: string }[] }[] } | null} compare
 * @returns {{ sign: "+" | "~" | "−", kind: "added" | "changed" | "removed", id: string, member: string }[]}
 */
export function diffRows(compare) {
  const rows = [];
  for (const [kind, sign] of SIGNS) {
    for (const member of compare?.members ?? []) {
      if (member.status !== "ok") continue;
      for (const entry of member[kind]) rows.push({ sign, kind, id: typeof entry === "string" ? entry : entry.id, member: member.screen });
    }
  }
  return rows;
}

/** The share of ids a member has in common with the reference, as a whole percent. */
export function overlapPercent(member) {
  return Math.round(member.overlap.ratio * 100);
}

/**
 * Which of the flow / comment / inspect toggles are usable, and their tooltips.
 * Comment and inspect are off while comparing (there is no single canvas to
 * pick from); flow stays available because turning it on leaves compare —
 * flow mode navigates, and only Single does. A `null` title means "keep the
 * toggle's own".
 * @param {{ view: string, showMockup: boolean, comparing: boolean }} where
 */
export function modeToggleStates({ view, showMockup, comparing }) {
  const unavailable = "Not available while comparing variants";
  return {
    flow: { disabled: showMockup, title: comparing ? "Leaves Compare and follows flows in Single" : "" },
    comment: { disabled: view === "board" || showMockup || comparing, title: comparing ? unavailable : "" },
    inspect: { disabled: view === "board" || showMockup || comparing, title: comparing ? unavailable : null },
  };
}
