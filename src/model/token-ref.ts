import type { MixedTokenValue, TokenRef, TokenRefAtom } from "./types.js";

/** True when `ref` is a mixed literal/ref value rather than a single atom. */
export function isMixedTokenValue(ref: TokenRef): ref is MixedTokenValue {
  return typeof ref === "object" && ref !== null && "parts" in ref;
}

function atomPaths(atom: TokenRefAtom): string[] {
  if (typeof atom === "string") return [atom];
  return atom.args.filter((arg): arg is string => typeof arg === "string");
}

/**
 * Every dot-path a ref resolves through, in order — a plain ref's own path,
 * a modifier call's path args, or (for a mixed value) every atom's paths in
 * `parts` order. `parts` alternates literal/atom starting and ending on a
 * literal, so atoms sit at the odd indices.
 */
export function tokenRefPaths(ref: TokenRef): string[] {
  if (isMixedTokenValue(ref)) {
    const paths: string[] = [];
    for (let i = 1; i < ref.parts.length; i += 2) {
      paths.push(...atomPaths(ref.parts[i] as TokenRefAtom));
    }
    return paths;
  }
  return atomPaths(ref);
}
