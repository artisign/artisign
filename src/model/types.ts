export type NodeId = string;
export type ScreenId = string;
export type TokenPath = string; // "<bucket>.<member>", bucket names come from tokens.json
export type ComponentName = string;
export type VariantName = string;
export type ModifierFn = "alpha" | "oklab" | "mix";

/** One binding unit: a plain dot-path, or a modifier function wrapping one. */
export type TokenRefAtom = TokenPath | { fn: ModifierFn; args: (TokenPath | number)[] };

/**
 * A CSS value made of literal text interspersed with one or more refs, e.g.
 * `border: 1px solid $color.border` or `padding: $spacing.sm $spacing.lg`.
 * `parts` strictly alternates literal/atom/literal/atom/...,
 * always starting and ending on a literal (possibly `""`) — so every atom
 * sits at an odd index and every literal chunk at an even one; that parity
 * is the only thing that tells an atom's bare dot-path apart from literal
 * text at the type level, since both are plain `string`s. Use
 * `tokenRefPaths`/`isMixedTokenValue` (./token-ref.ts) rather than reading
 * `parts` directly.
 */
export type MixedTokenValue = { parts: (string | TokenRefAtom)[] };

/**
 * A token binding: a plain dot-path or a modifier-function call (unchanged
 * shape, for backward compat with persisted screens/tests), or — when a ref
 * is mixed with literal text or a value carries more than one ref — a
 * `MixedTokenValue`.
 */
export type TokenRef = TokenRefAtom | MixedTokenValue;

export type NodeKind = "element" | "text" | "component_instance" | "svg" | "svg_path";

export type NodeRefs = {
  component?: ComponentName;
  variant?: VariantName;
  /** Keyed by CSS property, "fill"/"stroke", or "class" for a token-class ref. */
  tokens: Record<string, TokenRef>;
};

export type NodeSubtree = {
  kind: NodeKind;
  tag?: string;
  text?: string;
  attributes: Record<string, string>;
  refs: NodeRefs;
  inlineStyles: Record<string, string>;
  children: NodeSubtree[];
  /** Only meaningful when kind is "component_instance" — its content lives here, not in `children`. */
  slotOverrides?: Record<string, NodeSubtree>;
};

export type Node = {
  id: NodeId;
  parentId: NodeId | null;
  screenId: ScreenId;
  kind: NodeKind;
  tag?: string;
  text?: string;
  attributes: Record<string, string>;
  refs: NodeRefs;
  inlineStyles: Record<string, string>;
  slotOverrides?: Record<string, NodeSubtree>;
  childIds: NodeId[];
  /** Which augmentation syntax produced a component_instance — preserved across serialization. */
  instanceSyntax?: "class" | "data-attr";
};

export type FlowTriggerEvent = "tap" | "hover" | "longpress" | "swipe-left" | "swipe-right";

export type Flow = {
  triggerNodeId: NodeId;
  triggerEvent: FlowTriggerEvent;
  targetKind: "screen" | "node";
  targetId: string;
};

export type ScreenDocument = {
  id: ScreenId;
  title: string;
  sectionId: string | null;
  rootNodeId: NodeId;
  flows: Flow[];
  nodes: Record<NodeId, Node>;
};

export type ValidationErrorCode =
  | "unresolved_ref"
  | "ambiguous_class_ref"
  | "malformed_html"
  | "multi_ref_value"
  | "unknown_modifier"
  | "duplicate_node_id"
  | "unknown_flow_trigger"
  | "suspicious_attr";

export type ValidationWarningKind = "drift";

export type ValidationIssue = {
  code: ValidationErrorCode;
  message: string;
  nodeId?: NodeId;
};

export type ValidationWarning = {
  kind: ValidationWarningKind;
  message: string;
  nodeId?: NodeId;
  suggestion?: string;
};

export type ParseResult = {
  doc: ScreenDocument;
  errors: ValidationIssue[];
};
