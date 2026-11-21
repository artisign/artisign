import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { writeHtml, patchHtml, setFlow } from "./writes.js";
import { importHtml } from "./lifecycle.js";

type W = { kind: string; target?: string; message: string };
const unknown = (res: Record<string, unknown>): W[] => (res.warnings as W[]).filter((w) => w.kind === "unknown_flow_target");

describe("unknown_flow_target (CHR-1177)", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("write_html warns for a missing screen target, names the node and the target, and still writes", async () => {
    const res = await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "Home",
      html_aug: `<div id="root"><button id="go" data-flow-target="checkout">Go</button></div>`,
    });
    const warnings = unknown(res);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ target: "home.go" });
    expect(warnings[0]!.message).toContain("checkout");
    expect(await fx.store.readFlows()).toEqual([{ from: "home.go", event: "tap", to: "checkout", to_kind: "screen" }]);
  });

  it("write_html warns for a missing node in an existing screen, and for a missing screen in a node target", async () => {
    await fx.store.writeScreen("cart", `<div id="root"><span id="total"></span></div>`);
    const res = await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "Home",
      html_aug: `<div id="root"><a id="a" data-flow-target="cart.total">A</a><a id="b" data-flow-target="cart.nope">B</a><a id="c" data-flow-target="ghost.x">C</a></div>`,
    });
    expect(unknown(res).map((w) => w.target)).toEqual(["home.b", "home.c"]);
  });

  it("does not warn for existing screens, existing nodes, or a node in the same screen", async () => {
    await fx.store.writeScreen("cart", `<div id="root"></div>`);
    const res = await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "Home",
      html_aug: `<div id="root"><a id="a" data-flow-target="cart">A</a><a id="b" data-flow-target="cart.root">B</a><a id="c" data-flow-target="home.a">C</a></div>`,
    });
    expect(unknown(res)).toEqual([]);
  });

  it("stops warning once the target exists", async () => {
    const html_aug = `<div id="root"><button id="go" data-flow-target="checkout">Go</button></div>`;
    const first = await writeHtml(fx.store, { screen: "home", mode: "create", title: "Home", html_aug });
    expect(unknown(first)).toHaveLength(1);
    await writeHtml(fx.store, { screen: "checkout", mode: "create", title: "Checkout", html_aug: `<div id="root"></div>` });
    const again = await writeHtml(fx.store, { screen: "home", mode: "replace", html_aug });
    expect(unknown(again)).toEqual([]);
  });

  it("patch_html warns for a touched node only", async () => {
    await fx.store.writeScreen(
      "home",
      `<div id="root"><a id="old" data-flow-target="ghost">A</a><div id="slot"></div></div>`,
    );
    const res = await patchHtml(fx.store, {
      target: { kind: "node", node: "home.slot" },
      operation: "replace",
      html_aug: `<button id="new" data-flow-target="payment">Pay</button>`,
    });
    expect(unknown(res).map((w) => w.target)).toEqual(["home.new"]);
    expect(await fx.store.readFlows()).toHaveLength(2);
  });

  it("set_flow warns for a missing target and still writes; no warning when it exists or the flow is removed", async () => {
    await fx.store.writeScreen("home", `<div id="n1"><button id="n2"></button></div>`);
    const res = await setFlow(fx.store, { node: "home.n2", flow: { from: "home.n2", event: "tap", to: "checkout", to_kind: "screen" } });
    expect(unknown(res)).toHaveLength(1);
    expect(unknown(res)[0]).toMatchObject({ target: "home.n2" });
    expect(await fx.store.readFlows()).toHaveLength(1);

    const nodeRes = await setFlow(fx.store, { node: "home.n2", flow: { from: "home.n2", event: "tap", to: "home.zzz", to_kind: "node" } });
    expect(unknown(nodeRes)).toHaveLength(1);

    const ok = await setFlow(fx.store, { node: "home.n2", flow: { from: "home.n2", event: "tap", to: "home.n1", to_kind: "node" } });
    expect(unknown(ok)).toEqual([]);
    const removed = await setFlow(fx.store, { node: "home.n2", flow: null });
    expect(unknown(removed)).toEqual([]);
  });

  it("set_flow on a source node that does not exist is still not_found", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    await expect(
      setFlow(fx.store, { node: "home.ghost", flow: { from: "home.ghost", event: "tap", to: "x", to_kind: "screen" } }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("import_html repeated_pattern (CHR-1177)", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("returns the same repeated_pattern warnings write_html does for the same markup", async () => {
    const html_aug = `<div id="root"><div id="n1" style="background: rgba(0,0,0,.4); color: #fff; position: fixed"></div></div>`;
    await fx.store.writeScreen("checkout", html_aug);

    const written = await writeHtml(fx.store, { screen: "viaWrite", mode: "create", title: "W", html_aug });
    const imported = await importHtml(fx.store, { source: { kind: "html", html_aug, screen: "viaImport" }, dedupe: false });

    const rp = (r: Record<string, unknown>) => (r.warnings as W[]).filter((w) => w.kind === "repeated_pattern");
    expect(rp(imported)).toHaveLength(1);
    expect(rp(imported)[0]).toMatchObject({ target: "viaImport.n1", suggestion: "promote_to_system" });
    expect(rp(written)).toHaveLength(1);
    expect(rp(imported)[0]!.message.replace(/^.*?:/, "")).toBe(rp(written)[0]!.message.replace(/^.*?:/, ""));
  });

  it("returns no warnings for markup nothing repeats", async () => {
    const res = await importHtml(fx.store, { source: { kind: "html", html_aug: `<div id="n1">A</div>`, screen: "plain" } });
    expect(res.warnings).toEqual([]);
  });
});
