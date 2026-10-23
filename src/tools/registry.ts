import { z, type ZodRawShape } from "zod";
import type { Store } from "../store/index.js";
import type { ToolHandlerContext } from "./types.js";
import {
  getProject,
  getScreen,
  getNode,
  getDesignSystem,
  findNodes,
  listComments,
} from "./reads.js";
import { writeHtml, patchHtml, updateRefs, setTokens, setFlow } from "./writes.js";
import { initProjectTool, listProjects, importHtml, promoteToSystem, deleteEntity } from "./lifecycle.js";
import { replyComment } from "./comments.js";
import { getScreenshot } from "./screenshot.js";
import { inspectNode } from "./inspect-node.js";
import { BROWSER_KINDS } from "./browser.js";
import { setMeta } from "./meta.js";
import { getGuide } from "./guide.js";
import { writeMockup, getMockup, promoteMockup } from "./mockups.js";
import { setBoardState } from "./board-state.js";

const viewSchema = z.enum(["summary", "tree", "full"]);
const responseModeSchema = z.enum(["summary", "diff", "full"]);
const flowEventSchema = z.enum(["tap", "hover", "longpress", "swipe-left", "swipe-right"]);
const publicFlowSchema = z.object({
  from: z.string(),
  event: flowEventSchema,
  to: z.string(),
  to_kind: z.enum(["screen", "node"]),
});

const tokenValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.record(z.string(), tokenValueSchema.nullable())]),
);

const metaTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("screen"), screen: z.string() }),
  z.object({ kind: z.literal("mockup"), mockup: z.string() }),
  z.object({ kind: z.literal("design_system") }),
  z.object({ kind: z.literal("component"), name: z.string() }),
  z.object({ kind: z.literal("pattern"), name: z.string() }),
  z.object({ kind: z.literal("tag"), tag: z.string() }),
]);
const setMetaDecisionSchema = z.object({
  id: z.string(),
  date: z.string().optional(),
  title: z.string(),
  body: z.string(),
  status: z.enum(["active", "superseded"]).optional(),
});

const pinsPatchSchema = z.union([
  // Capped: every unknown name costs a warning in the response.
  z.object({ op: z.enum(["add", "remove", "set"]), screens: z.array(z.string()).max(500) }),
  z.object({ op: z.literal("clear") }),
]);

const predicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("style_ref"), ref_path: z.string() }),
  z.object({ kind: z.literal("component_ref"), component_name: z.string() }),
  z.object({ kind: z.literal("variant"), variant: z.string() }),
  z.object({ kind: z.literal("has_comments") }),
  z.object({ kind: z.literal("text_match"), pattern: z.string() }),
  z.object({ kind: z.literal("has_flow") }),
]);

export type ToolDefinition = {
  name: string;
  description: string;
  inputShape: ZodRawShape;
  handler: (store: Store, input: Record<string, unknown>, ctx?: ToolHandlerContext) => Promise<unknown>;
  /**
   * False only for a tool that doesn't need an already-open project —
   * `init_project`, which builds its own `Store` from `input.dir` and never
   * touches the ambient one, and `get_guide`, which reads a file shipped
   * with the package and touches no `Store` at all. Lets `/mcp` and
   * `/api/tools/*` build/run with zero projects open: the caller passes
   * `store: undefined` in that case, and every other
   * tool reports a clean "no project open" error instead of crashing on it.
   */
  requiresProject?: boolean;
};

function tool(
  name: string,
  description: string,
  inputShape: ZodRawShape,
  handler: ToolDefinition["handler"],
  options?: { requiresProject?: boolean },
): ToolDefinition {
  return { name, description, inputShape, handler, requiresProject: options?.requiresProject };
}

