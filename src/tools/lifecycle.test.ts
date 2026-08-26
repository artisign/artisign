import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { initProjectTool, importHtml, promoteToSystem, deleteEntity } from "./lifecycle.js";
import { updateRefs, writeHtml } from "./writes.js";
import { getDesignSystem, listComments } from "./reads.js";
import { buildRenderContext } from "./render-context.js";
import { parseScreen, renderScreen, loadRegistry } from "../model/index.js";
import { FsStore } from "../store/index.js";
import { ToolError, type Warning } from "./types.js";

const execFileAsync = promisify(execFile);

describe("init_project", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-init-tool-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("scaffolds an empty project", async () => {
    const res = await initProjectTool({ dir, seed: { kind: "empty" } });
    expect(res.screens).toEqual([]);
    expect(res.files_created).toContain("artisign.json");
  });

  it("seeds a screen from html_aug", async () => {
    const res = await initProjectTool({
      dir,
      seed: { kind: "html", html_aug: `<div id="n1">Hi</div>`, screen: "welcome" },
    });
    expect(res.screens).toEqual(["welcome"]);
    const store = new FsStore(dir);
    expect(await store.readScreen("welcome")).toContain("Hi");
  });

  it("honors a custom project name", async () => {
    await initProjectTool({ dir, name: "My Project", seed: { kind: "empty" } });
    const store = new FsStore(dir);
    expect((await store.readArtisignConfig()).name).toBe("My Project");
  });

  it("registers the new project via ctx.openProject when a context is given", async () => {
    const opened: string[] = [];
    await initProjectTool({ dir, seed: { kind: "empty" } }, { openProject: async (d) => opened.push(d) });
    expect(opened).toEqual([dir]);
  });

  it("scaffolds without a registry hookup when no context is given (stdio server, unchanged behavior)", async () => {
    const res = await initProjectTool({ dir, seed: { kind: "empty" } }, undefined);
    expect(res.root).toBe(dir);
  });
});

describe("import_html", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("imports a new screen", async () => {
    const res = await importHtml(fx.store, { source: { kind: "html", html_aug: `<div id="n1">A</div>`, screen: "a" } });
    expect(res.imported).toEqual([{ screen: "a", path: "screens/a.html" }]);
    expect(res.skipped_duplicate_count).toBe(0);
  });

  it("dedupes identical content by hash", async () => {
    await importHtml(fx.store, { source: { kind: "html", html_aug: `<div id="n1">A</div>`, screen: "a" } });
    const res = await importHtml(fx.store, { source: { kind: "html", html_aug: `<div id="n1">A</div>`, screen: "b" } });
    expect(res.skipped_duplicate_count).toBe(1);
    expect(res.imported).toEqual([]);
    expect(await fx.store.listScreens()).toEqual(["a"]);
  });

  it("dedupes semantically identical content that differs only in raw formatting", async () => {
    await importHtml(fx.store, { source: { kind: "html", html_aug: `<div id="n1">A</div>`, screen: "a" } });
    // Same content, but with extra whitespace and different attribute
    // ordering — canonicalizes to byte-identical output, but would never
    // match if compared as raw strings.
    const res = await importHtml(fx.store, {
      source: { kind: "html", html_aug: `<div  id="n1" >A</div>`, screen: "b" },
    });
    expect(res.skipped_duplicate_count).toBe(1);
    expect(await fx.store.listScreens()).toEqual(["a"]);
  });

  it("imports distinct content even with dedupe on", async () => {
    await importHtml(fx.store, { source: { kind: "html", html_aug: `<div id="n1">A</div>`, screen: "a" } });
    const res = await importHtml(fx.store, { source: { kind: "html", html_aug: `<div id="n1">B</div>`, screen: "b" } });
    expect(res.skipped_duplicate_count).toBe(0);
    expect(res.imported).toEqual([{ screen: "b", path: "screens/b.html" }]);
  });

  it("dedupe: false always imports", async () => {
    await importHtml(fx.store, { source: { kind: "html", html_aug: `<div id="n1">A</div>`, screen: "a" } });
    const res = await importHtml(fx.store, { source: { kind: "html", html_aug: `<div id="n1">A</div>`, screen: "a2" }, dedupe: false });
    expect(res.imported).toEqual([{ screen: "a2", path: "screens/a2.html" }]);
  });
});

