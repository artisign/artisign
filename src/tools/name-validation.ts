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