export const TOOLS: ToolDefinition[] = [
  // Reads ---------------------------------------------------------------
  tool(
    "get_project",
    "Project root: screens, design-system pointer, counts — the cold-start read. view \"tree\" adds per-screen variant_of/variant_kind and viewport {width, height, declared}. fields: [\"reuse\"] adds design-system reuse coverage and the lowest-reuse screens. tags (any-of) filters screens and mockups and adds their tag_notes.",
    { view: viewSchema.optional(), fields: z.array(z.string()).optional(), tags: z.array(z.string()).optional() },
    (store, input) => getProject(store, input),
  ),
  tool(
    "get_screen",
    "One screen with comment/flow indicators. Tiered (default summary) with fields selection. view \"full\" adds variants and reached_from when non-empty; fields: [\"rendered_html\"] at \"full\" returns the resolved render as a standalone HTML document (MCP-only fallback, never default).",
    {
      screen: z.string(),
      view: viewSchema.optional(),
      fields: z.array(z.string()).optional(),
      output_format: z.enum(["html", "jsx"]).optional(),
    },
    (store, input) => getScreen(store, input as never),
  ),
  tool(
    "get_node",
    "Subtree of one node (node refs: see the server instructions). Tiered, with fields selection. view \"full\" on a component instance adds slots: its fills in document order, each with slot name, tag, refs and rendered id.",
    { node: z.string(), view: viewSchema.optional(), fields: z.array(z.string()).optional() },
    (store, input) => getNode(store, input as never),
  ),
  tool(
    "get_design_system",
    "Tokens, components (variants plus the default variant's slot names) and patterns. tree packs token values into one compact string per bucket; full adds per-path values and definition markup.",
    { view: viewSchema.optional(), fields: z.array(z.string()).optional() },
    (store, input) => getDesignSystem(store, input),
  ),
  tool(
    "find_nodes",
    "Where-query across screens and, always, component/pattern definitions (screens only narrows which screens). where: style_ref, component_ref, variant, has_comments, text_match, has_flow. Definition matches carry source and id_stability; a match inside a slot fill has node: null, addressable: false. Far cheaper than reading screens.",
    {
      where: z.array(predicateSchema),
      screens: z.array(z.string()).optional(),
      view: z.enum(["summary", "full"]).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
    (store, input) => findNodes(store, input as never),
  ),
  tool(
    "list_comments",
    "Open/resolved comments, filtered by screen or node.",
    {
      screen: z.string().optional(),
      node: z.string().optional(),
      status: z.enum(["open", "resolved", "any"]).optional(),
      include_replies: z.boolean().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
    (store, input) => listComments(store, input),
  ),
  tool(
    "list_projects",
    "Lists every project the daemon knows, each as {name, root, open}. Works with no project open. Pass a name as the project input of later calls.",
    {},
    (_store, _input, ctx) => listProjects(ctx),
    { requiresProject: false },
  ),
  tool(
    "get_guide",
    "Returns the design methodology guide: design-system-first workflow, refs, promote discipline, review loop, handoff.",
    {},
    () => getGuide(),
    { requiresProject: false },
  ),
  tool(
    "get_mockup",
    "Reads a mockup's variants (raw HTML, outside the ref model). summary omits html, full includes it; variant reads a single one.",
    { mockup: z.string(), view: z.enum(["summary", "full"]).optional(), variant: z.string().optional() },
    (store, input) => getMockup(store, input as never),
  ),

  // Writes ----------------------------------------------------------------
  tool(
    "write_html",
    "Create or fully replace a screen from augmented HTML (html_aug; grammar in the server instructions) with one root element. kind:\"component\"|\"pattern\" writes a design-system definition instead, named by screen: a default-variant root plus optional sibling <template data-variant=\"x\"> blocks, each the complete variant. In a definition, never style the data-slot element itself — an instance discards that style; style a wrapper.",
    {
      screen: z.string(),
      mode: z.enum(["create", "replace"]),
      title: z.string().optional(),
      html_aug: z.string(),
      kind: z.enum(["screen", "component", "pattern"]).optional(),
      response_mode: responseModeSchema.optional(),
    },
    (store, input) => writeHtml(store, input as never),
  ),
  tool(
    "patch_html",
    "Surgical patch by node ref or CSS selector (selector: screens only): replace, insert_before, insert_after, delete, set_attr. html_aug for replace/insert_* is a fragment in the write_html grammar — in a definition, never style the slot element itself. Example: { target: { kind: \"node\", node: \"home.btn1\" }, operation: \"set_attr\", attr: { name: \"data-variant\", value: \"hover\" } }.",
    {
      target: z.union([
        z.object({ kind: z.literal("node"), node: z.string() }),
        z.object({ kind: z.literal("selector"), screen: z.string(), css_selector: z.string() }),
      ]),
      operation: z.enum(["replace", "insert_before", "insert_after", "delete", "set_attr"]),
      html_aug: z.string().optional(),
      attr: z.object({ name: z.string(), value: z.string().nullable() }).optional(),
      response_mode: responseModeSchema.optional(),
    },
    (store, input) => patchHtml(store, input as never),
  ),
  tool(
    "update_refs",
    "Change a node's $token/$component/variant bindings without an HTML parse — the cheapest write. token_refs maps a CSS property to a token path (\"color.primary\"; null clears). Setting a property replaces its whole value with one plain ref; author mixed values with write_html/patch_html.",
    {
      node: z.string(),
      refs: z.object({
        component_ref: z.string().nullable().optional(),
        variant: z.string().nullable().optional(),
        token_refs: z.record(z.string(), z.string().nullable()).optional(),
      }),
    },
    (store, input) => updateRefs(store, input as never),
  ),
  tool(
    "set_tokens",
    "Design-system token mutation. One call rewrites tokens.json; every bound screen, component, and pattern re-resolves. The propagation lever.",
    {
      tokens: z.record(z.string(), tokenValueSchema.nullable()),
      mode: z.enum(["replace", "patch"]),
      response_mode: responseModeSchema.optional(),
    },
    (store, input) => setTokens(store, input as never),
  ),
  tool(
    "set_flow",
    "Mutate a flow edge in flows.json without touching any screen file.",
    { node: z.string(), flow: publicFlowSchema.nullable() },
    (store, input) => setFlow(store, input as never),
  ),
  tool(
    "set_meta",
    "Set handoff metadata, one field group per call, by target: screen → notes, tags, variant_of + variant_kind (state|overlay|step; variant_of null clears); mockup → tags, title, description; design_system → idea, decisions; component/pattern {name} → usage; tag {tag} → notes, a spec spanning several screens. tags and decisions replace the whole list — read first to append.",
    {
      target: metaTargetSchema,
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      idea: z.string().optional(),
      decisions: z.array(setMetaDecisionSchema).optional(),
      usage: z.string().optional(),
      variant_of: z.string().nullable().optional(),
      variant_kind: z.enum(["state", "overlay", "step"]).optional(),
    },
    (store, input) => setMeta(store, input as never),
  ),
  tool(
    "write_mockup",
    "Create or revise one variant of a mockup: raw HTML written verbatim (fragment or full document, inline <style> allowed), no refs, no drift warnings. create requires html; replace needs an existing variant and may omit html to retitle/redescribe only. title defaults to the variant id.",
    {
      mockup: z.string(),
      variant: z.string(),
      mode: z.enum(["create", "replace"]),
      title: z.string().optional(),
      description: z.string().optional(),
      html: z.string().optional(),
    },
    (store, input) => writeMockup(store, input as never),
  ),
  tool(
    "set_board_state",
    "Reads or sets the Board's shared view state — filter, pinned screens, expanded variant clusters — in daemon memory only, shared with every viewer. filter: case-insensitive substring of a screen's name or tag; null or blank clears. pins/expanded: {op: add|remove|set, screens} or {op: clear}; expanded names a main screen or any of its variants. Omitted fields stay unchanged; none = pure read. Returns the state plus shown_screens (filter matches + pins).",
    {
      filter: z.string().nullable().optional(),
      pins: pinsPatchSchema.optional(),
      expanded: pinsPatchSchema.optional(),
    },
    (store, input, ctx) => setBoardState(store, input as never, ctx),
  ),

  // Visual review -----------------------------------------------------------
  tool(
    "get_screenshot",
    "PNG of a screen, one mockup variant (mockup + variant) or, on its own, a definition node ref — exactly one target. node clips a screen to one element (+8px): far fewer vision tokens. For a mockup, width sets the viewport (default 390) and the capture is full-page; a screen renders at its root's declared size. scale 1-3 (default 1) multiplies vision cost. browser re-renders in another installed engine; the result names the one used.",
    {
      screen: z.string().optional(),
      node: z.string().optional(),
      scale: z.number().optional(),
      mockup: z.string().optional(),
      variant: z.string().optional(),
      width: z.number().optional(),
      browser: z.enum(BROWSER_KINDS).optional(),
    },
    (store, input) => getScreenshot(store, input as never),
  ),
  tool(
    "inspect_node",
    "Computed bounding box (x/y/width/height) and a fixed set of 12 styles (display, position, spacing, border, font, color, background, overflow) of one node, rendered headlessly. Prefer it to get_screenshot for geometry, alignment and color questions — text is far cheaper than vision; use get_screenshot for visual judgment. Same browser input.",
    { node: z.string(), browser: z.enum(BROWSER_KINDS).optional() },
    (store, input) => inspectNode(store, input as never),
  ),

  // Lifecycle ---------------------------------------------------------------
  tool(
    "init_project",
    "Scaffold a project directory: empty, from HTML, or from a Stitch export URL. Returns project, the value for the project input of later calls. Ask the user for dir; never pick one yourself.",
    {
      dir: z.string(),
      name: z.string().optional(),
      seed: z.union([
        z.object({ kind: z.literal("empty") }),
        z.object({ kind: z.literal("html"), html_aug: z.string(), screen: z.string() }),
        z.object({ kind: z.literal("stitch_export"), url: z.string() }),
      ]),
      git: z.boolean().optional(),
    },
    (_store, input, ctx) => initProjectTool(input as never, ctx),
    { requiresProject: false },
  ),
  tool(
    "import_html",
    "Incremental HTML ingest into an existing project, with content-hash dedup.",
    {
      source: z.union([
        z.object({ kind: z.literal("html"), html_aug: z.string(), screen: z.string().optional() }),
        z.object({ kind: z.literal("stitch_export"), url: z.string() }),
      ]),
      dedupe: z.boolean().optional(),
    },
    (store, input) => importHtml(store, input as never),
  ),
  tool(
    "promote_to_system",
    "Lift a node's inline value or a repeated element into a design-system token, component or pattern. token rewrites every matching inline value project-wide, definitions included; component rewrites identical occurrences across screens only, never inside definitions; pattern only creates the file and leaves the source markup.",
    {
      node: z.string(),
      kind: z.enum(["token", "component", "pattern"]),
      name: z.string(),
      variants: z.array(z.string()).optional(),
    },
    (store, input) => promoteToSystem(store, input as never),
  ),
  tool(
    "promote_mockup",
    "Copy a mockup variant into a new design-system-bound screen (write_html create); returns that response plus mockup and variant. The variant is normalized to one root (styles moved in, extra top-level nodes wrapped in a div, script/meta/title/link/base dropped); changes are reported as a mockup_normalized warning.",
    { mockup: z.string(), variant: z.string(), screen: z.string(), title: z.string().optional() },
    (store, input) => promoteMockup(store, input as never),
  ),
  tool(
    "delete_entity",
    "Delete a screen, component, pattern or mockup (or one mockup variant via variant). A screen takes its flow edges and meta with it; comments stay. Referenced components are refused (references listed), as are screens with variant screens unless cascade: true (screen only) deletes the subtree.",
    { kind: z.enum(["screen", "component", "pattern", "mockup"]), name: z.string(), variant: z.string().optional(), cascade: z.boolean().optional() },
    // ctx threaded through the way init_project's is — deleteEntity uses
    // ctx.viewState.pruneScreen(name) to drop a deleted screen from the
    // Board's pinned set (CHR-624), a no-op when ctx/viewState is absent.
    (store, input, ctx) => deleteEntity(store, input as never, ctx),
  ),

  // Comments ---------------------------------------------------------------
  tool(
    "reply_comment",
    "Answer a comment, optionally resolving it. Accepts any id from list_comments (root or reply); the answer lands on the thread root.",
    { comment_id: z.string(), body: z.string(), resolve: z.boolean().optional() },
    (store, input) => replyComment(store, input as never),
  ),
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
