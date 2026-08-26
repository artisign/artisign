// Formatting for the server's structured TokenRef shape (see
// src/model/token-ref.ts / src/model/types.ts) as returned by
// get_node/get_screen's `refs.token_refs`. Mirrors token-ref.ts's own
// `tokenRefPaths` deliberately — a ref's dot-paths are needed here too, to
// match a node's `data-unresolved-token` marker (read off the *rendered*
// element) against the specific ref that failed. This is the only
// server-side logic duplicated on the client, and only for that one
// small, stable helper — everything else (which refs a node carries at
// all, their authored display form) comes verbatim from the server.

/** @param {unknown} ref @returns {ref is { parts: unknown[] }} */
function isMixedTokenValue(ref) {
  return typeof ref === "object" && ref !== null && "parts" in ref;
}

/** @param {string | { fn: string, args: (string | number)[] }} atom @returns {string[]} */
function atomPaths(atom) {
  if (typeof atom === "string") return [atom];
  return atom.args.filter((arg) => typeof arg === "string");
}

/**
 * Every dot-path a ref resolves through — a plain ref's own path, a
 * modifier call's path args, or (for a mixed value) every atom's paths in
 * `parts` order (parts alternates literal/atom, atoms at the odd indices).
 * @param {import("./token-ref-format.js").TokenRef} ref
 * @returns {string[]}
 */
export function tokenRefPaths(ref) {
  if (isMixedTokenValue(ref)) {
    const paths = [];
    for (let i = 1; i < ref.parts.length; i += 2) paths.push(...atomPaths(ref.parts[i]));
    return paths;
  }
  return atomPaths(ref);
}

/** @param {string | { fn: string, args: (string | number)[] }} atom */
function formatAtom(atom) {
  if (typeof atom === "string") return `$${atom}`;
  const args = atom.args.map((arg) => (typeof arg === "string" ? `$${arg}` : String(arg)));
  return `${atom.fn}(${args.join(", ")})`;
}

/**
 * The authored `$`-prefixed display form of a token ref: a plain path
 * (`$color.accent`), a modifier call (`alpha($color.primary, 0.1)`), or a
 * mixed literal/ref value (`1px solid $color.border`).
 * @param {import("./token-ref-format.js").TokenRef} ref
 * @returns {string}
 */
export function formatTokenRef(ref) {
  if (isMixedTokenValue(ref)) {
    // parts alternates literal/atom, starting and ending on a literal —
    // atoms sit at the odd indices (same convention as tokenRefPaths).
    return ref.parts.map((part, i) => (i % 2 === 1 ? formatAtom(part) : part)).join("");
  }
  return formatAtom(ref);
}

/**
 * Whether a ref embeds one of the node's unresolved token paths (from
 * `data-unresolved-token` on the rendered element — see
 * inspector-data.js's `parseUnresolvedPaths`). Exact path equality, not a
 * substring test — `color.brand` must not flag `color.brand-old`.
 * @param {import("./token-ref-format.js").TokenRef} ref
 * @param {string[]} unresolvedPaths
 * @returns {boolean}
 */
export function isRefUnresolved(ref, unresolvedPaths) {
  return tokenRefPaths(ref).some((path) => unresolvedPaths.includes(path));
}
