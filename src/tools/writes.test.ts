import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { writeHtml, patchHtml, updateRefs, setTokens, setFlow } from "./writes.js";
import { buildRenderContext } from "./render-context.js";
import { parseScreen, renderScreen, loadRegistry } from "../model/index.js";
import { FsStore } from "../store/index.js";
import { ToolError, type Warning } from "./types.js";

describe("write_html", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("creates a new screen and returns a terse summary that never echoes the input", async () => {
    const html_aug = `<section id="n1" style="color: #123456"><h1 id="n2">Welcome</h1></section>`;
    const res = await writeHtml(fx.store, { screen: "home", mode: "create", title: "Home", html_aug });

    expect(res).toMatchObject({ screen: "home", path: "screens/home.html", root_node_id: "n1", node_count: 3 });
    expect(JSON.stringify(res)).not.toContain("Welcome");
    expect(await fx.store.readScreen("home")).toContain("Welcome");
  });

  it("names commit_skipped_reason when auto-commit is disabled", async () => {
    const res = await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "Home",
      html_aug: `<div id="n1"></div>`,
    });
    expect(res.commit).toBeNull();
    expect(res.commit_skipped_reason).toBe("disabled");
  });

  it("rejects create on an existing screen", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    await expect(
      writeHtml(fx.store, { screen: "home", mode: "create", title: "x", html_aug: `<div id="n1"></div>` }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("requires a title on create", async () => {
    await expect(writeHtml(fx.store, { screen: "home", mode: "create", html_aug: `<div id="n1"></div>` })).rejects.toThrow(
      ToolError,
    );
  });

  it("rejects replace on a missing screen", async () => {
    await expect(
      writeHtml(fx.store, { screen: "nope", mode: "replace", html_aug: `<div id="n1"></div>` }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("blocks the write and reports errors when the HTML doesn't validate, without touching disk", async () => {
    const res = await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "x",
      html_aug: `<div id="n1"><span id="n1"></span></div>`, // duplicate node id
    });
    expect(res.commit).toBeNull();
    expect(res.errors).toBeDefined();
    await expect(fx.store.readScreen("home")).rejects.toThrow();
  });

  it("warns instead of blocking on an unresolved ref, so untouched screens can round-trip after a token/component is removed elsewhere", async () => {
    const res = await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "x",
      html_aug: `<div id="n1" style="color: $color.gone"></div>`,
    });
    expect(res.errors).toBeUndefined();
    expect(res.warnings).toContainEqual({
      kind: "unknown_ref",
      target: "home.n1",
      message: '"$color.gone" does not resolve in the design system',
    });
    expect(await fx.store.readScreen("home")).toContain("$color.gone");
  });

  it("warns on a full-value typography ref that doesn't resolve (e.g. font: $typography.body)", async () => {
    const res = await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "x",
      html_aug: `<div id="n1" style="font: $typography.body"></div>`,
    });
    expect(res.errors).toBeUndefined();
    expect(res.warnings).toContainEqual({
      kind: "unknown_ref",
      target: "home.n1",
      message: '"$typography.body" does not resolve in the design system',
    });
  });

  it("warns instead of blocking on an unknown data-component name, and the commit succeeds", async () => {
    const res = await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "x",
      html_aug: `<div id="n1" data-component="does-not-exist"></div>`,
    });
    expect(res.errors).toBeUndefined();
    expect(res.commit).toBeNull(); // autoCommit is disabled in the test fixture — a non-blocking write still succeeds
    expect(res.warnings).toContainEqual({
      kind: "unknown_ref",
      target: "home.n1",
      message: 'component "does-not-exist" (data-component) is not in the design system',
    });
    expect(await fx.store.readScreen("home")).toContain('data-component="does-not-exist"');
  });

  it("diff response_mode reports added/removed/changed nodes", async () => {
    await writeHtml(fx.store, { screen: "home", mode: "create", title: "x", html_aug: `<div id="n1"><span id="n2"></span></div>` });
    const res = await writeHtml(fx.store, {
      screen: "home",
      mode: "replace",
      html_aug: `<div id="n1"><span id="n3"></span></div>`,
      response_mode: "diff",
    });
    expect(res.diff).toEqual({ added: ["home.n3"], removed: ["home.n2"], changed: [] });
  });

  it("syncs flows.json from data-flow-* attributes in the written HTML", async () => {
    await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "x",
      html_aug: `<div id="n1"><button id="n2" data-flow-target="checkout">Go</button></div>`,
    });
    expect(await fx.store.readFlows()).toEqual([{ from: "home.n2", event: "tap", to: "checkout", to_kind: "screen" }]);
  });

  it("warns instead of blocking on a misspelled augmentation attribute", async () => {
    const res = await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "x",
      html_aug: `<div id="n1" data-varient="hover"></div>`,
    });
    expect(res.errors).toBeUndefined();
    expect(res.warnings).toContainEqual({
      kind: "suspicious_attr",
      target: "home.n1",
      message: 'attribute "data-varient" is not part of the augmentation grammar — did you mean "data-variant"?',
    });
    expect(await fx.store.readScreen("home")).toContain('data-varient="hover"');
  });

  it("returns an empty warnings array for a fully clean screen (zero noise)", async () => {
    const res = await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "x",
      html_aug: `<div id="n1" data-testid="hero"><span id="n2">Hi</span></div>`,
    });
    expect(res.errors).toBeUndefined();
    expect(res.warnings).toEqual([]);
  });

  it("writing padding: 16px when spacing.md is 16px produces a drift warning and still succeeds", async () => {
    const tokens = await fx.store.readTokens();
    tokens.spacing = { md: "16px" };
    await fx.store.writeTokens(tokens);

    const res = await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "x",
      html_aug: `<div id="n1" style="padding: 16px"></div>`,
    });

    expect(res.errors).toBeUndefined(); // the write succeeded, not blocked
    expect(res.warnings).toEqual([
      { kind: "drift", target: "home.n1", message: 'inline value "16px" for "padding" matches token $spacing.md', suggestion: "$spacing.md" },
    ]);
    expect(await fx.store.readScreen("home")).toContain("padding: 16px");
  });
});

