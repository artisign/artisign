import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { writeHtml, patchHtml } from "./writes.js";
import { getScreen, getNode } from "./reads.js";
import { inspectNode } from "./inspect-node.js";
import { getScreenshot } from "./screenshot.js";
import { renderScreenDocument } from "./render-context.js";
import { __setFetchForTests } from "../model/index.js";
import type { Warning } from "./types.js";

// renderScreenDocument always tries the webfont fetch; keep it off the network.
beforeAll(() => __setFetchForTests((async () => new Response("not found", { status: 404 })) as typeof fetch));
afterAll(() => __setFetchForTests(undefined));

let fx: ProjectFixture;
beforeEach(async () => {
  fx = await setupProject();
});
afterEach(() => fx.cleanup());

const LAYER_OPEN = '<div data-backdrop-layer inert style="position:absolute; inset:0; overflow:hidden; pointer-events:none; z-index:-1">';

async function put(screen: string, html: string): Promise<void> {
  await fx.store.writeScreen(screen, html);
}
const render = async (screen: string, backdrop?: "omit"): Promise<string> =>
  (await renderScreenDocument(fx.store, screen, { fontMode: "url", backdrop })).documentHtml;

/** The layer's contents, from the opening tag to the matching close — layers nest, so count divs. */
function layerOf(html: string): string {
  const start = html.indexOf(LAYER_OPEN);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (const m of html.slice(start).matchAll(/<div\b|<\/div>/g)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(start, start + m.index! + m[0].length);
  }
  throw new Error("unterminated layer");
}

describe("backdrop render", () => {
  it("makes the layer the root's first child, with isolation and a default position", async () => {
    await put("parent", `<div id="p-root" style="width: 390px; height: 844px"><p id="p1">parent text</p></div>`);
    await put("sheet", `<div id="s-root" data-backdrop="parent" style="width: 390px; height: 844px; background: red"><div id="sheet">own</div></div>`);
    const html = await render("sheet");
    expect(html).toMatch(/<div id="s-root"[^>]*style="[^"]*width: 390px[^"]*isolation: isolate; position: relative"[^>]*>/);
    expect(html).toContain(`>${LAYER_OPEN}<div style="width: 390px; height: 844px"><p>parent text</p></div></div><div id="sheet">own</div></div>`);
    expect(html.split("data-backdrop-layer").length - 1).toBe(1);
    // the overlay root stays the first element of <body> with its own id
    expect(html).toMatch(/<body[^>]*>\s*<div id="s-root"/);
  });

  it("keeps a declared position on the root", async () => {
    await put("parent", `<div id="p-root"></div>`);
    await put("sheet", `<div id="s-root" data-backdrop="parent" style="position: absolute; top: 0"></div>`);
    const html = await render("sheet");
    expect(html).toContain("position: absolute; top: 0; isolation: isolate");
    expect(html).not.toContain("position: relative");
  });

  it("renders the target without ids or data-flow-*, including slot fills and component templates", async () => {
    await fx.store.writeComponent("card", `<div id="c" data-flow-target="home"><div data-slot="body">x</div></div>`);
    await put(
      "parent",
      `<div id="p-root" data-flow-target="home"><button id="b" data-flow-target="home" data-flow-trigger="hover">Go</button>` +
        `<div id="card1" class="$card"><div data-slot="body"><span id="fill" data-flow-target="home">fill</span>` +
        `<div id="inner" class="$card" data-flow-target="home"></div></div></div></div>`,
    );
    await put("sheet", `<div id="s-root" data-backdrop="parent"></div>`);
    const layer = layerOf(await render("sheet"));
    expect(layer).toContain("Go");
    expect(layer).toContain("fill");
    expect(layer).not.toMatch(/\sid=/);
    expect(layer).not.toContain("data-flow-");
    // the same screen rendered on its own keeps both
    const own = await render("parent");
    expect(own).toContain('id="b"');
    expect(own).toContain("data-flow-target");
  });

  it("nests a transitive chain: C inside B inside A's layer", async () => {
    await put("c", `<div id="c-root"><p>from c</p></div>`);
    await put("b", `<div id="b-root" data-backdrop="c"><p>from b</p></div>`);
    await put("a", `<div id="a-root" data-backdrop="b"><p>from a</p></div>`);
    const layer = layerOf(await render("a"));
    expect(layer.indexOf("from b")).toBeGreaterThan(0);
    const bLayer = layerOf(layer.slice(LAYER_OPEN.length));
    expect(bLayer).toContain("from c");
    expect(layer).not.toContain("data-unresolved-backdrop");
  });

  it("marks the root and omits the layer for a missing target", async () => {
    await put("sheet", `<div id="s-root" data-backdrop="ghost"></div>`);
    const html = await render("sheet");
    expect(html).toContain("data-unresolved-backdrop");
    expect(html).not.toContain("data-backdrop-layer");
  });

  it("ends a cycle on disk at the first repeated screen without throwing", async () => {
    await put("a", `<div id="a-root" data-backdrop="b"><p>from a</p></div>`);
    await put("b", `<div id="b-root" data-backdrop="a"><p>from b</p></div>`);
    const html = await render("a");
    const layer = layerOf(html);
    expect(layer).toContain("from b");
    expect(layer).toContain("data-unresolved-backdrop");
    expect(html.split("data-backdrop-layer").length - 1).toBe(1);
    // the marker sits on b's root inside the layer, not on a's own root
    expect(html.slice(html.indexOf("<body"), html.indexOf("data-backdrop-layer"))).not.toContain("data-unresolved-backdrop");
  });

  it("ignores data-backdrop on a non-root element", async () => {
    await put("parent", `<div id="p-root"></div>`);
    await put("sheet", `<div id="s-root"><div id="inner" data-backdrop="parent"></div></div>`);
    expect(await render("sheet")).not.toContain("data-backdrop-layer");
  });

  it("renders no layer with backdrop: omit", async () => {
    await put("parent", `<div id="p-root"></div>`);
    await put("sheet", `<div id="s-root" data-backdrop="parent"></div>`);
    expect(await render("sheet", "omit")).not.toContain("data-backdrop-layer");
  });
});

