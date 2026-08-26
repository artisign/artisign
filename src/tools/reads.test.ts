import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupProject, estimateTokens, type ProjectFixture } from "./test-fixtures.js";
import { getProject, getScreen, getNode, getDesignSystem, findNodes, listComments } from "./reads.js";
import { renderScreenDocument } from "./render-context.js";
import { FsStore } from "../store/index.js";
import { ToolError } from "./types.js";

describe("get_project", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("summary reports flat counts without reading any screen content", async () => {
    for (let i = 0; i < 3; i++) {
      await fx.store.writeScreen(`s${i}`, `<div id="n1"></div>`);
    }
    const res = await getProject(fx.store, {});
    expect(res).toMatchObject({ screen_count: 3, token_count: 0, component_count: 0, flow_count: 0, open_comment_count: 0 });
    expect(res).not.toHaveProperty("screens");
  });

  it("tree includes a screen list with node counts and per-screen unresolved comment counts", async () => {
    await fx.store.writeScreen("home", `<div id="n1"><span id="n2"></span></div>`);
    const res = await getProject(fx.store, { view: "tree" });
    expect(res.screens).toEqual([{ screen: "home", path: "screens/home.html", node_count: 2, open_comment_count: 0, tags: [] }]);
  });

  it("tree includes a mockups list with variant counts", async () => {
    await fx.store.writeMockupMeta("hero-options", { variants: [{ id: "a", title: "A", description: "" }] });
    const res = await getProject(fx.store, { view: "tree" });
    expect(res.mockup_count).toBe(1);
    expect(res.mockups).toEqual([{ mockup: "hero-options", variant_count: 1, tags: [] }]);
  });

  it("tree tolerates a mockup dir without mockup.json (variant_count: 0) instead of throwing", async () => {
    await fx.store.writeMockupVariant("no-meta-yet", "a", "<div></div>");
    const res = await getProject(fx.store, { view: "tree" });
    expect(res.mockups).toEqual([{ mockup: "no-meta-yet", variant_count: 0, tags: [] }]);
  });

  it("full includes design_system and flows", async () => {
    const tokens = await fx.store.readTokens();
    tokens.color = { primary: "#000" };
    await fx.store.writeTokens(tokens);
    await fx.store.writeComponent("btn-primary", `<button id="n1">Go</button>`);

    const res = await getProject(fx.store, { view: "full" });
    expect(res.design_system).toEqual({
      tokens: ["color.primary"],
      components: [{ name: "btn-primary", variants: ["default"] }],
      patterns: [],
    });
    expect(res.flows).toEqual([]);
  });

  it("fields trims the response to the requested keys plus the base summary", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    const res = await getProject(fx.store, { view: "tree", fields: ["screens"] });
    expect(res).toHaveProperty("screens");
    expect(res).toHaveProperty("screen_count"); // always-kept base field
  });

  it("rejects an unknown field name", async () => {
    await expect(getProject(fx.store, { fields: ["nonsense"] })).rejects.toThrow(ToolError);
  });

  it("costs <= 500 tokens at summary on a 10-screen project", async () => {
    for (let i = 0; i < 10; i++) {
      await fx.store.writeScreen(`screen-${i}`, `<section id="n1"><h1 id="n2">Title ${i}</h1></section>`);
    }
    const res = await getProject(fx.store, {});
    expect(estimateTokens(res)).toBeLessThanOrEqual(500);
  });

  it("default summary (no tags param) is byte-identical to the pre-metadata shape (token budget)", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    const res = await getProject(fx.store, {});
    expect(res).not.toHaveProperty("screens");
    // "head_reason" only appears because the fixture project has no git repo
    // yet ("no_repo") — it's dropped whenever head resolves to a real sha.
    expect(Object.keys(res).sort()).toEqual(
      ["name", "root", "screen_count", "token_count", "component_count", "mockup_count", "flow_count", "open_comment_count", "head", "head_reason", "last_write_at"].sort(),
    );
  });

  it("tags filter (summary tier) returns only matching screens, minimal shape", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    await fx.store.writeScreen("about", `<div id="n1"></div>`);
    await fx.store.writeScreenMeta("home", { notes: "", tags: ["checkout"] });

    const res = await getProject(fx.store, { tags: ["checkout"] });
    expect(res.screen_count).toBe(1);
    expect(res.screens).toEqual([{ screen: "home", tags: ["checkout"] }]);
  });

  it("tags filter is case-insensitive (matches the preview frontend's tag filter)", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    await fx.store.writeScreenMeta("home", { notes: "", tags: ["Release-1"] });

    const res = await getProject(fx.store, { tags: ["release-1"] });
    expect(res.screen_count).toBe(1);
    expect(res.screens).toEqual([{ screen: "home", tags: ["Release-1"] }]);
  });

  it("tags filter with no match returns an empty screens list", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    const res = await getProject(fx.store, { tags: ["nope"] });
    expect(res.screen_count).toBe(0);
    expect(res.screens).toEqual([]);
  });

  it("tree view includes tags on every screen entry, and filters when tags is given", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    await fx.store.writeScreen("about", `<div id="n1"></div>`);
    await fx.store.writeScreenMeta("home", { notes: "", tags: ["checkout"] });

    const unfiltered = await getProject(fx.store, { view: "tree" });
    expect((unfiltered.screens as Array<{ screen: string; tags: string[] }>).map((s) => s.screen).sort()).toEqual(["about", "home"]);

    const filtered = await getProject(fx.store, { view: "tree", tags: ["checkout"] });
    expect(filtered.screens).toEqual([
      { screen: "home", path: "screens/home.html", node_count: 1, open_comment_count: 0, tags: ["checkout"] },
    ]);
    expect(filtered.screen_count).toBe(1);
  });

  it("tags filter (summary tier) also matches mockups, minimal shape", async () => {
    await fx.store.writeMockupMeta("hero-options", { variants: [], tags: ["checkout"] });
    await fx.store.writeMockupMeta("nav-options", { variants: [] });

    const res = await getProject(fx.store, { tags: ["checkout"] });
    expect(res.mockup_count).toBe(1);
    expect(res.mockups).toEqual([{ mockup: "hero-options", tags: ["checkout"] }]);
  });

  it("mockup tags filter is case-insensitive", async () => {
    await fx.store.writeMockupMeta("hero-options", { variants: [], tags: ["Release-1"] });

    const res = await getProject(fx.store, { tags: ["release-1"] });
    expect(res.mockup_count).toBe(1);
    expect(res.mockups).toEqual([{ mockup: "hero-options", tags: ["Release-1"] }]);
  });

  it("tree view includes tags on every mockup entry, and filters mockups when tags is given", async () => {
    await fx.store.writeMockupMeta("hero-options", { variants: [], tags: ["checkout"] });
    await fx.store.writeMockupMeta("nav-options", { variants: [] });

    const unfiltered = await getProject(fx.store, { view: "tree" });
    expect((unfiltered.mockups as Array<{ mockup: string; tags: string[] }>).map((m) => m.mockup).sort()).toEqual([
      "hero-options",
      "nav-options",
    ]);

    const filtered = await getProject(fx.store, { view: "tree", tags: ["checkout"] });
    expect(filtered.mockups).toEqual([{ mockup: "hero-options", variant_count: 0, tags: ["checkout"] }]);
    expect(filtered.mockup_count).toBe(1);
  });
});

