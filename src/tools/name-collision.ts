import type { Store } from "../store/index.js";
import { loadRegistry, type NodeSubtree, type ScreenDocument } from "../model/index.js";
import { loadAllDocuments, type SourceDoc } from "./definitions.js";
import { formatNodeRef } from "./node-ref.js";
import { ToolError, type Warning } from "./types.js";

// `class="$name"` resolves against component names AND bare token member
// names (parser.ts `resolveClassRef`). When both match, the node parses as a
// plain element, so introducing the second meaning silently unbinds every
// node using the first. These checks run BEFORE the write, against documents
// parsed with the pre-write registry, so the bound nodes are still visible.

const MAX_LISTED = 10;

type Unit = { kind: string; refs: { component?: string; tokens: Record<string, unknown> } };

function collectMatches(sources: SourceDoc[], matches: (unit: Unit, syntax: "class" | "data-attr" | undefined) => boolean): string[] {
  const found = new Set<string>();
  for (const source of sources) {
    for (const node of Object.values(source.doc.nodes)) {
      if (matches(node, node.instanceSyntax)) found.add(formatNodeRef(source.address, node.id));
      // Slot fills are never in doc.nodes; the owner is the addressable node. Screens are re-serialized and the serializer writes every fill in class form; definitions are stored verbatim, so only there a data-component fill stays one.
      const visit = (sub: NodeSubtree): void => {
        if (matches(sub, source.kind === "screen" ? "class" : (sub.instanceSyntax ?? "class"))) found.add(`${formatNodeRef(source.address, node.id)} (slot fill)`);
        for (const child of sub.children) visit(child);
        for (const child of Object.values(sub.slotOverrides ?? {})) visit(child);
      };
      for (const sub of Object.values(node.slotOverrides ?? {})) visit(sub);
    }
  }
  const sorted = [...found].sort();
  return sorted.length > MAX_LISTED ? [...sorted.slice(0, MAX_LISTED), `+${sorted.length - MAX_LISTED} more`] : sorted;
}

function ambiguousWarning(name: string): Warning {
  return {
    kind: "ambiguous_ref",
    target: name,
    message: `"${name}" is now both a component and a bare token member name — class="$${name}" cannot resolve; use a dot-path token ref or data-component, or rename one of them`,
  };
}

/**
 * Call before adding token members (any names; only those new to the registry
 * count). For each new bare member name that equals a component name: refuses (`conflict`) when class-form instances
 * `class="$name"` would lose their binding, otherwise warns `ambiguous_ref`.
 */
export async function checkNewTokenMembers(store: Store, newMembers: string[]): Promise<Warning[]> {
  const registry = await loadRegistry(store);
  const colliding = [...new Set(newMembers)].filter((m) => registry.componentNames.has(m) && !registry.tokenFlatNames.has(m)).sort();
  if (colliding.length === 0) return [];

  const { docs } = await loadAllDocuments(store, registry);
  const warnings: Warning[] = [];
  for (const name of colliding) {
    const affected = collectMatches(docs, (u, syntax) => u.kind === "component_instance" && u.refs.component === name && syntax === "class");
    if (affected.length > 0) {
      throw new ToolError(
        "conflict",
        `token member "${name}" would shadow component "${name}": class="$${name}" would stop binding the component on ${affected.join(", ")}. Rename the token member, or first switch those nodes to data-component="${name}" or a dot-path token ref.`,
      );
    }
    warnings.push(ambiguousWarning(name));
  }
  return warnings;
}

/**
 * Call before creating a component. When its name equals a bare token member
 * name: refuses (`conflict`) when nodes currently use `class="$name"` as the
 * token class — on disk or inside `incoming` (the definition being written,
 * parsed with the pre-write registry) — otherwise warns `ambiguous_ref`.
 * `breaksNewInstances` is for promote_to_system, whose new instances are
 * class-form themselves and would be born ambiguous — always a conflict there.
 */
export async function checkNewComponentName(
  store: Store,
  name: string,
  options: { incoming?: ScreenDocument[]; breaksNewInstances?: boolean } = {},
): Promise<Warning[]> {
  const registry = await loadRegistry(store);
  if (!registry.tokenFlatNames.has(name)) return [];

  const { docs } = await loadAllDocuments(store, registry);
  const affected = collectMatches(docs, (u) => u.kind === "element" && u.refs.tokens.class === name);
  const incoming: SourceDoc[] = (options.incoming ?? []).map((doc) => ({ kind: "component", name, address: name, doc }));
  if (collectMatches(incoming, (u) => u.kind === "element" && u.refs.tokens.class === name).length > 0) affected.push("the new definition");
  if (affected.length > 0 || options.breaksNewInstances) {
    const where = affected.length > 0 ? ` and would stop resolving as the token class on ${affected.join(", ")}` : "";
    throw new ToolError(
      "conflict",
      `component "${name}" collides with the bare token member "${name}": class="$${name}" would be ambiguous${where}. Rename the component, or rename the token member (nodes can use a dot-path token ref or data-component to avoid the shared namespace).`,
    );
  }
  return [ambiguousWarning(name)];
}
