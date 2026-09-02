import { ToolError } from "./types.js";

/**
 * The node address scheme reserves all three characters: `:` separates the
 * prefix from the name (`component:btn-primary`), `#` separates the variant
 * (`#hover`), `.` separates the node id (`.n2`). A screen, component or
 * pattern name containing one of them produces refs that cannot be parsed
 * back, so every write entry point accepting a *new* name validates it here
 * — one shared function rather than a regex per call site (ADR-004).
 *
 * Token names are deliberately not covered: they are dot-paths by design
 * (`color.primary`) and are never part of a node ref.
 */
const RESERVED_CHARS = [":", "#", "."];

export function assertValidEntityName(kind: "screen" | "component" | "pattern", name: string): void {
  const used = RESERVED_CHARS.filter((char) => name.includes(char));
  if (used.length === 0) return;
  throw new ToolError(
    "validation_failed",
    `${kind} name "${name}" must not contain ${used.map((c) => `"${c}"`).join(", ")} — the node address scheme reserves ":", "#" and "."`,
  );
}

/**
 * A variant name is part of the same address scheme (`component:btn-primary#hover`
 * — `#` is what separates it), so it carries the three reserved characters
 * too. On top of that it is written into a definition file as an attribute
 * value (`<template data-variant="…">`), where a quote or an angle bracket
 * breaks out of the attribute and writes markup the caller never asked for
 * (CHR-556). Rejected rather than escaped, for the same reason entity names
 * are: a name that only works once escaped is not a name the address scheme
 * can hand back. Whitespace is out for the same reason — `data-variant="a b"`
 * survives the file, but `#a b` does not survive an address.
 *
 * Both doors run the same rule: `promote_to_system` checks the caller's list
 * before the file is assembled, `write_html` checks the parsed definition's
 * `data-variant` values (CHR-555's lesson).
 */
const VARIANT_FORBIDDEN_CHARS = [...RESERVED_CHARS, '"', "<", ">", "&"];

export function assertValidVariantName(name: string): void {
  if (name.length === 0) {
    throw new ToolError("validation_failed", "variant name must not be empty");
  }
  if (/\s/.test(name)) {
    throw new ToolError("validation_failed", `variant name "${name}" must not contain whitespace`);
  }
  const used = VARIANT_FORBIDDEN_CHARS.filter((char) => name.includes(char));
  if (used.length === 0) return;
  throw new ToolError(
    "validation_failed",
    `variant name "${name}" must not contain ${used.map((c) => `"${c}"`).join(", ")} — ":", "#" and "." are reserved by the node address scheme, and '"', "<", ">", "&" cannot be written into a data-variant attribute`,
  );
}