describe("promote_to_system", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("kind=token lifts an inline value and rewrites the source node", async () => {
    await fx.store.writeScreen("home", `<div id="n1" style="color: #3366ff"></div>`);
    const res = await promoteToSystem(fx.store, { node: "home.n1", kind: "token", name: "color.brand" });

    expect(res.entity).toEqual({ kind: "token", name: "$color.brand", path: "design-system/tokens.json" });
    const tokens = await fx.store.readTokens();
    expect(tokens.color).toEqual({ brand: "#3366ff" });
    expect(await fx.store.readScreen("home")).toContain("$color.brand");
    expect(await fx.store.readScreen("home")).not.toContain("#3366ff");
  });

  // promote writes the definition file through store.writeComponent
  // directly, bypassing writeDefinition — so it could silently produce
  // exactly the definition write_html warns about via the slot-styling check.
  it("warns when the promoted node carries a styled data-slot descendant, the same way write_html does", async () => {
    await fx.store.writeScreen("home", `<div id="card"><h3 id="t" data-slot="title" style="font-weight: 700">Title</h3></div>`);
    const res = await promoteToSystem(fx.store, { node: "home.card", kind: "component", name: "card" });

    expect(res.warnings).toContainEqual({
      kind: "suspicious_attr",
      target: "card#default",
      message: 'slot "title" carries its own style/class/component ref, which an instance filling this slot discards',
      suggestion:
        "style a wrapper around the slot instead — and keep instances naming their slots (data-slot=...), because a wrapper directly under the definition root is itself a positional slot",
    });
  });

  it("warns per variant when promoting with extra variants, and stays silent without a styled slot", async () => {
    await fx.store.writeScreen("home", `<div id="card"><h3 id="t" data-slot="title" style="font-weight: 700">T</h3></div>`);
    const res = await promoteToSystem(fx.store, { node: "home.card", kind: "component", name: "card", variants: ["default", "hover"] });
    expect((res.warnings as Warning[]).map((w) => w.target).sort()).toEqual(["card#default", "card#hover"]);

    await fx.store.writeScreen("plain", `<div id="box"><h3 id="t" data-slot="title">T</h3></div>`);
    const clean = await promoteToSystem(fx.store, { node: "plain.box", kind: "component", name: "box" });
    expect(clean.warnings).toEqual([]);
  });

  // promote wrote the definition file directly, so a repeated variant
  // name produced two <template data-variant> blocks — the exact shape
  // write_html rejects with validation_failed.
  it("rejects a repeated variant name the way write_html does, without writing anything", async () => {
    await fx.store.writeScreen("home", `<div id="card"><h3 id="t">T</h3></div>`);

    await expect(
      promoteToSystem(fx.store, { node: "home.card", kind: "component", name: "card", variants: ["hover", "hover"] }),
    ).rejects.toMatchObject({ code: "validation_failed", message: 'duplicate variant name "hover"' });

    expect(await fx.store.listComponents()).not.toContain("card");
    expect(await fx.store.readScreen("home")).not.toContain("$card");
  });

  // The check runs on the file about to be written, not on the input list —
  // variant names are interpolated into the markup unescaped, so a name
  // carrying a quote can manufacture a duplicate the raw list never shows.
  it("rejects a variant name whose markup injection manufactures a duplicate", async () => {
    await fx.store.writeScreen("home", `<div id="card"><h3 id="t">T</h3></div>`);

    await expect(
      promoteToSystem(fx.store, {
        node: "home.card",
        kind: "component",
        name: "card",
        variants: [`a"></template><template data-variant="default`],
      }),
    ).rejects.toMatchObject({ code: "validation_failed", message: 'duplicate variant name "default"' });

    expect(await fx.store.listComponents()).not.toContain("card");
  });

  // Parity with write_html: both entries are filtered out against the implicit
  // default, so the written file has exactly one default variant — a file
  // write_html accepts.
  it("accepts a repeated \"default\" entry, which collapses onto the implicit default variant", async () => {
    await fx.store.writeScreen("home", `<div id="card"><h3 id="t">T</h3></div>`);
    await promoteToSystem(fx.store, { node: "home.card", kind: "component", name: "card", variants: ["default", "default"] });

    expect(await fx.store.readComponent("card")).not.toContain("data-variant");
  });

  it("kind=pattern is not warned about — a pattern is never expanded into an instance", async () => {
    await fx.store.writeScreen("home", `<div id="card"><h3 id="t" data-slot="title" style="font-weight: 700">T</h3></div>`);
    const res = await promoteToSystem(fx.store, { node: "home.card", kind: "pattern", name: "card-layout" });
    expect(res.warnings).toEqual([]);
  });

  it("kind=token rewrites matching inline values project-wide", async () => {
    await fx.store.writeScreen("home", `<div id="n1" style="color: #3366ff"></div>`);
    await fx.store.writeScreen("about", `<div id="n1" style="color: #3366ff"></div>`);
    const res = await promoteToSystem(fx.store, { node: "home.n1", kind: "token", name: "color.brand" });

    expect(res.rewritten_count).toBe(2);
    expect((res.affected_screens as string[]).sort()).toEqual(["about", "home"]);
    expect(await fx.store.readScreen("about")).toContain("$color.brand");
  });

  it("preserves an existing class=\"$<same-path>\" ref elsewhere in a screen it re-serializes", async () => {
    // "brand" doesn't exist as a token yet — a pre-write scan would parse
    // class="$color.brand" as unresolved (resolveClassRef, model/parser.ts)
    // and drop it from the element's class list entirely while
    // re-serializing this same screen for the promoted inline value.
    await fx.store.writeScreen(
      "p",
      `<div id="n1" style="color: #3366ff"><span id="n2" class="$color.brand">x</span></div>`,
    );

    await promoteToSystem(fx.store, { node: "p.n1", kind: "token", name: "color.brand" });

    const html = await fx.store.readScreen("p");
    expect(html).toContain('class="$color.brand"');
  });

  it("kind=token rewrites matching inline values inside component and pattern definitions", async () => {
    await fx.store.writeComponent(
      "btn-primary",
      `<button id="btn" style="color: #3366ff">Go</button>\n` +
        `<template data-variant="hover"><button id="btn" style="color: #3366ff">Go</button></template>`,
    );
    await fx.store.writePattern("hero", `<div id="root" style="color: #3366ff"></div>`);
    await fx.store.writeScreen("home", `<div id="n1" style="color: #3366ff"></div>`);

    const res = await promoteToSystem(fx.store, { node: "home.n1", kind: "token", name: "color.brand" });

    expect((res.affected_components as string[]).sort()).toEqual(["btn-primary"]);
    expect((res.affected_patterns as string[]).sort()).toEqual(["hero"]);
    expect((res.rewritten_nodes as string[]).sort()).toEqual([
      "component:btn-primary#default.btn",
      "component:btn-primary#hover.btn",
      "home.n1",
      "pattern:hero.root",
    ]);

    const componentHtml = await fx.store.readComponent("btn-primary");
    expect(componentHtml).toContain("$color.brand");
    expect(componentHtml).not.toContain("#3366ff");
    // Both variants survived the rewrite — not just the matched one.
    expect(componentHtml).toContain('data-variant="hover"');

    const patternHtml = await fx.store.readPattern("hero");
    expect(patternHtml).toContain("$color.brand");
    expect(patternHtml).not.toContain("#3366ff");
  });

  it("detects and rewrites a literal style value that lives only inside a component instance's slot-override content", async () => {
    await fx.store.writeComponent("child-comp", `<span data-slot="label">Default</span>`);
    // The literal sits on <em>, a *child* of the $child-comp instance — its
    // content becomes slot-override content, invisible to a plain
    // Object.values(doc.nodes) scan.
    await fx.store.writePattern(
      "hero",
      `<div id="root"><span id="inst" class="$child-comp"><em style="color: #3366ff">Slotted</em></span></div>`,
    );
    await fx.store.writeScreen("home", `<div id="n1" style="color: #3366ff"></div>`);

    const res = await promoteToSystem(fx.store, { node: "home.n1", kind: "token", name: "color.brand" });

    expect(res.affected_patterns).toEqual(["hero"]);
    const patternHtml = await fx.store.readPattern("hero");
    expect(patternHtml).toContain("$color.brand");
    expect(patternHtml).not.toContain("#3366ff");
  });

  it("detects and rewrites a literal style value that lives only inside a screen's own slot-override content", async () => {
    await fx.store.writeComponent("child-comp", `<span data-slot="label">Default</span>`);
    // "other"'s only occurrence of the literal is on <em>, a child of the
    // $child-comp instance — slot-override content, invisible to a plain
    // Object.values(doc.nodes) scan. Mirrors the pattern-level test above;
    // before this fix, a pattern with identical markup got rewritten while
    // an otherwise-identical screen kept the inline value.
    await fx.store.writeScreen(
      "other",
      `<div id="root"><span id="inst" class="$child-comp"><em style="color: #3366ff">Slotted</em></span></div>`,
    );
    await fx.store.writeScreen("home", `<div id="n1" style="color: #3366ff"></div>`);

    const res = await promoteToSystem(fx.store, { node: "home.n1", kind: "token", name: "color.brand" });

    expect((res.affected_screens as string[]).sort()).toEqual(["home", "other"]);
    const html = await fx.store.readScreen("other");
    expect(html).toContain("$color.brand");
    expect(html).not.toContain("#3366ff");
  });

  it("preserves a definition file with more than one top-level element", async () => {
    await fx.store.writePattern(
      "hero",
      `<section id="s" style="color: #3366ff"><h1>A</h1></section>\n<footer id="f">B</footer>`,
    );
    await fx.store.writeScreen("home", `<div id="n1" style="color: #3366ff"></div>`);

    await promoteToSystem(fx.store, { node: "home.n1", kind: "token", name: "color.brand" });

    const patternHtml = await fx.store.readPattern("hero");
    expect(patternHtml).toContain(`<footer id="f">B</footer>`);
    expect(patternHtml).toContain("$color.brand");
  });

  it("does not normalize a hand-formatted component file when rewriting a matching value", async () => {
    const original =
      `<button style="color: #3366ff">\n  <span>Go</span>\n</button>\n` +
      `<template data-variant="hover">\n  <button style="color: #3366ff; box-shadow: 0 1px 2px #000">\n    <span>Go</span>\n  </button>\n</template>`;
    await fx.store.writeComponent("btn-primary", original);
    await fx.store.writeScreen("home", `<div id="n1" style="color: #3366ff"></div>`);

    await promoteToSystem(fx.store, { node: "home.n1", kind: "token", name: "color.brand" });

    const rewritten = await fx.store.readComponent("btn-primary");
    expect(rewritten).toBe(original.replaceAll("color: #3366ff", "color: $color.brand"));
    // No ids were generated into a file that had none.
    expect(rewritten).not.toMatch(/id="n\d+"/);
  });

  it("rewrites a literal containing HTML-escaped characters", async () => {
    await fx.store.writeScreen(
      "landing",
      `<h1 id="h" style="font-family: &quot;Inter&quot;, sans-serif">Title</h1>`,
    );
    const before = await fx.store.readScreen("landing");
    expect(before).toContain("&quot;Inter&quot;");

    const res = await promoteToSystem(fx.store, { node: "landing.h", kind: "token", name: "typography.heading" });

    expect(res.affected_screens).toEqual(["landing"]);
    const after = await fx.store.readScreen("landing");
    expect(after).not.toBe(before);
    expect(after).toContain("$typography.heading");
    expect(after).not.toContain("Inter");
  });

  it("does not rewrite a literal that only appears inside escaped example text", async () => {
    const original = `<button style="color: #3366ff">Go</button>\n<code>&lt;p style="color: #3366ff"&gt;</code>`;
    await fx.store.writeComponent("btn-primary", original);
    await fx.store.writeScreen("home", `<div id="n1" style="color: #3366ff"></div>`);

    await promoteToSystem(fx.store, { node: "home.n1", kind: "token", name: "color.brand" });

    const rewritten = await fx.store.readComponent("btn-primary");
    expect(rewritten).toContain(`<code>&lt;p style="color: #3366ff"&gt;</code>`);
    expect(rewritten).toContain("color: $color.brand");
  });

  it("rewrites a literal containing HTML-escaped characters inside a component definition, not just a screen", async () => {
    await fx.store.writeComponent(
      "heading",
      `<h1 style="font-family: &quot;Inter&quot;, sans-serif">Title</h1>`,
    );
    await fx.store.writeScreen(
      "landing",
      `<h1 id="h" style="font-family: &quot;Inter&quot;, sans-serif">Title</h1>`,
    );

    const res = await promoteToSystem(fx.store, { node: "landing.h", kind: "token", name: "typography.heading" });

    expect(res.affected_components).toEqual(["heading"]);
    const rewritten = await fx.store.readComponent("heading");
    expect(rewritten).toBe(`<h1 style="font-family: $typography.heading">Title</h1>`);
  });

  it("leaves commented-out example markup untouched next to a real matching occurrence", async () => {
    const original = `<button style="padding: 8px">Go</button>\n<!-- <button style="padding: 8px"> -->`;
    await fx.store.writeComponent("btn-primary", original);
    await fx.store.writeScreen("home", `<div id="n1" style="padding: 8px"></div>`);

    await promoteToSystem(fx.store, { node: "home.n1", kind: "token", name: "spacing.sm" });

    const rewritten = await fx.store.readComponent("btn-primary");
    expect(rewritten).toBe(original.replace('style="padding: 8px">Go', 'style="padding: $spacing.sm">Go'));
    expect(rewritten).toContain(`<!-- <button style="padding: 8px"> -->`);
  });

  it("kind=component creates a component file and converts the node to a component_instance", async () => {
    await fx.store.writeScreen("home", `<div id="n1"><button id="n2">Go</button></div>`);
    const res = await promoteToSystem(fx.store, { node: "home.n2", kind: "component", name: "btn-primary" });

    expect(res.entity).toEqual({ kind: "component", name: "btn-primary", path: "design-system/components/btn-primary.html" });
    expect(await fx.store.listComponents()).toEqual(["btn-primary"]);
    expect(await fx.store.readComponent("btn-primary")).toContain("Go");
    const html = await fx.store.readScreen("home");
    expect(html).toContain('class="$btn-primary"');
  });

  it("kind=component preserves inline styles of slot content", async () => {
    await fx.store.writeScreen(
      "home",
      `<div id="n1"><button id="n2"><span id="n3" style="color: #ff0000">Go</span></button></div>`,
    );
    await promoteToSystem(fx.store, { node: "home.n2", kind: "component", name: "btn-primary" });

    expect(await fx.store.readComponent("btn-primary")).toContain("color: #ff0000");
  });

  it("kind=component does not leak the screen's node ids into the component file", async () => {
    await fx.store.writeScreen("home", `<div id="n1"><button id="n2"><span id="n3">Go</span></button></div>`);
    await promoteToSystem(fx.store, { node: "home.n2", kind: "component", name: "btn-primary" });

    const componentHtml = await fx.store.readComponent("btn-primary");
    expect(componentHtml).not.toContain("n2");
    expect(componentHtml).not.toContain("n3");
  });

  it("kind=component rewrites every structurally identical occurrence project-wide", async () => {
    const button = `<button id="n2" style="color: $color.primary">Go</button>`;
    await fx.store.writeScreen("home", `<div id="n1">${button}</div>`);
    await fx.store.writeScreen("checkout", `<div id="n1">${button}</div>`);
    await fx.store.writeScreen("about", `<div id="n1"><button id="n2">Different label</button></div>`);

    const res = await promoteToSystem(fx.store, { node: "home.n2", kind: "component", name: "btn-primary" });

    expect(res.rewritten_count).toBe(2);
    expect((res.affected_screens as string[]).sort()).toEqual(["checkout", "home"]);
    expect((res.rewritten_nodes as string[]).sort()).toEqual(["checkout.n2", "home.n2"]);

    expect(await fx.store.readScreen("home")).toContain('class="$btn-primary"');
    expect(await fx.store.readScreen("checkout")).toContain('class="$btn-primary"');
    // A structurally different node with the same tag/id is left alone.
    expect(await fx.store.readScreen("about")).not.toContain("$btn-primary");
    expect(await fx.store.readScreen("about")).toContain("Different label");
  });

  it("kind=component does not touch a structurally different node with the same tag", async () => {
    await fx.store.writeScreen("home", `<div id="n1"><button id="n2">Go</button><button id="n3">Cancel</button></div>`);
    const res = await promoteToSystem(fx.store, { node: "home.n2", kind: "component", name: "btn-primary" });

    expect(res.rewritten_count).toBe(1);
    expect(await fx.store.readScreen("home")).toContain("Cancel");
    const html = await fx.store.readScreen("home");
    expect(html.match(/\$btn-primary/g)).toHaveLength(1);
  });

  it("kind=component is readable via get_design_system right after promotion", async () => {
    await fx.store.writeScreen("home", `<div id="n1"><button id="n2">Go</button></div>`);
    await promoteToSystem(fx.store, { node: "home.n2", kind: "component", name: "btn-primary" });

    const ds = await getDesignSystem(fx.store, { view: "tree" });
    const components = ds.components as Array<{ name: string; variants: string[] }>;
    expect(components).toEqual([{ name: "btn-primary", file: "design-system/components/btn-primary.html", variants: ["default"] }]);
  });

  it("substitutes each instance's own content into a promoted component's slots (acceptance bug #1)", async () => {
    await fx.store.writeScreen("home", `<div id="root"><section id="card1"><p id="p1">Card One</p></section></div>`);
    await promoteToSystem(fx.store, { node: "home.card1", kind: "component", name: "activity-card" });

    // Two more instances of the newly-promoted component, each with its own
    // distinct content — mirrors an agent authoring several cards after the
    // first one seeded the design-system definition.
    await fx.store.writeScreen(
      "home",
      `<div id="root">` +
        `<section id="card1" class="$activity-card"><p id="p1">Card One</p></section>` +
        `<section id="card2" class="$activity-card"><p id="p2">Card Two</p></section>` +
        `<section id="card3" class="$activity-card"><p id="p3">Card Three</p></section>` +
        `</div>`,
    );

    const registry = await loadRegistry(fx.store);
    const html = await fx.store.readScreen("home");
    const { doc } = parseScreen(html, "home", registry);
    const ctx = await buildRenderContext(fx.store);
    const rendered = renderScreen(doc, ctx);

    expect(rendered).toContain("Card One");
    expect(rendered).toContain("Card Two");
    expect(rendered).toContain("Card Three");
  });

  it("a promoted component's non-default variants also get real slots, not just the default (acceptance bug #1)", async () => {
    await fx.store.writeScreen("home", `<div id="root"><section id="card1"><p id="p1">Card One</p></section></div>`);
    await promoteToSystem(fx.store, { node: "home.card1", kind: "component", name: "activity-card", variants: ["hover"] });

    await fx.store.writeScreen(
      "home",
      `<div id="root">` +
        `<section id="card1" class="$activity-card" data-variant="hover"><p id="p1">Card One</p></section>` +
        `<section id="card2" class="$activity-card" data-variant="hover"><p id="p2">Card Two</p></section>` +
        `</div>`,
    );

    const registry = await loadRegistry(fx.store);
    const html = await fx.store.readScreen("home");
    const { doc } = parseScreen(html, "home", registry);
    const ctx = await buildRenderContext(fx.store);
    const rendered = renderScreen(doc, ctx);

    expect(rendered).toContain("Card One");
    expect(rendered).toContain("Card Two");
  });

  it("preserves a nested component instance's slot content when writing the promoted definition", async () => {
    await fx.store.writeComponent("child-comp", `<span data-slot="label">Default</span>`);
    await fx.store.writeScreen(
      "home",
      `<div id="n1"><section id="n2"><span id="n3" class="$child-comp">ALPHA</span></section></div>`,
    );

    await promoteToSystem(fx.store, { node: "home.n2", kind: "component", name: "wrapper" });

    const wrapperHtml = await fx.store.readComponent("wrapper");
    expect(wrapperHtml).toContain("ALPHA");
    expect(wrapperHtml).toContain('class="$child-comp"');
  });

  it("does not treat two occurrences with differing nested-instance slot content as structurally equal", async () => {
    await fx.store.writeComponent("child-comp", `<span data-slot="label">Default</span>`);
    await fx.store.writeScreen(
      "home",
      `<div id="n1"><section id="n2"><span id="n3" class="$child-comp">ALPHA</span></section></div>`,
    );
    await fx.store.writeScreen(
      "checkout",
      `<div id="n1"><section id="n2"><span id="n3" class="$child-comp">BETA</span></section></div>`,
    );

    const res = await promoteToSystem(fx.store, { node: "home.n2", kind: "component", name: "wrapper" });

    expect(res.rewritten_count).toBe(1);
    expect(await fx.store.readScreen("checkout")).toContain("BETA");
    expect(await fx.store.readScreen("checkout")).not.toContain("$wrapper");
  });

  it("kind=pattern creates a pattern file without touching the source screen", async () => {
    await fx.store.writeScreen("home", `<div id="n1"><section id="n2"><p id="n3">Card</p></section></div>`);
    const before = await fx.store.readScreen("home");
    const res = await promoteToSystem(fx.store, { node: "home.n2", kind: "pattern", name: "card" });

    expect(res.entity).toEqual({ kind: "pattern", name: "card", path: "design-system/patterns/card.html" });
    expect(await fx.store.readPattern("card")).toContain("Card");
    expect(await fx.store.readScreen("home")).toBe(before);
    expect(res.rewritten_count).toBe(0);
  });

  it("kind=pattern is readable via get_design_system right after promotion", async () => {
    await fx.store.writeScreen("home", `<div id="n1"><section id="n2"><p id="n3">Card</p></section></div>`);
    await promoteToSystem(fx.store, { node: "home.n2", kind: "pattern", name: "card" });

    const ds = await getDesignSystem(fx.store, { view: "full" });
    const patternDefs = ds.pattern_definitions as Array<{ name: string; html_aug: string }>;
    expect(patternDefs).toHaveLength(1);
    expect(patternDefs[0]).toMatchObject({ name: "card" });
    expect(patternDefs[0]!.html_aug).toContain("Card");
  });

  it("throws not_found for a missing node", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    await expect(promoteToSystem(fx.store, { node: "home.n999", kind: "pattern", name: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("throws invalid_state when a token promotion has no inline style to lift", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    await expect(promoteToSystem(fx.store, { node: "home.n1", kind: "token", name: "color.brand" })).rejects.toThrow(ToolError);
  });
});

describe("delete_entity", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("refuses to delete a component still referenced by a screen, listing the referencing nodes", async () => {
    await fx.store.writeComponent("btn-primary", `<button id="btn">Go</button>`);
    await fx.store.writeScreen("home", `<div id="n1"><button id="n2" class="$btn-primary">Go</button></div>`);
    await fx.store.writeScreen("about", `<div id="n1"><button id="n2" class="$btn-primary">Go</button></div>`);

    await expect(deleteEntity(fx.store, { kind: "component", name: "btn-primary" })).rejects.toMatchObject({ code: "conflict" });
    try {
      await deleteEntity(fx.store, { kind: "component", name: "btn-primary" });
    } catch (err) {
      expect((err as Error).message).toContain("about.n2");
      expect((err as Error).message).toContain("home.n2");
    }
    expect(await fx.store.listComponents()).toEqual(["btn-primary"]);
  });

  it("refuses to delete a component still referenced only by another component's definition", async () => {
    await fx.store.writeComponent("btn-primary", `<button id="btn">Go</button>`);
    await fx.store.writeComponent("wrapper", `<div id="w1"><button id="w2" class="$btn-primary">Go</button></div>`);

    await expect(deleteEntity(fx.store, { kind: "component", name: "btn-primary" })).rejects.toMatchObject({ code: "conflict" });
    try {
      await deleteEntity(fx.store, { kind: "component", name: "btn-primary" });
    } catch (err) {
      expect((err as Error).message).toContain("component:wrapper#default.w2");
    }
    expect(await fx.store.listComponents()).toEqual(["btn-primary", "wrapper"]);
  });

  it("deletes a component even when its own file has a duplicate variant name", async () => {
    await fx.store.writeComponent(
      "btn-primary",
      `<button id="btn">Go</button>\n<template><button id="btn2">Go</button></template>`,
    );

    const res = await deleteEntity(fx.store, { kind: "component", name: "btn-primary" });

    expect(res.kind).toBe("component");
    expect(await fx.store.listComponents()).toEqual([]);
  });

  it("refuses to delete a component while a different, unrelated component's file is broken and can't be checked for references", async () => {
    await fx.store.writeComponent("btn-primary", `<button id="btn">Go</button>`);
    await fx.store.writeComponent(
      "broken",
      `<button id="btn">Go</button>\n<template><button id="btn2">Go</button></template>`,
    );

    // Fail closed: "I can't rule out a reference inside broken.html" is not
    // a reason to proceed with a destructive delete, even though broken.html
    // has nothing to do with btn-primary.
    await expect(deleteEntity(fx.store, { kind: "component", name: "btn-primary" })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("design-system/components/broken.html"),
    });
    expect((await fx.store.listComponents()).sort()).toEqual(["broken", "btn-primary"]);
  });

  it("refuses to delete a component still referenced only by a pattern definition", async () => {
    await fx.store.writeComponent("btn-primary", `<button id="btn">Go</button>`);
    await fx.store.writePattern("hero", `<div id="p1"><button id="p2" class="$btn-primary">Go</button></div>`);

    await expect(deleteEntity(fx.store, { kind: "component", name: "btn-primary" })).rejects.toMatchObject({ code: "conflict" });
    try {
      await deleteEntity(fx.store, { kind: "component", name: "btn-primary" });
    } catch (err) {
      expect((err as Error).message).toContain("pattern:hero.p2");
    }
    expect(await fx.store.listComponents()).toEqual(["btn-primary"]);
  });

  it("refuses to delete a component referenced only from a multi-rooted pattern", async () => {
    await fx.store.writeComponent("btn-primary", `<button id="btn">Go</button>`);
    // A pattern's default markup has no single-root requirement — this one
    // has two top-level elements, and the reference sits in the second.
    await fx.store.writePattern(
      "hero",
      `<div id="a"></div>\n<div id="b"><button id="c" class="$btn-primary">Go</button></div>`,
    );

    await expect(deleteEntity(fx.store, { kind: "component", name: "btn-primary" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await fx.store.listComponents()).toEqual(["btn-primary"]);
  });

  it("deletes a component once every referencing node has its ref cleared", async () => {
    await fx.store.writeComponent("btn-primary", `<button id="btn">Go</button>`);
    await fx.store.writeScreen("home", `<div id="n1"><button id="n2" class="$btn-primary">Go</button></div>`);

    await updateRefs(fx.store, { node: "home.n2", refs: { component_ref: null } });
    const res = await deleteEntity(fx.store, { kind: "component", name: "btn-primary" });

    expect(res).toMatchObject({ kind: "component", name: "btn-primary", path: "design-system/components/btn-primary.html" });
    expect(await fx.store.listComponents()).toEqual([]);
  });

  it("deletes a pattern", async () => {
    await fx.store.writePattern("card", `<div id="n1">Card</div>`);
    const res = await deleteEntity(fx.store, { kind: "pattern", name: "card" });
    expect(res).toMatchObject({ kind: "pattern", name: "card", path: "design-system/patterns/card.html" });
    expect(await fx.store.listPatterns()).toEqual([]);
  });

  it("deletes a screen, removing its HTML and meta sidecar", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    await fx.store.writeScreenMeta("home", { notes: "wip", tags: ["a"] });

    const res = await deleteEntity(fx.store, { kind: "screen", name: "home" });

    expect(res).toMatchObject({ kind: "screen", name: "home", path: "screens/home.html" });
    expect(await fx.store.listScreens()).toEqual([]);
    expect(await fx.store.readScreenMeta("home")).toEqual({ notes: "", tags: [] });
  });

  it("drops outgoing flow edges on screen delete, keeps incoming ones with a dangling_flow warning, and reports removed_flow_count", async () => {
    await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "Home",
      html_aug: `<div id="n1"><button id="n2" data-flow-target="checkout">Go</button></div>`,
    });
    await writeHtml(fx.store, {
      screen: "checkout",
      mode: "create",
      title: "Checkout",
      html_aug: `<div id="n1"><button id="n2" data-flow-target="home">Back</button></div>`,
    });

    const res = await deleteEntity(fx.store, { kind: "screen", name: "home" });

    expect(res.removed_flow_count).toBe(1);
    expect(res.warnings).toEqual([
      { kind: "dangling_flow", target: "checkout.n2", message: 'flow from "checkout.n2" still targets deleted screen "home"' },
    ]);
    const flows = await fx.store.readFlows();
    expect(flows).toEqual([{ from: "checkout.n2", event: "tap", to: "home", to_kind: "screen" }]);
  });

  it("keeps comments untouched on screen delete (append-only history)", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    await fx.store.appendComment(
      JSON.stringify({ id: "c1", parent_id: null, screen: "home", node_id: "home.n1", author: "human", text: "hi", resolved: false, ts: new Date().toISOString() }),
    );

    await deleteEntity(fx.store, { kind: "screen", name: "home" });

    const res = await listComments(fx.store, { status: "any" });
    expect(res.comments).toHaveLength(1);
  });

  it("throws not_found for a missing screen, component, or pattern", async () => {
    await expect(deleteEntity(fx.store, { kind: "screen", name: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteEntity(fx.store, { kind: "component", name: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteEntity(fx.store, { kind: "pattern", name: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("commits with a delete_entity message naming the kind and target", async () => {
    const config = await fx.store.readArtisignConfig();
    config.settings.autoCommit = true;
    await fx.store.writeArtisignConfig(config);

    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    const res = await deleteEntity(fx.store, { kind: "screen", name: "home" });
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);

    const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: fx.dir });
    expect(stdout.trim()).toBe("delete_entity: screen:home");
  });

  it("dispatches kind:\"mockup\" to the mockup deletion path (full create/replace/delete coverage lives in mockups.test.ts)", async () => {
    await fx.store.writeMockupMeta("hero-options", { variants: [{ id: "a", title: "A", description: "" }] });
    await fx.store.writeMockupVariant("hero-options", "a", "<div>A</div>");

    const res = await deleteEntity(fx.store, { kind: "mockup", name: "hero-options" });
    expect(res).toMatchObject({ kind: "mockup", name: "hero-options" });
    expect(await fx.store.listMockups()).toEqual([]);
  });
});