describe("get_screen", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<section id="n1" style="color: $color.primary"><h1 id="n2">Hi</h1></section>`);
  });
  afterEach(() => fx.cleanup());

  it("summary reports counts, not content", async () => {
    const res = await getScreen(fx.store, { screen: "home" });
    expect(res).toMatchObject({ screen: "home", path: "screens/home.html", node_count: 3, ref_count: 1, flow_count: 0 });
    expect(res).not.toHaveProperty("html_aug");
  });

  it("tree includes a node skeleton", async () => {
    const res = await getScreen(fx.store, { screen: "home", view: "tree" });
    expect(res.nodes).toEqual([
      { id: "n1", tag: "section", parent_id: null, ref_count: 1 },
      { id: "n2", tag: "h1", parent_id: "n1", ref_count: 0 },
      { id: "n2t", tag: undefined, parent_id: "n2", ref_count: 0 },
    ]);
  });

  it("full includes html_aug and flows", async () => {
    const res = await getScreen(fx.store, { screen: "home", view: "full" });
    expect(typeof res.html_aug).toBe("string");
    expect(res.html_aug).toContain("$color.primary");
    expect(res.flows).toEqual([]);
  });

  it("summary carries tags but not notes; full carries both", async () => {
    await fx.store.writeScreenMeta("home", { notes: "check contrast", tags: ["checkout"] });

    const summary = await getScreen(fx.store, { screen: "home" });
    expect(summary.tags).toEqual(["checkout"]);
    expect(summary).not.toHaveProperty("notes");

    const full = await getScreen(fx.store, { screen: "home", view: "full" });
    expect(full.tags).toEqual(["checkout"]);
    expect(full.notes).toBe("check contrast");
  });

  it("throws not_found for a missing screen", async () => {
    await expect(getScreen(fx.store, { screen: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects output_format jsx as unimplemented", async () => {
    await expect(getScreen(fx.store, { screen: "home", output_format: "jsx" })).rejects.toThrow(ToolError);
  });

  it("omits rendered_html unless explicitly requested, even at view full", async () => {
    const full = await getScreen(fx.store, { screen: "home", view: "full" });
    expect(full).not.toHaveProperty("rendered_html");

    const summary = await getScreen(fx.store, { screen: "home", fields: ["rendered_html"] });
    expect(summary).not.toHaveProperty("rendered_html");
  });

  it("returns the resolved render as a standalone HTML document when requested at view full", async () => {
    const tokens = await fx.store.readTokens();
    tokens.color = { primary: "#123456" };
    await fx.store.writeTokens(tokens);

    const res = await getScreen(fx.store, { screen: "home", view: "full", fields: ["rendered_html"] });

    expect(typeof res.rendered_html).toBe("string");
    const html = res.rendered_html as string;
    expect(html).toContain("<h1");
    expect(html).toContain("Hi");
    // Resolved, not the $-ref source: the token ref is replaced by its
    // value in the rendered markup even though it's still `$color.primary`
    // in html_aug.
    expect(html).toContain("#123456");
    expect(html).not.toContain("$color.primary");
  });

  it("rendered_html matches what /api/render/<screen> serves", async () => {
    const res = await getScreen(fx.store, { screen: "home", view: "full", fields: ["rendered_html"] });
    const { documentHtml } = await renderScreenDocument(fx.store, "home", { fontMode: "url" });

    expect(res.rendered_html).toBe(documentHtml);
  });

  it("summary/tree views carry no per-node refs field (token budget)", async () => {
    const summary = await getScreen(fx.store, { screen: "home" });
    expect(summary).not.toHaveProperty("nodes");

    const tree = await getScreen(fx.store, { screen: "home", view: "tree" });
    const treeNodes = tree.nodes as Array<Record<string, unknown>>;
    expect(treeNodes.length).toBeGreaterThan(0);
    for (const n of treeNodes) expect(n).not.toHaveProperty("refs");
  });

  it("full view's per-node refs are identical to get_node's refs for the same node (component ref, variant, mixed value, modifier fn)", async () => {
    const tokens = await fx.store.readTokens();
    tokens.color = { border: "#eee", primary: "#000" };
    await fx.store.writeTokens(tokens);
    await fx.store.writeComponent(
      "btn-primary",
      `<button id="n1">Default</button>\n<template data-variant="hover"><button id="n1">Hover</button></template>`,
    );
    await fx.store.writeScreen(
      "refs-screen",
      `<section id="root">
        <button id="btn1" class="$btn-primary" data-variant="hover">Go</button>
        <div id="mix1" style="border: 1px solid $color.border">Box</div>
        <div id="mod1" style="color: alpha($color.primary, 0.1)">Text</div>
      </section>`,
    );

    const full = await getScreen(fx.store, { screen: "refs-screen", view: "full" });
    const nodes = full.nodes as Array<{ id: string; refs?: unknown }>;

    for (const nodeId of ["btn1", "mix1", "mod1"]) {
      const screenNode = nodes.find((n) => n.id === nodeId);
      const viaGetNode = await getNode(fx.store, { node: `refs-screen.${nodeId}` });
      expect(screenNode?.refs).toEqual(viaGetNode.refs);
    }
  });

  it("full view omits refs entirely for a node without any", async () => {
    const full = await getScreen(fx.store, { screen: "home", view: "full" });
    const nodes = full.nodes as Array<{ id: string; refs?: unknown }>;
    const h1 = nodes.find((n) => n.id === "n2");
    expect(h1).not.toHaveProperty("refs");
  });

  it("nodes are in document order, not object-key enumeration order (integer-like ids sort first in JS)", async () => {
    await fx.store.writeScreen(
      "order-screen",
      `<section id="zz"><div id="2"></div><div id="1"></div></section>`,
    );
    const tree = await getScreen(fx.store, { screen: "order-screen", view: "tree" });
    const ids = (tree.nodes as Array<{ id: string }>).map((n) => n.id);
    expect(ids).toEqual(["zz", "2", "1"]);

    const full = await getScreen(fx.store, { screen: "order-screen", view: "full" });
    const fullIds = (full.nodes as Array<{ id: string }>).map((n) => n.id);
    expect(fullIds).toEqual(["zz", "2", "1"]);
  });
});

describe("get_node", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen(
      "home",
      `<section id="n1"><button id="n2" style="color: $color.primary" data-flow-target="next">Go</button></section>`,
    );
    // flows.json is populated by the write tools (write_html/patch_html/set_flow),
    // not inferred from a raw store.writeScreen — seed it directly here.
    await fx.store.writeFlows([{ from: "home.n2", event: "tap", to: "next", to_kind: "screen" }]);
  });
  afterEach(() => fx.cleanup());

  it("summary reports refs and parent", async () => {
    const res = await getNode(fx.store, { node: "home.n2" });
    expect(res).toEqual({
      node: "home.n2",
      screen: "home",
      tag: "button",
      parent: "home.n1",
      refs: { token_refs: { color: "color.primary" } },
    });
  });

  it("tree includes children", async () => {
    const res = await getNode(fx.store, { node: "home.n2", view: "tree" });
    expect(res.children).toEqual(["home.n2t"]);
  });

  it("full includes html_aug and flow", async () => {
    const res = await getNode(fx.store, { node: "home.n2", view: "full" });
    expect(res.html_aug).toContain("Go");
    expect(res.flow).toMatchObject({ from: "home.n2", to: "next" });
  });

  it("throws not_found for a missing node", async () => {
    await expect(getNode(fx.store, { node: "home.n999" })).rejects.toMatchObject({ code: "not_found" });
  });
});

// ADR-004 §1 — get_node dispatches a component:/pattern: node ref to a
// definition-loading path instead of loadScreen -> screens/<name>.html.
describe("get_node — component/pattern refs", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeComponent(
      "btn-primary",
      `<button id="n1" style="color: $color.primary"><span id="n2" data-slot="label">Go</span></button>\n` +
        `<template data-variant="hover"><button id="n1" style="color: $color.primary"><span id="n2" data-slot="label">Go</span></button></template>`,
    );
    await fx.store.writePattern("card-grid", `<div id="n1"><section id="n2"></section></div>`);
  });
  afterEach(() => fx.cleanup());

  it("summary reports the same shape as a screen node, addressed by the definition's own address", async () => {
    const res = await getNode(fx.store, { node: "component:btn-primary#hover.n1" });
    expect(res).toEqual({
      node: "component:btn-primary#hover.n1",
      screen: "component:btn-primary#hover",
      tag: "button",
      parent: null,
      refs: { token_refs: { color: "color.primary" } },
    });
  });

  it("tree includes children addressed at the same definition", async () => {
    const res = await getNode(fx.store, { node: "component:btn-primary#hover.n1", view: "tree" });
    expect(res.children).toEqual(["component:btn-primary#hover.n2"]);
  });

  it("full includes html_aug, without a flow (flows only ever anchor to a screen node)", async () => {
    const res = await getNode(fx.store, { node: "component:btn-primary#hover.n1", view: "full" });
    expect(res.html_aug).toContain("Go");
    expect(res).not.toHaveProperty("flow");
  });

  it("resolves a pattern ref the same way", async () => {
    const res = await getNode(fx.store, { node: "pattern:card-grid.n2" });
    expect(res).toMatchObject({ node: "pattern:card-grid.n2", screen: "pattern:card-grid", tag: "section", parent: "pattern:card-grid.n1" });
  });

  it("fails with not_found for an unknown component name, not a generic parse failure", async () => {
    await expect(getNode(fx.store, { node: "component:does-not-exist#default.n1" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("fails with not_found for an unknown variant of an existing component", async () => {
    await expect(getNode(fx.store, { node: "component:btn-primary#does-not-exist.n1" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("fails with not_found for an unknown pattern name", async () => {
    await expect(getNode(fx.store, { node: "pattern:does-not-exist.n1" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("fails with not_found for an unknown node id inside a real definition", async () => {
    await expect(getNode(fx.store, { node: "component:btn-primary#hover.n999" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("get_design_system", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    const tokens = await fx.store.readTokens();
    tokens.color = { primary: "#000", secondary: "#111" };
    await fx.store.writeTokens(tokens);
    await fx.store.writeComponent(
      "btn-primary",
      `<button id="n1">Default</button>\n<template data-variant="hover"><button id="n1">Hover</button></template>`,
    );
  });
  afterEach(() => fx.cleanup());

  it("summary reports counts and paths", async () => {
    const res = await getDesignSystem(fx.store, {});
    expect(res).toMatchObject({ token_count: 2, component_count: 1, pattern_count: 0 });
  });

  it("tree lists tokens/components/patterns", async () => {
    const res = await getDesignSystem(fx.store, { view: "tree" });
    expect(res.tokens).toEqual([
      { path: "color.primary", kind: "color" },
      { path: "color.secondary", kind: "color" },
    ]);
    expect(res.components).toEqual([{ name: "btn-primary", file: "design-system/components/btn-primary.html", variants: ["default", "hover"] }]);
  });

  it("full includes token values and component definitions", async () => {
    const res = await getDesignSystem(fx.store, { view: "full" });
    expect(res.token_values).toContainEqual({ path: "color.primary", value: "#000" });
    const defs = res.component_definitions as Array<{ name: string; variants: unknown[] }>;
    expect(defs[0]!.name).toBe("btn-primary");
    expect(defs[0]!.variants).toHaveLength(2);
  });

  it("summary carries decision_count only", async () => {
    await fx.store.writeDesignSystemMeta({
      idea: "calm checkout",
      decisions: [{ id: "d1", date: "2026-01-01", title: "single page", body: "long rationale text", status: "active" }],
      component_usage: { "btn-primary": "primary CTAs only" },
      pattern_usage: {},
    });
    const res = await getDesignSystem(fx.store, {});
    expect(res.decision_count).toBe(1);
    expect(res).not.toHaveProperty("idea");
    expect(res).not.toHaveProperty("decisions");
  });

  it("tree carries idea, decisions without body, and usage on matching components/patterns", async () => {
    await fx.store.writePattern("card-grid", `<div id="n1"></div>`);
    await fx.store.writeDesignSystemMeta({
      idea: "calm checkout",
      decisions: [{ id: "d1", date: "2026-01-01", title: "single page", body: "long rationale text", status: "active" }],
      component_usage: { "btn-primary": "primary CTAs only" },
      pattern_usage: { "card-grid": "gallery layouts" },
    });
    const res = await getDesignSystem(fx.store, { view: "tree" });
    expect(res.idea).toBe("calm checkout");
    expect(res.decisions).toEqual([{ id: "d1", date: "2026-01-01", title: "single page", status: "active" }]);
    const components = res.components as Array<{ name: string; usage?: string }>;
    expect(components.find((c) => c.name === "btn-primary")?.usage).toBe("primary CTAs only");
    const patterns = res.patterns as Array<{ name: string; usage?: string }>;
    expect(patterns.find((p) => p.name === "card-grid")?.usage).toBe("gallery layouts");
  });

  it("full carries decisions with body, and usage on component/pattern definitions", async () => {
    await fx.store.writePattern("card-grid", `<div id="n1"></div>`);
    await fx.store.writeDesignSystemMeta({
      idea: "calm checkout",
      decisions: [{ id: "d1", date: "2026-01-01", title: "single page", body: "long rationale text", status: "active" }],
      component_usage: { "btn-primary": "primary CTAs only" },
      pattern_usage: { "card-grid": "gallery layouts" },
    });
    const res = await getDesignSystem(fx.store, { view: "full" });
    expect(res.decisions).toEqual([{ id: "d1", date: "2026-01-01", title: "single page", body: "long rationale text", status: "active" }]);
    const defs = res.component_definitions as Array<{ name: string; usage?: string }>;
    expect(defs.find((d) => d.name === "btn-primary")?.usage).toBe("primary CTAs only");
    const patternDefs = res.pattern_definitions as Array<{ name: string; usage?: string }>;
    expect(patternDefs.find((p) => p.name === "card-grid")?.usage).toBe("gallery layouts");
  });

  it("drops orphan usage entries whose component/pattern file no longer exists", async () => {
    await fx.store.writeDesignSystemMeta({
      idea: "",
      decisions: [],
      component_usage: { "btn-primary": "kept", "deleted-btn": "orphan" },
      pattern_usage: {},
    });
    const res = await getDesignSystem(fx.store, { view: "tree" });
    const components = res.components as Array<{ name: string }>;
    expect(components.map((c) => c.name)).toEqual(["btn-primary"]);
  });
});

describe("find_nodes", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    const tokens = await fx.store.readTokens();
    tokens.color = { primary: "#000" };
    await fx.store.writeTokens(tokens);
    await fx.store.writeScreen(
      "checkout",
      `<section id="n1"><button id="n2" style="color: $color.primary" data-variant="hover">Pay</button><p id="n3">Total</p></section>`,
    );
    await fx.store.writeScreen("about", `<div id="n1" style="color: $color.primary"></div>`);
  });
  afterEach(() => fx.cleanup());

  it("matches style_ref across screens", async () => {
    const res = await findNodes(fx.store, { where: [{ kind: "style_ref", ref_path: "$color.primary" }] });
    const nodes = res.nodes as Array<{ node: string; id_stability?: "explicit" | "derived" }>;
    expect(nodes.map((n) => n.node).sort()).toEqual(["about.n1", "checkout.n2"]);
    // A screen match's id is always durable (screens are re-serialized on
    // every write, unlike a definition) — no id_stability marker at all.
    expect(nodes.every((n) => n.id_stability === undefined)).toBe(true);
  });

  it("matches style_ref against a ref mixed with literal text", async () => {
    await fx.store.writeScreen("checkout", `<section id="n1"><div id="n2" style="border: 1px solid $color.primary"></div></section>`);
    const res = await findNodes(fx.store, { where: [{ kind: "style_ref", ref_path: "$color.primary" }] });
    const nodes = res.nodes as Array<{ node: string }>;
    expect(nodes.map((n) => n.node).sort()).toEqual(["about.n1", "checkout.n2"]);
  });

  it("scopes to given screens", async () => {
    const res = await findNodes(fx.store, {
      where: [{ kind: "style_ref", ref_path: "$color.primary" }],
      screens: ["checkout"],
    });
    expect((res.nodes as unknown[]).length).toBe(1);
  });

  it("throws for an unknown screen name instead of silently returning no matches", async () => {
    await expect(
      findNodes(fx.store, { where: [{ kind: "style_ref", ref_path: "$color.primary" }], screens: ["nonexistent"] }),
    ).rejects.toThrow();
  });

  it("only reads the requested screens, not every screen in the project", async () => {
    await fx.store.writeScreen("extra", `<div id="n1" style="color: $color.primary"></div>`);
    const spy = vi.spyOn(fx.store, "readScreen");
    await findNodes(fx.store, { where: [{ kind: "style_ref", ref_path: "$color.primary" }], screens: ["checkout"] });
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["checkout"]);
  });

  it("skips loading components/patterns for a has_comments-only query, which can never match one", async () => {
    await fx.store.writeComponent("btn-primary", `<button id="btn">Go</button>`);
    // listComponents() is still called once by loadRegistry (needed to
    // resolve $-refs in screens regardless of predicate) — the point is
    // that the component file itself is never read/parsed, and patterns
    // (which loadRegistry doesn't need at all) aren't touched either.
    const readComponentSpy = vi.spyOn(fx.store, "readComponent");
    const listPatternsSpy = vi.spyOn(fx.store, "listPatterns");
    await findNodes(fx.store, { where: [{ kind: "has_comments" }] });
    expect(readComponentSpy).not.toHaveBeenCalled();
    expect(listPatternsSpy).not.toHaveBeenCalled();
  });

  it("still loads components/patterns for a has_comments query AND'd with a predicate that can match one", async () => {
    await fx.store.writeComponent("btn-primary", `<button id="btn" style="color: $color.primary">Go</button>`);
    const readComponentSpy = vi.spyOn(fx.store, "readComponent");
    const res = await findNodes(fx.store, {
      where: [{ kind: "has_comments" }, { kind: "style_ref", ref_path: "$color.primary" }],
    });
    // Nothing has a comment, so no matches — but the component source was
    // still read (not skipped), which is what this test actually checks.
    expect(res.nodes).toEqual([]);
    expect(readComponentSpy).toHaveBeenCalledWith("btn-primary");
  });

  it("AND-combines multiple predicates", async () => {
    const res = await findNodes(fx.store, {
      where: [{ kind: "style_ref", ref_path: "$color.primary" }, { kind: "variant", variant: "hover" }],
    });
    const nodes = res.nodes as Array<{ node: string }>;
    expect(nodes.map((n) => n.node)).toEqual(["checkout.n2"]);
  });

  it("text_match matches the containing element (and its ancestors), not the text node itself", async () => {
    const res = await findNodes(fx.store, { where: [{ kind: "text_match", pattern: "Total" }] });
    const nodes = (res.nodes as Array<{ node: string }>).map((n) => n.node);
    // "Total" lives in a text node under <p id="n3">, itself under the
    // screen root <section id="n1"> — both are legitimate "elements
    // containing this text" and neither is the un-addressable text node.
    expect(nodes).toContain("checkout.n3");
    expect(nodes).not.toContain("checkout.n3t");
  });

  it("AND-combines text_match with another predicate (previously always empty, since it only matched un-addressable text nodes)", async () => {
    const res = await findNodes(fx.store, {
      where: [{ kind: "text_match", pattern: "Pay" }, { kind: "variant", variant: "hover" }],
    });
    expect((res.nodes as Array<{ node: string }>).map((n) => n.node)).toEqual(["checkout.n2"]);
  });

  it("paginates with cursor/limit", async () => {
    const first = await findNodes(fx.store, { where: [{ kind: "style_ref", ref_path: "$color.primary" }], limit: 1 });
    expect((first.nodes as unknown[]).length).toBe(1);
    expect(first.next_cursor).toBe("1");
  });

  it("costs <= 250 tokens for single-screen colour inspection", async () => {
    const res = await findNodes(fx.store, {
      where: [{ kind: "style_ref", ref_path: "$color.primary" }],
      screens: ["checkout"],
    });
    expect(estimateTokens(res)).toBeLessThanOrEqual(250);
  });
});

describe("find_nodes — design-system sources", () => {
  let dir: string;
  let store: FsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-find-nodes-ds-"));
    await cp(join(process.cwd(), "src", "tools", "__fixtures__", "notes-app"), dir, { recursive: true });
    store = new FsStore(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("finds a style_ref that lives only in a component definition, never in any screen", async () => {
    // src/tools/__fixtures__/notes-app: $color.primary is used exclusively in
    // design-system/components/btn-primary.html — a screens-only scan finds
    // nothing here even though every screen visibly styles buttons with it.
    const res = await findNodes(store, { where: [{ kind: "style_ref", ref_path: "$color.primary" }] });
    const nodes = res.nodes as Array<{
      node: string;
      source: string;
      component?: string;
      variant?: string;
      screen: string | null;
      id_stability?: "explicit" | "derived";
    }>;
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => n.source === "component" && n.component === "btn-primary" && n.screen === null)).toBe(true);
    // Component/pattern matches carry an id-stability marker instead of the
    // old read_only flag (ADR-004 §3) — btn-primary's markup has no explicit
    // ids at all, so every matched node's id is allocator-generated.
    expect(nodes.every((n) => n.id_stability === "derived")).toBe(true);
    // The "disabled" variant styles itself with $color.disabled/$color.surface,
    // not $color.primary — only "default" and "hover" reference it.
    expect(nodes.map((n) => n.variant).sort()).toEqual(["default", "hover"]);
  });
});

describe("find_nodes — id_stability marker (ADR-004 §3)", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    const tokens = await fx.store.readTokens();
    tokens.color = { primary: "#000" };
    await fx.store.writeTokens(tokens);
  });
  afterEach(() => fx.cleanup());

  it("reports \"explicit\" for a node with an id in source and \"derived\" for one without, in the same file", async () => {
    await fx.store.writePattern(
      "card-grid",
      `<div id="root"><section id="card1" style="color: $color.primary"></section><span style="color: $color.primary"></span></div>`,
    );
    const res = await findNodes(fx.store, { where: [{ kind: "style_ref", ref_path: "$color.primary" }] });
    const nodes = res.nodes as Array<{ node: string; id_stability?: "explicit" | "derived" }>;
    expect(nodes.find((n) => n.node === "pattern:card-grid.card1")?.id_stability).toBe("explicit");
    // The <span> has no explicit id — an allocator-generated one.
    expect(nodes.some((n) => n.node !== "pattern:card-grid.card1" && n.id_stability === "derived")).toBe(true);
  });
});

describe("find_nodes — duplicate variant names", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("skips a component with two same-named variants (warned, not thrown) instead of double-counting matches, without affecting other sources", async () => {
    await fx.store.writeComponent(
      "btn-primary",
      `<button id="btn">Go</button>\n<template><button id="btn2">Go</button></template>`,
    );
    await fx.store.writeScreen("home", `<div id="n1" class="$card"></div>`);
    await fx.store.writeComponent("card", `<div id="c">Card</div>`);

    const res = await findNodes(fx.store, { where: [{ kind: "component_ref", component_name: "card" }] });
    expect((res.nodes as Array<{ node: string }>).map((n) => n.node)).toEqual(["home.n1"]);
    expect(res.warnings).toEqual([
      {
        kind: "load_failed",
        target: "design-system/components/btn-primary.html",
        message: expect.stringContaining('duplicate variant "default"'),
      },
    ]);
  });
});

describe("list_comments", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    await fx.store.appendComment(
      JSON.stringify({ id: "cmt_a1", parent_id: null, screen: "home", node_id: "home.n1", author: "human", text: "fix this", resolved: false, ts: "2026-01-01T00:00:00.000Z" }),
    );
    await fx.store.appendComment(
      JSON.stringify({ id: "cmt_b2", parent_id: null, screen: "home", node_id: null, author: "human", text: "looks good", resolved: true, ts: "2026-01-01T00:00:01.000Z" }),
    );
    await fx.store.appendComment(
      JSON.stringify({ id: "cmt_a1r", parent_id: "cmt_a1", screen: "home", node_id: "home.n1", author: "agent", text: "done", resolved: false, ts: "2026-01-01T00:00:02.000Z" }),
    );
  });
  afterEach(() => fx.cleanup());

  it("defaults to open, top-level only, with reply_count", async () => {
    const res = await listComments(fx.store, {});
    expect(res.comments).toEqual([
      { id: "cmt_a1", parent_id: null, screen: "home", node: "home.n1", author: "human", body: "fix this", status: "open", reply_count: 1, created_at: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("status: any returns every thread", async () => {
    const res = await listComments(fx.store, { status: "any" });
    expect((res.comments as unknown[]).length).toBe(2);
  });

  it("include_replies flattens replies into the list", async () => {
    const res = await listComments(fx.store, { node: "home.n1", include_replies: true });
    const comments = res.comments as Array<{ id: string }>;
    expect(comments.map((c) => c.id)).toEqual(["cmt_a1", "cmt_a1r"]);
  });

  it("scopes by node over screen", async () => {
    const res = await listComments(fx.store, { screen: "home", node: "home.n1", status: "any" });
    expect((res.comments as Array<{ id: string }>).map((c) => c.id)).toEqual(["cmt_a1"]);
  });

  it("skips an unparsable line instead of throwing, and reports how many were skipped", async () => {
    await fx.store.appendComment("not valid json {{{");
    const res = await listComments(fx.store, { status: "any" });
    expect((res.comments as unknown[]).length).toBe(2); // the two well-formed roots, unaffected
    expect(res.skipped_malformed_lines).toBe(1);
  });
});
