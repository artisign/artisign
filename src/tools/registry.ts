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
import { initProjectTool, importHtml, promoteToSystem, deleteEntity } from "./lifecycle.js";
import { replyComment } from "./comments.js";
import { getScreenshot } from "./screenshot.js";
import { inspectNode } from "./inspect-node.js";
import { setMeta } from "./meta.js";
import { getGuide } from "./guide.js";
import { writeMockup, getMockup, promoteMockup } from "./mockups.js";

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
]);
const setMetaDecisionSchema = z.object({
  id: z.string(),
  date: z.string().optional(),
  title: z.string(),
  body: z.string(),
  status: z.enum(["active", "superseded"]).optional(),
});

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
    "Project root: screen list, design-system pointer, counts. Tiered, cold-start read.",
    { view: viewSchema.optional(), fields: z.array(z.string()).optional(), tags: z.array(z.string()).optional() },
    (store, input) => getProject(store, input),
  ),
  tool(
    "get_screen",
    "One screen with comment/flow indicators. Tiered + field selection. fields: [\"rendered_html\"] at view \"full\" returns the resolved (component/token) render as a standalone HTML document — an MCP-only fallback for reading resolved output without Playwright; never included by default.",
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
    "Subtree of one node, addressed as \"<screen>.<node-id>\", or " +
      "\"component:<name>#<variant>.<node-id>\" / \"pattern:<name>.<node-id>\" for a design-system " +
      "definition node. Tiered + field selection.",
    { node: z.string(), view: viewSchema.optional(), fields: z.array(z.string()).optional() },
    (store, input) => getNode(store, input as never),
  ),
  tool(
    "get_design_system",
    "Tokens, components (with variants), and patterns.",
    { view: viewSchema.optional(), fields: z.array(z.string()).optional() },
    (store, input) => getDesignSystem(store, input),
  ),
  tool(
    "find_nodes",
    "Where-query across screens and design-system definitions — components and patterns are searched too, " +
      "always, since refs concentrated there are just as findable as inline ones on a screen " +
      "(style_ref, component_ref, variant, has_comments, text_match, has_flow; screens filters which screens, " +
      "never excludes components/patterns). A match with source:\"component\"|\"pattern\" carries " +
      "id_stability:\"explicit\"|\"derived\" instead of a screen match's implicit stability: its node ref IS " +
      "addressable by get_node/update_refs/patch_html, but only reliably resolves to the same element across " +
      "a later write when id_stability is \"explicit\" — a \"derived\" id is only guaranteed for this one call. " +
      "reply_comment stays screen-only. The headline token-saver.",
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
    "get_guide",
    "Returns the agent-facing design methodology guide (design-system-first workflow, refs, promote " +
      "discipline, review loop, handoff).",
    {},
    () => getGuide(),
    { requiresProject: false },
  ),
  tool(
    "get_mockup",
    "Reads a mockup's variants — raw HTML, outside the ref model. summary omits html per variant; full " +
      "includes it. Pass variant to read a single one.",
    { mockup: z.string(), view: z.enum(["summary", "full"]).optional(), variant: z.string().optional() },
    (store, input) => getMockup(store, input as never),
  ),

  // Writes ----------------------------------------------------------------
  tool(
    "write_html",
    "Create or fully replace a screen from augmented HTML (html_aug): one root element, " +
      "class=\"$name\" or data-component=\"name\" for component instances, $ref in style values " +
      "for tokens, data-variant/data-flow-target for state/flows. See server instructions for the " +
      "full grammar. Example: html_aug: '<section id=\"s1\" style=\"padding: $spacing.md\">...</section>'. " +
      "kind:\"component\"|\"pattern\" writes a design-system definition file instead of a screen: " +
      "a default-variant root element plus optional sibling <template data-variant=\"x\"> blocks; " +
      "screen names the definition.",
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
    "Surgical patch by node ref or CSS selector: replace, insert_before, insert_after, delete, set_attr. " +
      "html_aug for replace/insert_* is a fragment in the same augmented-HTML grammar as write_html " +
      "(see server instructions). node also accepts a component:<name>#<variant>.<node-id> / " +
      "pattern:<name>.<node-id> ref (css_selector targeting stays screen-only); touching a node with no " +
      "explicit id in source returns a missing_id warning, not blocking. response_mode \"diff\"/\"full\" " +
      "are rejected against a definition ref — only \"summary\" is supported there. " +
      "Example: { target: { kind: \"node\", node: \"home.btn1\" }, " +
      "operation: \"set_attr\", attr: { name: \"data-variant\", value: \"hover\" } }.",
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
    "Change a node's $token/$component/variant bindings without an HTML parse — the cheapest write. " +
      "token_refs is keyed by CSS property, value is a dot-path like \"color.primary\" (null clears it). " +
      "Setting a property always replaces its whole value with a single plain ref, even if that property " +
      "currently holds a ref mixed with literal text or more than one ref — to author a mixed value, use " +
      "write_html/patch_html instead. node also accepts a component:<name>#<variant>.<node-id> / " +
      "pattern:<name>.<node-id> ref; touching a node with no explicit id in source returns a missing_id " +
      "warning, not blocking. " +
      "Example: { node: \"home.btn1\", refs: { token_refs: { color: \"color.primary\" }, variant: \"hover\" } }.",
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
    "Design-system token mutation. One call rewrites tokens.json; every bound screen, component, and pattern " +
      "re-resolves. The propagation lever.",
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
    "Set screen notes/tags, mockup tags/title/description, design-system idea/decisions, or component/pattern " +
      "usage guidance — the handoff contract coding agents rely on. One field group per call: notes/tags for a " +
      "screen target, tags/title/description for a mockup target, idea/decisions for design_system, usage for a " +
      "component/pattern target. tags and decisions replace the full list, not just add to it — read the current " +
      "value first if you need to append.",
    {
      target: metaTargetSchema,
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      idea: z.string().optional(),
      decisions: z.array(setMetaDecisionSchema).optional(),
      usage: z.string().optional(),
    },
    (store, input) => setMeta(store, input as never),
  ),
  tool(
    "write_mockup",
    "Create or revise one variant of a mockup — a design exploration outside the design system: raw HTML " +
      "written verbatim (fragment or full document), no refs resolved, no drift warnings, inline <style> " +
      "allowed. Use for side-by-side option exploration before committing to a direction; promote_mockup " +
      "copies a chosen variant into a real screen — the mockup stays as exploration history. create requires " +
      "html and fails on an existing variant (conflict); replace fails if the variant doesn't exist " +
      "(not_found) and can be meta-only (omit html to retitle/redescribe without touching the markup). " +
      "title defaults to the variant id.",
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

  // Visual review -----------------------------------------------------------
  tool(
    "get_screenshot",
    "Screenshots a rendered screen, or one mockup variant, as a PNG — exactly one of screen or mockup+variant " +
      "is required. Call this after every write_html/patch_html (or write_mockup) to visually review what " +
      "actually changed before making the next edit — the write -> screenshot -> adjust loop. Pass node " +
      "(\"<screen>.<node-id>\", must belong to screen and not valid with mockup) to clip to just that element " +
      "plus 8px padding — far fewer vision tokens than a full screen when iterating on one component. A " +
      "component:<name>#<variant>.<node-id> / pattern:<name>.<node-id> ref renders that definition standalone " +
      "and stands alone — it takes neither screen nor mockup. For a mockup, " +
      "width sets the viewport (default 390, height fixed 844) and the capture is always full-page, uncropped, " +
      "since a variant can run taller than the fold. Requires Playwright " +
      "(npm install playwright && npx playwright install chromium); scale defaults to 1x, higher scales cost more " +
      "tokens once the image reaches a model.",
    {
      screen: z.string().optional(),
      node: z.string().optional(),
      scale: z.number().optional(),
      mockup: z.string().optional(),
      variant: z.string().optional(),
      width: z.number().optional(),
    },
    (store, input) => getScreenshot(store, input as never),
  ),
  tool(
    "inspect_node",
    "Reads a node's computed bounding box (x/y/width/height) and a curated set of computed styles (display, " +
      "position, margin, padding, border, border_radius, font_size, line_height, font_weight, color, " +
      "background_color, overflow) by rendering the screen headlessly. Prefer this over get_screenshot for " +
      "geometry/alignment/color questions (\"is this button 44px tall?\", \"do these two elements align?\") — " +
      "text is far cheaper than vision tokens. Use get_screenshot instead when the question is visual (layout " +
      "looks right, imagery, overall composition). Requires Playwright, same as get_screenshot.",
    { node: z.string() },
    (store, input) => inspectNode(store, input as never),
  ),

  // Lifecycle ---------------------------------------------------------------
  tool(
    "init_project",
    "Scaffold a project directory: empty, from HTML, or from a Stitch export URL.",
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
    "Lift a node's inline value or a repeated element into a design-system token, component, or pattern. " +
      "kind:token rewrites project-wide — every screen, component, and pattern definition that carried the " +
      "matching inline value, not just the promoted node. kind:component rewrites every structurally identical " +
      "occurrence across screens only, not inside other component/pattern definitions — a call targeting one " +
      "screen node must not have the side effect of rewriting curated design-system source files. Pattern " +
      "promotion only creates the pattern file and leaves the source node's markup untouched — patterns have no " +
      "ref/instance mechanism in the canonical model, so there is nothing to rewrite elsewhere. Example: " +
      "{ node: \"home.btn1\", kind: \"component\", name: \"btn-primary\" }.",
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
    "Copies a chosen mockup variant into a new design-system-bound screen: writeHtml(mode:\"create\") on " +
      "the variant's raw HTML, returned unmodified (including any errors/warnings/root_node_id) plus the " +
      "source mockup/variant. The mockup stays on disk as exploration history — delete it with delete_entity " +
      "when done. Single-root variants only — prefer inline styles over a top-level <style> block, which the " +
      "serializer entity-escapes rather than parses. Refs/drift discipline applies to the resulting screen " +
      "from this point on, same as any other screen.",
    { mockup: z.string(), variant: z.string(), screen: z.string(), title: z.string().optional() },
    (store, input) => promoteMockup(store, input as never),
  ),
  tool(
    "delete_entity",
    "Delete a screen, component, pattern, or mockup (whole mockup, or one variant via variant). Screens also " +
      "drop their outgoing flow edges and meta sidecar (comments are kept as history). A component still " +
      "referenced by any screen, component, or pattern is refused with the referencing nodes listed.",
    { kind: z.enum(["screen", "component", "pattern", "mockup"]), name: z.string(), variant: z.string().optional() },
    (store, input) => deleteEntity(store, input as never),
  ),

  // Comments ---------------------------------------------------------------
  tool(
    "reply_comment",
    "Answer a comment and optionally resolve it. Takes any id list_comments returned — a thread root or one of its replies; the answer lands on the thread root either way.",
    { comment_id: z.string(), body: z.string(), resolve: z.boolean().optional() },
    (store, input) => replyComment(store, input as never),
  ),
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
