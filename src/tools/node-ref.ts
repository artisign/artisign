import { ToolError } from "./types.js";

/** A node inside a screen (`screens/<screen>.html`). */
export type ScreenNodeRef = { kind: "screen"; screen: string; nodeId: string };
/** A node inside one variant of a `design-system/components/<name>.html` definition. */
export type ComponentNodeRef = { kind: "component"; name: string; variant: string; nodeId: string; address: string };
/** A node inside a `design-system/patterns/<name>.html` definition. */
export type PatternNodeRef = { kind: "pattern"; name: string; nodeId: string; address: string };
/** A node inside a component or pattern definition — the union `loadAllDocuments`'s `SourceDoc.address` addresses (ADR-004). */
export type DefinitionNodeRef = ComponentNodeRef | PatternNodeRef;
export type NodeRef = ScreenNodeRef | DefinitionNodeRef;

/**
 * Parses a node ref. Two forms, distinguished by a `component:`/`pattern:`
 * prefix (ADR-004 §1 "Address scheme — extend, don't fork"):
 *   - `"<screen>.<node-id>"` — unchanged, screen stems don't contain dots.
 *   - `"component:<name>#<variant>.<node-id>"` / `"pattern:<name>.<node-id>"`
 *     — a component/pattern definition, addressed the same way
 *     `loadAllDocuments` (`SourceDoc.address`) already addresses it.
 */
export function parseNodeRef(ref: string): NodeRef {
  if (ref.startsWith("component:")) return parseComponentRef(ref);
  if (ref.startsWith("pattern:")) return parsePatternRef(ref);

  const dot = ref.indexOf(".");
  if (dot === -1 || dot === 0 || dot === ref.length - 1) {
    throw new ToolError("validation_failed", `malformed node ref "${ref}" — expected "<screen>.<node-id>"`);
  }
  return { kind: "screen", screen: ref.slice(0, dot), nodeId: ref.slice(dot + 1) };
}

function parseComponentRef(ref: string): ComponentNodeRef {
  const rest = ref.slice("component:".length);
  const hash = rest.indexOf("#");
  const malformed = (): never => {
    throw new ToolError("validation_failed", `malformed node ref "${ref}" — expected "component:<name>#<variant>.<node-id>"`);
  };
  if (hash <= 0) malformed();
  const name = rest.slice(0, hash);
  const afterHash = rest.slice(hash + 1);
  const dot = afterHash.indexOf(".");
  if (dot <= 0 || dot === afterHash.length - 1) malformed();
  const variant = afterHash.slice(0, dot);
  const nodeId = afterHash.slice(dot + 1);
  return { kind: "component", name, variant, nodeId, address: `component:${name}#${variant}` };
}

function parsePatternRef(ref: string): PatternNodeRef {
  const rest = ref.slice("pattern:".length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) {
    throw new ToolError("validation_failed", `malformed node ref "${ref}" — expected "pattern:<name>.<node-id>"`);
  }
  const name = rest.slice(0, dot);
  const nodeId = rest.slice(dot + 1);
  return { kind: "pattern", name, nodeId, address: `pattern:${name}` };
}

/** `address` is a screen name for a screen ref, or a `SourceDoc.address` (`component:<name>#<variant>` / `pattern:<name>`) for a definition ref — both formats already carry everything needed to prefix a node id. */
export function formatNodeRef(address: string, nodeId: string): string {
  return `${address}.${nodeId}`;
}

/**
 * Narrows a parsed ref to a screen ref, for tools that don't address
 * component/pattern nodes yet (see ADR-004 §1). A definition ref fails with
 * `validation_failed`, not a generic parse failure, since the ref itself
 * parsed fine.
 */
export function requireScreenNodeRef(ref: NodeRef, toolName: string): ScreenNodeRef {
  if (ref.kind !== "screen") {
    throw new ToolError("validation_failed", `${toolName} does not support component/pattern node refs yet`);
  }
  return ref;
}