describe("write_html kind component/pattern", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("writes the definition file verbatim, without canonicalizing it", async () => {
    const html_aug = `<button id="btn"  class="cta">Go</button>`;
    const res = await writeHtml(fx.store, { screen: "btn-primary", mode: "create", kind: "component", html_aug });

    expect(res).toMatchObject({ kind: "component", name: "btn-primary", path: "design-system/components/btn-primary.html", variants: ["default"] });
    expect(await fx.store.readComponent("btn-primary")).toBe(html_aug);
  });

  it("rejects create on an existing component and replace on a missing one", async () => {
    await fx.store.writeComponent("btn-primary", `<button id="btn">Go</button>`);
    await expect(
      writeHtml(fx.store, { screen: "btn-primary", mode: "create", kind: "component", html_aug: `<button id="btn">Go</button>` }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      writeHtml(fx.store, { screen: "nope", mode: "replace", kind: "component", html_aug: `<button id="btn">Go</button>` }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects title on a component/pattern write", async () => {
    await expect(
      writeHtml(fx.store, { screen: "btn-primary", mode: "create", kind: "component", title: "x", html_aug: `<button id="btn">Go</button>` }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("blocks on an empty body without writing", async () => {
    const res = await writeHtml(fx.store, { screen: "btn-primary", mode: "create", kind: "component", html_aug: `` });
    expect(res.commit).toBeNull();
    expect(res.errors).toBeDefined();
    await expect(fx.store.readComponent("btn-primary")).rejects.toThrow();
  });

  it("blocks on duplicate variant names", async () => {
    const html_aug = `<button id="btn">Go</button><template data-variant="hover"><button id="btn">Go</button></template><template data-variant="hover"><button id="btn">Go</button></template>`;
    const res = await writeHtml(fx.store, { screen: "btn-primary", mode: "create", kind: "component", html_aug });
    expect(res.commit).toBeNull();
    expect(res.errors).toBeDefined();
    await expect(fx.store.readComponent("btn-primary")).rejects.toThrow();
  });

  it("warns instead of blocking on an unresolved token ref inside a variant", async () => {
    const html_aug = `<button id="btn" style="color: $color.gone">Go</button>`;
    const res = await writeHtml(fx.store, { screen: "btn-primary", mode: "create", kind: "component", html_aug });
    expect(res.errors).toBeUndefined();
    expect(res.warnings).toContainEqual({
      kind: "unknown_ref",
      target: "btn-primary#default",
      message: '"$color.gone" does not resolve in the design system',
    });
    expect(res.commit).toBeDefined();
  });

  // Slot substitution replaces the placeholder element wholesale, so
  // style/class on a data-slot element never reaches the render. The write
  // stays valid — it just can't stay silent, or the definition is a lie.
  it("warns when a data-slot element carries styling the render will discard", async () => {
    const html_aug = `<div id="card"><h3 id="t" data-slot="title" style="font-weight: 700">Title</h3></div>`;
    const res = await writeHtml(fx.store, { screen: "card", mode: "create", kind: "component", html_aug });

    expect(res.errors).toBeUndefined();
    expect(res.commit).toBeDefined();
    expect(res.warnings).toContainEqual({
      kind: "suspicious_attr",
      target: "card#default",
      message: 'slot "title" carries its own style/class/component ref, which an instance filling this slot discards',
      suggestion:
        "style a wrapper around the slot instead — and keep instances naming their slots (data-slot=...), because a wrapper directly under the definition root is itself a positional slot",
    });
  });

  it("warns when a slot carries a component ref — the costliest discard of all", async () => {
    await writeHtml(fx.store, { screen: "badge", mode: "create", kind: "component", html_aug: `<span id="b">B</span>` });
    const html_aug = `<div id="card"><div id="s" data-slot="mark" class="$badge"></div></div>`;
    const res = await writeHtml(fx.store, { screen: "card", mode: "create", kind: "component", html_aug });

    const slotWarnings = ((res.warnings ?? []) as Warning[]).filter((w) => w.message.includes("an instance filling this slot discards"));
    expect(slotWarnings).toHaveLength(1);
    expect(slotWarnings[0]!.message).toContain('slot "mark"');
  });

  it("warns for a plain class as well as a token ref, one warning per slot", async () => {
    const html_aug = `<div id="card"><h3 id="t" data-slot="title" class="headline">T</h3><p id="b" data-slot="body" style="color: $color.primary">B</p></div>`;
    const res = await writeHtml(fx.store, { screen: "card", mode: "create", kind: "component", html_aug });

    const slotWarnings = ((res.warnings ?? []) as Warning[]).filter((w) => w.message.includes("an instance filling this slot discards"));
    expect(slotWarnings.map((w) => w.message)).toEqual([
      'slot "title" carries its own style/class/component ref, which an instance filling this slot discards',
      'slot "body" carries its own style/class/component ref, which an instance filling this slot discards',
    ]);
  });

  it("stays quiet for an unstyled slot and for the styled wrapper the warning recommends", async () => {
    // The wrapper here sits directly under the root, which makes it an
    // implicit positional slot — styling it is only safe while instances
    // name their slots, which is what the suggestion text spells out.
    // Warning here would flag the very remedy the warning recommends.
    const html_aug = `<div id="card" style="padding: 8px"><div id="w" style="font-weight: 700"><h3 id="t" data-slot="title">Title</h3></div></div>`;
    const res = await writeHtml(fx.store, { screen: "card", mode: "create", kind: "component", html_aug });

    expect(res.warnings).toEqual([]);
  });

  it("blocks a component that references itself", async () => {
    await expect(
      writeHtml(fx.store, {
        screen: "btn-primary",
        mode: "create",
        kind: "component",
        html_aug: `<button id="btn" data-component="btn-primary">Go</button>`,
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("writes a pattern under design-system/patterns/", async () => {
    const html_aug = `<div id="grid"><div id="c1"></div></div>`;
    const res = await writeHtml(fx.store, { screen: "card-grid", mode: "create", kind: "pattern", html_aug });
    expect(res).toMatchObject({ kind: "pattern", name: "card-grid", path: "design-system/patterns/card-grid.html" });
    expect(await fx.store.readPattern("card-grid")).toBe(html_aug);
  });

  it("ignores response_mode diff — no diff key in the response", async () => {
    const res = await writeHtml(fx.store, {
      screen: "btn-primary",
      mode: "create",
      kind: "component",
      html_aug: `<button id="btn">Go</button>`,
      response_mode: "diff",
    });
    expect(res.diff).toBeUndefined();
  });

  it("does not touch flows.json even with a data-flow-target inside a definition", async () => {
    await writeHtml(fx.store, {
      screen: "btn-primary",
      mode: "create",
      kind: "component",
      html_aug: `<button id="btn" data-flow-target="checkout">Go</button>`,
    });
    expect(await fx.store.readFlows()).toEqual([]);
  });
});

describe("patch_html", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<section id="n1"><h1 id="n2">Old</h1><p id="n3" class="tag">Body</p></section>`);
  });
  afterEach(() => fx.cleanup());

  it("replaces a node by ref", async () => {
    const res = await patchHtml(fx.store, {
      target: { kind: "node", node: "home.n2" },
      operation: "replace",
      html_aug: `<h1 id="n2">New</h1>`,
    });
    expect(res.affected_nodes).toEqual(["home.n2"]);
    expect(await fx.store.readScreen("home")).toContain("New");
    expect(await fx.store.readScreen("home")).not.toContain("Old");
  });

  it("inserts a sibling after a node", async () => {
    await patchHtml(fx.store, {
      target: { kind: "node", node: "home.n2" },
      operation: "insert_after",
      html_aug: `<p id="n4">Inserted</p>`,
    });
    const html = await fx.store.readScreen("home");
    expect(html.indexOf("Inserted")).toBeGreaterThan(html.indexOf("Old"));
    expect(html.indexOf("Inserted")).toBeLessThan(html.indexOf("Body"));
  });

  it("deletes a node and its subtree", async () => {
    const res = await patchHtml(fx.store, { target: { kind: "node", node: "home.n2" }, operation: "delete" });
    expect(res.affected_nodes).toEqual(["home.n2"]);
    expect(await fx.store.readScreen("home")).not.toContain("Old");
  });

  it("sets a plain attribute", async () => {
    await patchHtml(fx.store, {
      target: { kind: "node", node: "home.n3" },
      operation: "set_attr",
      attr: { name: "data-testid", value: "body-copy" },
    });
    expect(await fx.store.readScreen("home")).toContain('data-testid="body-copy"');
  });

  it("rejects set_attr on a ref-bearing attribute name, naming update_refs", async () => {
    await expect(
      patchHtml(fx.store, { target: { kind: "node", node: "home.n3" }, operation: "set_attr", attr: { name: "style", value: "color: red" } }),
    ).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("use update_refs instead") });
  });

  it("rejects set_attr on data-flow-target, naming set_flow", async () => {
    await expect(
      patchHtml(fx.store, { target: { kind: "node", node: "home.n3" }, operation: "set_attr", attr: { name: "data-flow-target", value: "checkout" } }),
    ).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("use set_flow instead") });
  });

  it("rejects set_attr on id, saying node ids are stable", async () => {
    await expect(
      patchHtml(fx.store, { target: { kind: "node", node: "home.n3" }, operation: "set_attr", attr: { name: "id", value: "renamed" } }),
    ).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("stable node id") });
  });

  it("resolves a node via a simple CSS selector", async () => {
    const res = await patchHtml(fx.store, {
      target: { kind: "selector", screen: "home", css_selector: ".tag" },
      operation: "set_attr",
      attr: { name: "data-hit", value: "1" },
    });
    expect(res.affected_nodes).toEqual(["home.n3"]);
  });

  it("throws not_found when the selector matches nothing", async () => {
    await expect(
      patchHtml(fx.store, { target: { kind: "selector", screen: "home", css_selector: ".nope" }, operation: "delete" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("scopes drift warnings to affected_nodes and counts the rest", async () => {
    const tokens = await fx.store.readTokens();
    tokens.spacing = { md: "16px" };
    await fx.store.writeTokens(tokens);
    await fx.store.writeScreen(
      "home",
      `<section id="root"><div id="n1" style="padding: 16px"></div><div id="n2" style="padding: 16px"></div></section>`,
    );

    const res = await patchHtml(fx.store, {
      target: { kind: "node", node: "home.n1" },
      operation: "set_attr",
      attr: { name: "data-testid", value: "one" },
    });

    expect(res.affected_nodes).toEqual(["home.n1"]);
    expect(res.warnings).toEqual([
      { kind: "drift", target: "home.n1", message: 'inline value "16px" for "padding" matches token $spacing.md', suggestion: "$spacing.md" },
    ]);
    expect(res.preexisting_drift_count).toBe(1); // n2's drift, untouched by this patch
  });

  it("warns instead of throwing when an inserted fragment references an unresolved ref", async () => {
    const res = await patchHtml(fx.store, {
      target: { kind: "node", node: "home.n2" },
      operation: "insert_after",
      html_aug: `<p id="n4" style="color: $color.gone">Inserted</p>`,
    });
    expect(res.affected_nodes).toEqual(["home.n4"]);
    expect(res.warnings).toContainEqual({
      kind: "unknown_ref",
      target: "home.n4",
      message: '"$color.gone" does not resolve in the design system',
    });
    expect(await fx.store.readScreen("home")).toContain("Inserted");
  });

  it("still throws on a genuinely malformed inserted fragment (duplicate id within the fragment)", async () => {
    await expect(
      patchHtml(fx.store, {
        target: { kind: "node", node: "home.n2" },
        operation: "insert_after",
        html_aug: `<p id="dup"></p><p id="dup"></p>`,
      }),
    ).rejects.toThrow(ToolError);
  });
});

describe("update_refs", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    const tokens = await fx.store.readTokens();
    tokens.color = { primary: "#000", secondary: "#111" };
    await fx.store.writeTokens(tokens);
    await fx.store.writeComponent("btn-primary", `<button id="n1">Go</button>`);
    await fx.store.writeScreen("home", `<div id="n1" style="color: $color.primary"></div>`);
  });
  afterEach(() => fx.cleanup());

  it("is the cheapest write: no html_aug in the input or output", async () => {
    const res = await updateRefs(fx.store, { node: "home.n1", refs: { token_refs: { color: "color.secondary" } } });
    expect(JSON.stringify(res)).not.toContain("html_aug");
    expect(await fx.store.readScreen("home")).toContain("$color.secondary");
  });

  it("deletes a binding with a null value", async () => {
    await updateRefs(fx.store, { node: "home.n1", refs: { token_refs: { color: null } } });
    expect(await fx.store.readScreen("home")).not.toContain("$color");
  });

  it("clears a pre-existing inline literal for the same property when adopting a token ref (acceptance bug #2)", async () => {
    // A drifted literal that happens to equal an existing token's value —
    // write_html would flag this with a drift warning, and update_refs is
    // the tool-sanctioned way to act on that suggestion (patch_html
    // explicitly refuses style set_attr and points agents at update_refs).
    const writeRes = await writeHtml(fx.store, {
      screen: "home",
      mode: "replace",
      html_aug: `<div id="n1" style="color: #000"></div>`,
    });
    expect(writeRes.warnings).toContainEqual({
      kind: "drift",
      target: "home.n1",
      message: 'inline value "#000" for "color" matches token $color.primary',
      suggestion: "$color.primary",
    });

    const res = await updateRefs(fx.store, { node: "home.n1", refs: { token_refs: { color: "color.primary" } } });
    expect(res.warnings).toEqual([]);

    const html = await fx.store.readScreen("home");
    expect(html).toBe(`<div id="n1" style="color: $color.primary"></div>`); // literal is gone, only the ref remains

    const registry = await loadRegistry(fx.store);
    const { doc } = parseScreen(html, "home", registry);
    const ctx = await buildRenderContext(fx.store);
    const rendered = renderScreen(doc, ctx);
    expect(rendered).toContain("#000"); // color.primary's resolved value
  });

  it("writes the token's resolved value back as a literal when a ref is removed, instead of losing the property entirely", async () => {
    // literal -> adopt -> remove: the property must survive each step.
    await writeHtml(fx.store, { screen: "home", mode: "replace", html_aug: `<div id="n1" style="color: #000"></div>` });
    await updateRefs(fx.store, { node: "home.n1", refs: { token_refs: { color: "color.primary" } } });

    const res = await updateRefs(fx.store, { node: "home.n1", refs: { token_refs: { color: null } } });
    expect(res.warnings).toEqual([]);

    const html = await fx.store.readScreen("home");
    expect(html).toBe(`<div id="n1" style="color: #000"></div>`); // the ref is gone, but color survives as a literal
  });

  it("sets a component_ref and switches the node to a component instance", async () => {
    await updateRefs(fx.store, { node: "home.n1", refs: { component_ref: "btn-primary" } });
    expect(await fx.store.readScreen("home")).toContain('class="$btn-primary"');
  });

  it("preserves a node's children when converting it to a component instance", async () => {
    await fx.store.writeScreen("home", `<div id="n1"><span id="n2">label</span><i id="n3" class="icon"></i></div>`);
    const res = await updateRefs(fx.store, { node: "home.n1", refs: { component_ref: "btn-primary" } });
    expect(res.warnings).toEqual([]);

    const html = await fx.store.readScreen("home");
    expect(html).toContain("label");
    expect(html).toContain('class="icon"');
  });

  it("restores a component instance's content as real children when component_ref is cleared", async () => {
    await fx.store.writeScreen("home", `<div id="n1"><span id="n2">label</span></div>`);
    await updateRefs(fx.store, { node: "home.n1", refs: { component_ref: "btn-primary" } });
    await updateRefs(fx.store, { node: "home.n1", refs: { component_ref: null } });

    const html = await fx.store.readScreen("home");
    expect(html).toContain("label");
    expect(html).not.toContain("$btn-primary");
  });

  it("warns (without blocking) on an unresolved token ref", async () => {
    const res = await updateRefs(fx.store, { node: "home.n1", refs: { token_refs: { color: "color.nope" } } });
    expect(res.warnings).toEqual([{ kind: "unknown_ref", target: "home.n1", message: '"$color.nope" does not resolve in the design system' }]);
    // warnings never block — the write still goes through.
    expect(await fx.store.readScreen("home")).toContain("$color.nope");
  });

  it("throws not_found for a missing node", async () => {
    await expect(updateRefs(fx.store, { node: "home.n999", refs: {} })).rejects.toMatchObject({ code: "not_found" });
  });

  it("replaces a mixed literal/ref value wholesale when setting a plain ref on the same property", async () => {
    await fx.store.writeScreen("home", `<div id="n1" style="border: 1px solid $color.primary"></div>`);
    await updateRefs(fx.store, { node: "home.n1", refs: { token_refs: { border: "color.secondary" } } });
    expect(await fx.store.readScreen("home")).toBe(`<div id="n1" style="border: $color.secondary"></div>`);
  });

  it("writes a mixed value's fully resolved literal back when its ref is removed", async () => {
    await fx.store.writeScreen("home", `<div id="n1" style="border: 1px solid $color.primary"></div>`);
    const res = await updateRefs(fx.store, { node: "home.n1", refs: { token_refs: { border: null } } });
    expect(res.warnings).toEqual([]);
    expect(await fx.store.readScreen("home")).toBe(`<div id="n1" style="border: 1px solid #000"></div>`);
  });

  it("switching a component instance's variant via update_refs is reflected end-to-end in the render output", async () => {
    await fx.store.writeComponent(
      "btn-primary",
      `<button style="color: $color.primary">Default</button>\n<template data-variant="hover"><button style="color: $color.secondary">Hover</button></template>`,
    );
    await fx.store.writeScreen("home", `<div id="n1" class="$btn-primary"></div>`);

    const registry = await loadRegistry(fx.store);
    const before = await fx.store.readScreen("home");
    const { doc: beforeDoc } = parseScreen(before, "home", registry);
    const instanceId = Object.values(beforeDoc.nodes).find((n) => n.kind === "component_instance")!.id;

    const beforeCtx = await buildRenderContext(fx.store);
    const beforeHtml = renderScreen(beforeDoc, beforeCtx);
    expect(beforeHtml).toContain("Default");
    expect(beforeHtml).toContain("#000"); // color.primary from the update_refs describe-block's beforeEach
    expect(beforeHtml).not.toContain("Hover");

    await updateRefs(fx.store, { node: `home.${instanceId}`, refs: { variant: "hover" } });

    const after = await fx.store.readScreen("home");
    expect(after).toContain('data-variant="hover"');
    const { doc: afterDoc } = parseScreen(after, "home", registry);
    const afterCtx = await buildRenderContext(fx.store);
    const afterHtml = renderScreen(afterDoc, afterCtx);
    expect(afterHtml).toContain("Hover");
    expect(afterHtml).toContain("#111"); // color.secondary
    expect(afterHtml).not.toContain("Default");
  });
});

describe("patch_html — component/pattern definitions (ADR-004 §2)", () => {
  let fx: ProjectFixture;

  // Mirrors patch-definition.test.ts's MULTI_ROOT_DEFINITION —
  // multiple top-level default elements plus a <template data-variant> sibling.
  const DEFINITION =
    `<section id="hero" style="padding: 4px">\n  <h1 id="title">Hello</h1>\n</section>\n` +
    `<footer id="foot">Bye</footer>\n` +
    `<template data-variant="hover">\n  <section id="hero-hover"><span id="lbl">Hi</span></section>\n</template>\n`;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeComponent("card", DEFINITION);
    await fx.store.writePattern("grid", `<div id="root"><section id="card1"></section><section id="card2"></section></div>`);
  });
  afterEach(() => fx.cleanup());

  it("set_attr on a component node succeeds, byte-identical outside the change (AC1)", async () => {
    const res = await patchHtml(fx.store, {
      target: { kind: "node", node: "component:card#default.foot" },
      operation: "set_attr",
      attr: { name: "data-x", value: "1" },
    });
    expect(res.affected_nodes).toEqual(["component:card#default.foot"]);
    expect(await fx.store.readComponent("card")).toBe(DEFINITION.replace(`<footer id="foot">`, `<footer id="foot" data-x="1">`));
  });

  it("delete on a pattern node succeeds, byte-identical outside the change (AC1)", async () => {
    const res = await patchHtml(fx.store, { target: { kind: "node", node: "pattern:grid.card2" }, operation: "delete" });
    expect(res.affected_nodes).toEqual(["pattern:grid.card2"]);
    expect(await fx.store.readPattern("grid")).toBe(`<div id="root"><section id="card1"></section></div>`);
  });

  it("replace on a component variant node, byte-identical outside the change (AC1)", async () => {
    await patchHtml(fx.store, {
      target: { kind: "node", node: "component:card#hover.lbl" },
      operation: "replace",
      html_aug: `<span id="lbl">Yo</span>`,
    });
    expect(await fx.store.readComponent("card")).toBe(DEFINITION.replace(`<span id="lbl">Hi</span>`, `<span id="lbl">Yo</span>`));
  });

  it("insert_before on a pattern node", async () => {
    await patchHtml(fx.store, {
      target: { kind: "node", node: "pattern:grid.card1" },
      operation: "insert_before",
      html_aug: `<section id="card0"></section>`,
    });
    expect(await fx.store.readPattern("grid")).toBe(
      `<div id="root"><section id="card0"></section><section id="card1"></section><section id="card2"></section></div>`,
    );
  });

  it("reports the definition's own path and address, not a screen's", async () => {
    const res = await patchHtml(fx.store, { target: { kind: "node", node: "component:card#default.foot" }, operation: "delete" });
    expect(res.path).toBe("design-system/components/card.html");
    expect(res.screen).toBe("component:card#default");
  });

  it("never reports preexisting_drift_count for a definition write — omitted, not fabricated as 0", async () => {
    const res = await patchHtml(fx.store, { target: { kind: "node", node: "component:card#default.foot" }, operation: "delete" });
    expect(res).not.toHaveProperty("preexisting_drift_count");
  });

  it("rejects response_mode: \"diff\" against a definition ref instead of returning a placeholder diff", async () => {
    await expect(
      patchHtml(fx.store, {
        target: { kind: "node", node: "component:card#default.foot" },
        operation: "delete",
        response_mode: "diff",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    // Rejected before any write — the file is untouched.
    expect(await fx.store.readComponent("card")).toBe(DEFINITION);
  });

  it("rejects response_mode: \"full\" against a definition ref the same way", async () => {
    await expect(
      patchHtml(fx.store, { target: { kind: "node", node: "component:card#default.foot" }, operation: "delete", response_mode: "full" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("returns not_found for an unknown node id in the variant", async () => {
    await expect(
      patchHtml(fx.store, { target: { kind: "node", node: "component:card#default.nope" }, operation: "delete" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns not_found for an unknown component name", async () => {
    await expect(
      patchHtml(fx.store, { target: { kind: "node", node: "component:nope#default.n1" }, operation: "delete" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("still refuses a ref-bearing set_attr attribute name, same as a screen", async () => {
    await expect(
      patchHtml(fx.store, {
        target: { kind: "node", node: "component:card#default.foot" },
        operation: "set_attr",
        attr: { name: "style", value: "color:red" },
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("returns the missing_id warning for a node with no explicit id in source (AC2)", async () => {
    await fx.store.writePattern("no-ids", `<div id="root"><span>hi</span></div>`);
    // <span> has no explicit id -> allocator-generated "n1".
    const res = await patchHtml(fx.store, {
      target: { kind: "node", node: "pattern:no-ids.n1" },
      operation: "set_attr",
      attr: { name: "data-x", value: "1" },
    });
    expect(res.warnings).toContainEqual({
      kind: "missing_id",
      target: "pattern:no-ids.n1",
      message: expect.stringContaining("no explicit id"),
      suggestion: expect.stringContaining("id="),
    });
  });

  it("does not warn when the touched node has an explicit id (AC2)", async () => {
    const res = await patchHtml(fx.store, {
      target: { kind: "node", node: "component:card#default.foot" },
      operation: "set_attr",
      attr: { name: "data-x", value: "1" },
    });
    expect(res.warnings).toEqual([]);
  });
});

describe("update_refs — component/pattern definitions (ADR-004 §2)", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    const tokens = await fx.store.readTokens();
    tokens.color = { primary: "#000", secondary: "#111" };
    await fx.store.writeTokens(tokens);
    await fx.store.writeComponent("btn-primary", `<button id="root">Go</button>`);
    await fx.store.writePattern("card", `<div id="root" style="color: $color.primary"><button id="cta">Buy</button></div>`);
  });
  afterEach(() => fx.cleanup());

  it("sets a component_ref on a plain node, class-based syntax by default (AC1)", async () => {
    const res = await updateRefs(fx.store, { node: "pattern:card.cta", refs: { component_ref: "btn-primary" } });
    expect(res.applied_refs).toMatchObject({ component_ref: "btn-primary" });
    expect(await fx.store.readPattern("card")).toBe(
      `<div id="root" style="color: $color.primary"><button id="cta" class="$btn-primary">Buy</button></div>`,
    );
  });

  it("clears a component_ref expressed via data-component, byte-identical outside the change (AC1)", async () => {
    await fx.store.writePattern("card2", `<div id="root"><button id="cta" data-component="btn-primary">Buy</button></div>`);
    const res = await updateRefs(fx.store, { node: "pattern:card2.cta", refs: { component_ref: null } });
    expect(res.warnings).toEqual([]);
    expect(await fx.store.readPattern("card2")).toBe(`<div id="root"><button id="cta">Buy</button></div>`);
  });

  it("clears a component_ref expressed via class=\"$name\"", async () => {
    await fx.store.writePattern("card3", `<div id="root"><button id="cta" class="$btn-primary">Buy</button></div>`);
    const res = await updateRefs(fx.store, { node: "pattern:card3.cta", refs: { component_ref: null } });
    expect(res.warnings).toEqual([]);
    expect(await fx.store.readPattern("card3")).toBe(`<div id="root"><button id="cta">Buy</button></div>`);
  });

  it("sets a variant", async () => {
    await fx.store.writePattern("card4", `<div id="root"><button id="cta" class="$btn-primary"></button></div>`);
    await updateRefs(fx.store, { node: "pattern:card4.cta", refs: { variant: "hover" } });
    expect(await fx.store.readPattern("card4")).toBe(`<div id="root"><button id="cta" class="$btn-primary" data-variant="hover"></button></div>`);
  });

  it("sets a token_refs binding, byte-identical outside the change (AC1)", async () => {
    const res = await updateRefs(fx.store, { node: "pattern:card.root", refs: { token_refs: { color: "color.secondary" } } });
    expect(res.applied_refs).toMatchObject({ token_refs: { color: "color.secondary" } });
    expect(await fx.store.readPattern("card")).toBe(
      `<div id="root" style="color: $color.secondary"><button id="cta">Buy</button></div>`,
    );
  });

  it("removes a simple $ref token_refs binding, resolving it back to its literal value", async () => {
    const res = await updateRefs(fx.store, { node: "pattern:card.root", refs: { token_refs: { color: null } } });
    expect(res.warnings).toEqual([]);
    expect(await fx.store.readPattern("card")).toBe(`<div id="root" style="color: #000"><button id="cta">Buy</button></div>`);
  });

  it("removes a mixed literal+ref token_refs binding, resolving the ref within it, at parity with the screen path's resolveTokenRef", async () => {
    await fx.store.writePattern("mixed", `<div id="root" style="border: 1px solid $color.primary"></div>`);
    const res = await updateRefs(fx.store, { node: "pattern:mixed.root", refs: { token_refs: { border: null } } });
    expect(res.warnings).toEqual([]);
    // Before this fix: applied_refs reported success and the file was
    // byte-identical (a silent no-op) — the removal only ever recognized a
    // bare "$path" value, never a mixed one.
    expect(await fx.store.readPattern("mixed")).toBe(`<div id="root" style="border: 1px solid #000"></div>`);
  });

  it("removes a modifier-call token_refs binding, resolving it via the CSS Color 4 expression", async () => {
    await fx.store.writePattern("mod", `<div id="root" style="background: alpha($color.primary, 0.1)"></div>`);
    const res = await updateRefs(fx.store, { node: "pattern:mod.root", refs: { token_refs: { background: null } } });
    expect(res.warnings).toEqual([]);
    expect(await fx.store.readPattern("mod")).toBe(`<div id="root" style="background: color-mix(in srgb, #000 10%, transparent)"></div>`);
  });

  it("removing a token_refs binding on a property with no ref at all is a genuine no-op, matching the screen path", async () => {
    await fx.store.writePattern("literal", `<div id="root" style="color: red"></div>`);
    const res = await updateRefs(fx.store, { node: "pattern:literal.root", refs: { token_refs: { color: null } } });
    expect(res.warnings).toEqual([]);
    expect(await fx.store.readPattern("literal")).toBe(`<div id="root" style="color: red"></div>`);
  });

  it("warns (without blocking) on an unresolved component ref", async () => {
    const res = await updateRefs(fx.store, { node: "pattern:card.cta", refs: { component_ref: "nope" } });
    expect(res.warnings).toContainEqual({ kind: "unknown_ref", target: "pattern:card.cta", message: 'component "nope" is not in the design system' });
    expect(await fx.store.readPattern("card")).toContain('class="$nope"');
  });

  it("warns (without blocking) on an unresolved token ref", async () => {
    const res = await updateRefs(fx.store, { node: "pattern:card.root", refs: { token_refs: { color: "color.nope" } } });
    expect(res.warnings).toContainEqual({ kind: "unknown_ref", target: "pattern:card.root", message: '"$color.nope" does not resolve in the design system' });
  });

  it("returns the missing_id warning for a node with no explicit id in source (AC2)", async () => {
    await fx.store.writePattern("no-ids", `<div id="root"><span></span></div>`);
    const res = await updateRefs(fx.store, { node: "pattern:no-ids.n1", refs: { variant: "hover" } });
    expect(res.warnings).toContainEqual(expect.objectContaining({ kind: "missing_id", target: "pattern:no-ids.n1" }));
  });

  it("does not warn for an explicitly-ided node (AC2)", async () => {
    const res = await updateRefs(fx.store, { node: "pattern:card.cta", refs: { variant: "hover" } });
    expect(res.warnings).toEqual([]);
  });

  it("throws not_found for an unknown node id", async () => {
    await expect(updateRefs(fx.store, { node: "pattern:card.nope", refs: {} })).rejects.toMatchObject({ code: "not_found" });
  });

  it("throws not_found for an unknown pattern name", async () => {
    await expect(updateRefs(fx.store, { node: "pattern:nope.n1", refs: {} })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("set_tokens", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    const tokens = await fx.store.readTokens();
    tokens.color = { primary: "#000" };
    await fx.store.writeTokens(tokens);
    await fx.store.writeScreen("home", `<div id="n1" style="color: $color.primary"></div>`);
    await fx.store.writeScreen("about", `<div id="n1"></div>`);
  });
  afterEach(() => fx.cleanup());

  it("patch mode upserts a path without touching the rest of the bucket", async () => {
    await setTokens(fx.store, { tokens: { "color.secondary": "#111" }, mode: "patch" });
    const tokens = await fx.store.readTokens();
    expect(tokens.color).toEqual({ primary: "#000", secondary: "#111" });
  });

  it("replace mode replaces the whole touched bucket", async () => {
    await setTokens(fx.store, { tokens: { "color.secondary": "#111" }, mode: "replace" });
    const tokens = await fx.store.readTokens();
    expect(tokens.color).toEqual({ secondary: "#111" });
  });

  it("null deletes a path", async () => {
    await setTokens(fx.store, { tokens: { "color.primary": null }, mode: "patch" });
    const tokens = await fx.store.readTokens();
    expect(tokens.color).toEqual({});
  });

  it("reports propagation: which screens/nodes are bound to the changed token", async () => {
    const res = await setTokens(fx.store, { tokens: { "color.primary": "#222" }, mode: "patch" });
    expect(res.propagated_node_count).toBe(1);
    expect(res.affected_screens).toEqual(["home"]);
  });

  it("propagates into component and pattern definitions, not just screens", async () => {
    await fx.store.writeComponent("btn-primary", `<button id="btn" style="color: $color.primary">Go</button>`);
    await fx.store.writePattern("hero", `<div id="root" style="color: $color.primary"></div>`);

    const res = await setTokens(fx.store, { tokens: { "color.primary": "#222" }, mode: "patch" });

    // The pre-existing screen ref plus one component and one pattern ref.
    expect(res.propagated_node_count).toBe(3);
    expect(res.affected_screens).toEqual(["home"]);
    expect(res.affected_components).toEqual(["btn-primary"]);
    expect(res.affected_patterns).toEqual(["hero"]);
  });

  it("propagates to a class-based ref on a token path this same call just created", async () => {
    // "brandnew" doesn't exist in tokens.json yet — resolveClassRef
    // (model/parser.ts) can only classify class="$color.brandnew" as a
    // token-class ref once the path resolves, so a pre-write scan would
    // never see this ref at all.
    await fx.store.writeScreen("cls", `<div id="n1" class="$color.brandnew"></div>`);

    const res = await setTokens(fx.store, { tokens: { "color.brandnew": "#111" }, mode: "patch" });

    expect(res.propagated_node_count).toBe(1);
    expect(res.affected_screens).toEqual(["cls"]);
  });

  it("scans the project only once when nothing is deleted, not once per pre/post-write pass", async () => {
    const listScreensSpy = vi.spyOn(fx.store, "listScreens");
    await setTokens(fx.store, { tokens: { "color.secondary": "#111" }, mode: "patch" });
    expect(listScreensSpy).toHaveBeenCalledTimes(1);
  });

  it("scans the project twice when a path is actually deleted — once pre-write, once post-write", async () => {
    const listScreensSpy = vi.spyOn(fx.store, "listScreens");
    await setTokens(fx.store, { tokens: { "color.primary": null }, mode: "patch" });
    expect(listScreensSpy).toHaveBeenCalledTimes(2);
  });

  it("warns when deleting a token that is still referenced", async () => {
    const res = await setTokens(fx.store, { tokens: { "color.primary": null }, mode: "patch" });
    expect(res.warnings).toEqual([
      { kind: "unknown_ref", message: '"$color.primary" was deleted but is still referenced in: home' },
    ]);
  });

  it("does not warn when deleting a token with no remaining references", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`); // no longer references color.primary
    const res = await setTokens(fx.store, { tokens: { "color.primary": null }, mode: "patch" });
    expect(res.warnings).toEqual([]);
  });

  it("warns when deleting a token still referenced from inside a mixed literal/ref value", async () => {
    await fx.store.writeScreen("home", `<div id="n1" style="border: 1px solid $color.primary"></div>`);
    const res = await setTokens(fx.store, { tokens: { "color.primary": null }, mode: "patch" });
    expect(res.warnings).toEqual([
      { kind: "unknown_ref", message: '"$color.primary" was deleted but is still referenced in: home' },
    ]);
  });

  it("never echoes screen content back", async () => {
    const res = await setTokens(fx.store, { tokens: { "color.primary": "#222" }, mode: "patch" });
    expect(JSON.stringify(res)).not.toContain("html_aug");
  });

  it("accepts a nested object matching the on-disk tokens.json shape", async () => {
    await setTokens(fx.store, { tokens: { color: { secondary: "#111" } }, mode: "patch" });
    const tokens = await fx.store.readTokens();
    expect(tokens.color).toEqual({ primary: "#000", secondary: "#111" });
  });

  it("accepts mixed nested and dotted keys in the same call", async () => {
    await setTokens(fx.store, { tokens: { color: { secondary: "#111" }, "spacing.md": "16px" }, mode: "patch" });
    const tokens = await fx.store.readTokens();
    expect(tokens.color).toEqual({ primary: "#000", secondary: "#111" });
    expect(tokens.spacing).toEqual({ md: "16px" });
  });

  it("deletes a member via a nested null", async () => {
    const res = await setTokens(fx.store, { tokens: { color: { primary: null } }, mode: "patch" });
    const tokens = await fx.store.readTokens();
    expect(tokens.color).toEqual({});
    expect(res.warnings).toEqual([
      { kind: "unknown_ref", message: '"$color.primary" was deleted but is still referenced in: home' },
    ]);
  });

  it("replace mode with nested input still only wipes the touched bucket", async () => {
    await setTokens(fx.store, { tokens: { color: { secondary: "#111" } }, mode: "replace" });
    const tokens = await fx.store.readTokens();
    expect(tokens.color).toEqual({ secondary: "#111" });
  });

  it("names both accepted forms when a token path is genuinely malformed", async () => {
    await expect(setTokens(fx.store, { tokens: { color: "#000" }, mode: "patch" })).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining('"<bucket>.<member>"'),
    });
    await expect(setTokens(fx.store, { tokens: { color: "#000" }, mode: "patch" })).rejects.toMatchObject({
      message: expect.stringContaining("nested"),
    });
  });
});

describe("set_tokens — notes-app fixture", () => {
  let dir: string;
  let store: FsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-set-tokens-ds-"));
    await cp(join(process.cwd(), "src", "tools", "__fixtures__", "notes-app"), dir, { recursive: true });
    store = new FsStore(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("reports a non-empty affected_components for a token used only in a component definition", async () => {
    // $color.primary is used exclusively in design-system/components/btn-primary.html —
    // previously (screens-only scan) this reported propagated_node_count: 0.
    const res = await setTokens(store, { tokens: { "color.primary": "#4a6bff" }, mode: "patch" });
    expect(res.propagated_node_count).toBeGreaterThan(0);
    expect(res.affected_components).toEqual(["btn-primary"]);
  });
});

describe("set_flow", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<div id="n1"><button id="n2"></button></div>`);
  });
  afterEach(() => fx.cleanup());

  it("adds a flow edge to flows.json and writes it into the screen's data-flow-target attribute", async () => {
    const res = await setFlow(fx.store, { node: "home.n2", flow: { from: "home.n2", event: "tap", to: "checkout", to_kind: "screen" } });
    expect(res.applied_flow).toEqual({ from: "home.n2", event: "tap", to: "checkout", to_kind: "screen" });
    expect(await fx.store.readFlows()).toEqual([{ from: "home.n2", event: "tap", to: "checkout", to_kind: "screen" }]);
    expect(await fx.store.readScreen("home")).toContain('data-flow-target="checkout"');
  });

  it("removes an edge when flow is null", async () => {
    await setFlow(fx.store, { node: "home.n2", flow: { from: "home.n2", event: "tap", to: "checkout", to_kind: "screen" } });
    await setFlow(fx.store, { node: "home.n2", flow: null });
    expect(await fx.store.readFlows()).toEqual([]);
    expect(await fx.store.readScreen("home")).not.toContain("data-flow-target");
  });

  it("survives an unrelated later write to the same screen", async () => {
    await setFlow(fx.store, { node: "home.n2", flow: { from: "home.n2", event: "tap", to: "checkout", to_kind: "screen" } });

    // A later write_html to the same screen re-parses its HTML and resyncs
    // flows.json from it. Before the fix, set_flow's edge only ever lived in
    // flows.json (never in the HTML), so this resync would silently wipe it.
    await writeHtml(fx.store, {
      screen: "home",
      mode: "replace",
      html_aug: await fx.store.readScreen("home"),
    });

    expect(await fx.store.readFlows()).toEqual([{ from: "home.n2", event: "tap", to: "checkout", to_kind: "screen" }]);
  });

  it("throws not_found when the trigger node's screen doesn't exist", async () => {
    await expect(setFlow(fx.store, { node: "nope.n1", flow: null })).rejects.toMatchObject({ code: "not_found" });
  });

  it("throws not_found when the trigger node doesn't exist in an existing screen", async () => {
    await expect(setFlow(fx.store, { node: "home.n999", flow: null })).rejects.toMatchObject({ code: "not_found" });
  });
});
