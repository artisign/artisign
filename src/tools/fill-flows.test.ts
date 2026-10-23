import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { writeHtml, patchHtml, updateRefs, setFlow } from "./writes.js";
import { promoteToSystem } from "./lifecycle.js";
import { findNodes } from "./reads.js";
import { revertComponentInstanceToElement } from "./node-convert.js";
import { loadRegistry, parseScreen, renderScreen } from "../model/index.js";
import { buildRenderContext } from "./render-context.js";

const NAV = `<nav id="nb"><span data-slot="back">x</span><span data-slot="title">t</span></nav>`;
const edge = (from: string, to: string, event = "tap") => ({ from, event, to, to_kind: "screen" });
const warningKinds = (res: Record<string, unknown>): string[] => (res.warnings as Array<{ kind: string }>).map((w) => w.kind);

describe("flow edges on slot-fill content (CHR-778)", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeComponent("nav-bar", NAV);
  });
  afterEach(() => fx.cleanup());

  const write = (html_aug: string, screen = "cart") => writeHtml(fx.store, { screen, mode: "create", title: screen, html_aug });

  it("records an edge for a direct fill with an authored id", async () => {
    const res = await write(`<div id="root"><div id="bar" class="$nav-bar"><button id="cart-back" data-slot="back" data-flow-target="home">Back</button></div></div>`);
    expect(await fx.store.readFlows()).toEqual([edge("cart.cart-back", "home")]);
    expect(warningKinds(res)).not.toContain("missing_id");
    expect(await fx.store.readScreen("cart")).toContain('data-flow-target="home"');
  });

  it("records edges for nested fill content, with its trigger, including an instance inside a fill", async () => {
    await write(
      `<div id="root"><div id="bar" class="$nav-bar"><div data-slot="back"><a id="deep" data-flow-target="home" data-flow-trigger="longpress">x</a></div>` +
        `<div id="inner" data-slot="title" class="$nav-bar"><button id="inner-back" data-slot="back" data-flow-target="checkout">y</button></div></div></div>`,
    );
    expect(await fx.store.readFlows()).toEqual([edge("cart.deep", "home", "longpress"), edge("cart.inner-back", "checkout")]);
  });

  it("a data-component fill carrying data-flow-target still produces its edge and survives a rewrite", async () => {
    await fx.store.writeComponent("icon-btn", `<button id="ib">i</button>`);
    const html = `<div id="root"><div id="bar" class="$nav-bar"><div id="cart-back" data-slot="back" data-component="icon-btn" data-flow-target="home"></div></div></div>`;
    await write(html);
    await writeHtml(fx.store, { screen: "cart", mode: "replace", html_aug: html });
    expect(await fx.store.readFlows()).toEqual([edge("cart.cart-back", "home")]);
    expect(await fx.store.readScreen("cart")).toContain('data-flow-target="home"');
  });

  it("find_nodes has_flow matches a fill with an edge", async () => {
    await write(`<div id="root"><div id="bar" class="$nav-bar"><button id="cart-back" data-slot="back" data-flow-target="home">Back</button></div></div>`);
    const res = (await findNodes(fx.store, { where: [{ kind: "has_flow" }] } as never)) as { nodes: Array<{ id?: string }> };
    expect(res.nodes.map((m) => m.id)).toContain("cart-back");
  });

  it("warns missing_id, writes no edge and does not block when the fill has no id", async () => {
    const res = await write(`<div id="root"><div id="bar" class="$nav-bar"><button data-slot="back" data-flow-target="home">Back</button></div></div>`);
    expect(res.commit).toBeDefined();
    expect(await fx.store.readFlows()).toEqual([]);
    expect(res.warnings).toContainEqual(expect.objectContaining({ kind: "missing_id", target: "cart.bar" }));
  });

  it("reports an invalid data-flow-trigger on a fill", async () => {
    const res = await write(`<div id="root"><div id="bar" class="$nav-bar"><button id="b" data-slot="back" data-flow-target="home" data-flow-trigger="shake">Back</button></div></div>`);
    expect(JSON.stringify(res)).toContain("shake");
  });

  it("a rewrite neither duplicates nor loses fill edges", async () => {
    const html = `<div id="root"><div id="bar" class="$nav-bar"><button id="cart-back" data-slot="back" data-flow-target="home">Back</button></div><a id="x" data-flow-target="home">x</a></div>`;
    await write(html);
    await writeHtml(fx.store, { screen: "cart", mode: "replace", html_aug: html });
    await patchHtml(fx.store, { target: { kind: "node", node: "cart.x" }, operation: "set_attr", attr: { name: "title", value: "t" } });
    expect(await fx.store.readFlows()).toEqual([edge("cart.cart-back", "home"), edge("cart.x", "home")]);
  });

  it("patch_html on a fill (by authored id) that changes or removes data-flow-target updates flows.json", async () => {
    await write(`<div id="root"><div id="bar" class="$nav-bar"><button id="cart-back" data-slot="back" data-flow-target="home">Back</button></div></div>`);
    await patchHtml(fx.store, {
      target: { kind: "node", node: "cart.cart-back" },
      operation: "replace",
      html_aug: `<button id="cart-back" data-slot="back" data-flow-target="checkout">Back</button>`,
    });
    expect(await fx.store.readFlows()).toEqual([edge("cart.cart-back", "checkout")]);

    await patchHtml(fx.store, {
      target: { kind: "node", node: "cart.cart-back" },
      operation: "replace",
      html_aug: `<button id="cart-back" data-slot="back">Back</button>`,
    });
    expect(await fx.store.readFlows()).toEqual([]);
  });

  it("patch_html rejects an invalid data-flow-trigger on a fill replacement", async () => {
    await write(`<div id="root"><div id="bar" class="$nav-bar"><button id="cart-back" data-slot="back">Back</button></div></div>`);
    await expect(
      patchHtml(fx.store, {
        target: { kind: "node", node: "cart.cart-back" },
        operation: "replace",
        html_aug: `<button id="cart-back" data-slot="back" data-flow-target="home" data-flow-trigger="shake">Back</button>`,
      }),
    ).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("not a valid data-flow-trigger") });
    expect(await fx.store.readFlows()).toEqual([]);
  });

  it("patch_html scopes the missing_id warning to the touched nodes", async () => {
    await fx.store.writeScreen(
      "cart",
      `<div id="root"><div id="bar" class="$nav-bar"><button data-slot="back" data-flow-target="home">Back</button></div><p id="plain">x</p><section id="sec"><div id="bar2" class="$nav-bar"><button data-slot="back" data-flow-target="home">Back</button></div></section></div>`,
    );
    const untouched = await patchHtml(fx.store, { target: { kind: "node", node: "cart.plain" }, operation: "set_attr", attr: { name: "title", value: "t" } });
    expect(warningKinds(untouched)).not.toContain("missing_id");

    const touched = await patchHtml(fx.store, { target: { kind: "node", node: "cart.bar" }, operation: "set_attr", attr: { name: "title", value: "t" } });
    expect(touched.warnings).toEqual([expect.objectContaining({ kind: "missing_id", target: "cart.bar" })]);

    const ancestor = await patchHtml(fx.store, { target: { kind: "node", node: "cart.sec" }, operation: "set_attr", attr: { name: "title", value: "t" } });
    expect(ancestor.warnings).toEqual([expect.objectContaining({ kind: "missing_id", target: "cart.bar2" })]);
  });

  it("an invalid data-flow-trigger on a fill is reported even without a target", async () => {
    const res = await write(`<div id="root"><div id="bar" class="$nav-bar"><button id="b" data-slot="back" data-flow-trigger="shake">Back</button></div></div>`);
    expect(JSON.stringify(res)).toContain("shake");
  });

  it("set_attr and set_flow point at the replace route for a fill's flow", async () => {
    await write(`<div id="root"><div id="bar" class="$nav-bar"><button id="cart-back" data-slot="back" data-flow-target="home">Back</button></div></div>`);
    await expect(
      patchHtml(fx.store, { target: { kind: "node", node: "cart.cart-back" }, operation: "set_attr", attr: { name: "data-flow-target", value: "x" } }),
    ).rejects.toMatchObject({ message: expect.stringContaining("replace the fill") });
    await expect(setFlow(fx.store, { node: "cart.cart-back", flow: null })).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("replacing the fill"),
    });
  });

  it("reverting an instance does not let a fill id overwrite a live node with the same id", async () => {
    await fx.store.writeComponent("card", `<div id="c"><span data-slot="slot-0">d</span></div>`);
    const registry = await loadRegistry(fx.store);
    const { doc } = parseScreen(`<div id="root"><div id="box" class="$card"><a id="fill-a">go</a></div><p id="live">x</p></div>`, "cart", registry);
    // Hand-edit collision: the fill id equals a live node id.
    doc.nodes.box!.slotOverrides!["slot-0"]!.id = "live";

    revertComponentInstanceToElement(doc, doc.nodes.box!);

    expect(doc.nodes.live!.tag).toBe("p");
    expect(Object.values(doc.nodes).filter((n) => n.tag === "a")).toHaveLength(1);
  });

  it("renders data-flow-target on a fill that is itself a component instance (preview navigation), and on a plain fill", async () => {
    await fx.store.writeComponent("icon-btn", `<button id="ib">i</button>`);
    await write(
      `<div id="root"><div id="bar" class="$nav-bar"><div id="inst" data-slot="back" data-component="icon-btn" data-flow-target="home" data-flow-trigger="hover"></div>` +
        `<a id="plain" data-slot="title" data-flow-target="checkout">t</a></div></div>`,
    );
    const registry = await loadRegistry(fx.store);
    const { doc } = parseScreen(await fx.store.readScreen("cart"), "cart", registry);
    const html = renderScreen(doc, await buildRenderContext(fx.store));
    expect(html.match(/data-flow-target="home"/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*data-flow-target="home"/);
    expect(html).toContain('data-flow-trigger="hover"');
    expect(html).toMatch(/<a[^>]*data-flow-target="checkout"/);
  });

  describe("folding a subtree into slot fills keeps its flows", () => {
    it("revert never mints an id that a folded fill already uses (no duplicate id, no wrong edge)", async () => {
      await fx.store.writeComponent("card", `<div id="c"><span data-slot="slot-0">d</span></div>`);
      await write(`<div id="root"><section id="a"><a data-flow-target="home">x</a></section><section id="b"><p>y</p></section></div>`);
      await updateRefs(fx.store, { node: "cart.a", refs: { component_ref: "card" } });
      const flows = await fx.store.readFlows();
      expect(flows).toHaveLength(1);
      await updateRefs(fx.store, { node: "cart.b", refs: { component_ref: "card" } });
      await updateRefs(fx.store, { node: "cart.b", refs: { component_ref: null } });

      const html = await fx.store.readScreen("cart");
      const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(await fx.store.readFlows()).toEqual(flows);
    });


    const body = `<div id="root"><div id="box"><a id="go" data-flow-target="home" data-flow-trigger="hover">go</a><a data-flow-target="cart">anon</a></div></div>`;

    it("update_refs component_ref: every folded flow survives as a fill edge, generated ids included, without warnings", async () => {
      await fx.store.writeComponent("card", `<div id="c"><span data-slot="slot-0">d</span></div>`);
      await write(body);
      expect(await fx.store.readFlows()).toHaveLength(2);

      const res = await updateRefs(fx.store, { node: "cart.box", refs: { component_ref: "card" } });
      const flows = await fx.store.readFlows();
      expect(flows).toHaveLength(2);
      expect(flows).toContainEqual(edge("cart.go", "home", "hover"));
      expect(flows.find((f) => f.to === "cart")?.from).toMatch(/^cart\.n\d+$/);
      expect(await fx.store.readScreen("cart")).toContain('data-flow-target="home"');
      expect(warningKinds(res)).not.toContain("missing_id");
    });

    it("promote_to_system kind=component carries edges on this screen and on structurally equal occurrences elsewhere", async () => {
      const same = `<div id="root"><div id="box"><a id="go" data-flow-target="home">go</a></div></div>`;
      await write(same);
      await write(`<div id="root"><div id="box"><a id="go2" data-flow-target="home">go</a></div></div>`, "other");
      await write(`<div id="root"><div id="box"><a id="go3">go</a></div></div>`, "third");
      expect((await fx.store.readFlows()).map((f) => f.from).sort()).toEqual(["cart.go", "other.go2"]);

      await promoteToSystem(fx.store, { node: "cart.box", kind: "component", name: "boxed" });

      expect((await fx.store.readFlows()).map((f) => f.from).sort()).toEqual(["cart.go", "other.go2"]);
      expect(await fx.store.readScreen("other")).toContain('data-flow-target="home"');
      expect(await fx.store.readScreen("third")).not.toContain("data-flow-target");
    });

    it("update_refs component_ref null moves fill flows back into doc.flows without duplicating the attribute", async () => {
      await fx.store.writeComponent("card", `<div id="c"><span data-slot="slot-0">d</span></div>`);
      await write(`<div id="root"><div id="box"><a id="go" data-flow-target="home">go</a></div></div>`);
      await updateRefs(fx.store, { node: "cart.box", refs: { component_ref: "card" } });
      await updateRefs(fx.store, { node: "cart.box", refs: { component_ref: null } });

      expect(await fx.store.readFlows()).toEqual([edge("cart.go", "home")]);
      const html = await fx.store.readScreen("cart");
      expect(html.match(/data-flow-target/g)).toHaveLength(1);
    });
  });
});