describe("backdrop consumers", () => {
  beforeEach(async () => {
    await put("parent", `<div id="p-root"><p id="p1">parent</p></div>`);
    await put("sheet", `<div id="s-root" data-backdrop="parent"><p id="own">own</p></div>`);
  });

  it("get_screen reports backdrop at every view and only when set", async () => {
    for (const view of ["summary", "tree", "full"] as const) {
      expect((await getScreen(fx.store, { screen: "sheet", view })).backdrop).toBe("parent");
      expect("backdrop" in (await getScreen(fx.store, { screen: "parent", view }))).toBe(false);
    }
    expect((await getScreen(fx.store, { screen: "sheet", fields: ["nodes"] })).backdrop).toBe("parent");
  });

  it("get_screen rendered_html renders own nodes only", async () => {
    const res = await getScreen(fx.store, { screen: "sheet", view: "full", fields: ["rendered_html"] });
    expect(res.rendered_html).not.toContain("data-backdrop-layer");
    expect(res.rendered_html).not.toContain("parent</p>");
  });

  it("an unresolved ref on a backdrop screen names the backdrop in get_node, patch_html and inspect_node", async () => {
    const hint = 'the node may belong to the backdrop "parent"; address it as "parent.<id>"';
    await expect(getNode(fx.store, { node: "sheet.p1" })).rejects.toMatchObject({ code: "not_found", message: expect.stringContaining(hint) });
    await expect(
      patchHtml(fx.store, { target: { kind: "node", node: "sheet.p1" }, operation: "delete" }),
    ).rejects.toMatchObject({ code: "not_found", message: expect.stringContaining(hint) });
    await expect(inspectNode(fx.store, { node: "sheet.p1" })).rejects.toMatchObject({ code: "not_found", message: expect.stringContaining(hint) });
    await expect(getScreenshot(fx.store, { screen: "sheet", node: "sheet.p1" })).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining(hint),
    });
  });

  it("gives no hint on a screen without a backdrop", async () => {
    const err = await getNode(fx.store, { node: "parent.nope" }).catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain("backdrop");
  });

  it("drift in the backdrop target adds no warnings to the overlay's write", async () => {
    const tokens = await fx.store.readTokens();
    tokens.color = { primary: "#3366ff" };
    await fx.store.writeTokens(tokens);
    const res = await writeHtml(fx.store, {
      screen: "parent2",
      mode: "create",
      title: "p2",
      html_aug: `<div id="r"><p id="x" style="color: #3366ff; padding: 3px; margin: 2px">drifty</p></div>`,
    });
    expect((res.warnings as Warning[]).some((w) => w.kind === "drift")).toBe(true);
    const sheet = await writeHtml(fx.store, {
      screen: "sheet2",
      mode: "create",
      title: "s2",
      html_aug: `<div id="r2" data-backdrop="parent2"><p id="y">own</p></div>`,
    });
    expect(sheet.warnings).toEqual([]);
  });
});
