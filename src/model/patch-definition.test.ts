import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { patchDefinitionNode, type PatchDefinitionResult } from "./patch-definition.js";
import { loadRegistry } from "./registry.js";
import type { DesignSystemRegistry } from "./registry.js";
import { loadAllDocuments } from "../tools/definitions.js";
import { setupProject, type ProjectFixture } from "../tools/test-fixtures.js";

const EMPTY_REGISTRY: DesignSystemRegistry = {
  componentNames: new Set(),
  tokenPaths: new Set(),
  tokenFlatNames: new Set(),
};

function found(result: PatchDefinitionResult): string {
  if (!result.found) throw new Error("expected node to be found");
  return result.html;
}

// A hand-formatted definition file with multiple top-level default elements
// (AC1's "multiple top-level elements") and multiple <template data-variant>
// siblings (AC1's "multiple ... siblings"). Every test below patches exactly
// one node and asserts everything else stays byte-for-byte identical.
const MULTI_ROOT_DEFINITION =
  `<section id="hero" style="padding: 4px">\n  <h1 id="title">Hello</h1>\n</section>\n` +
  `<footer id="foot">Bye</footer>\n` +
  `<template data-variant="hover">\n  <section id="hero-hover"><span id="lbl">Hi</span></section>\n</template>\n` +
  `<template data-variant="disabled">\n  <section id="hero-disabled" data-existing="y"></section>\n</template>\n`;

describe("patchDefinitionNode — byte-for-byte preservation (AC1)", () => {
  it("delete: removes exactly the target element's byte range", () => {
    const html = found(patchDefinitionNode(MULTI_ROOT_DEFINITION, EMPTY_REGISTRY, "foot", { op: "delete" }, "default"));
    expect(html).toBe(MULTI_ROOT_DEFINITION.replace(`<footer id="foot">Bye</footer>`, ""));
  });

  it("replace: swaps exactly the target element's byte range", () => {
    const html = found(
      patchDefinitionNode(MULTI_ROOT_DEFINITION, EMPTY_REGISTRY, "title", { op: "replace", html: `<h2 id="title">Hi</h2>` }, "default"),
    );
    expect(html).toBe(MULTI_ROOT_DEFINITION.replace(`<h1 id="title">Hello</h1>`, `<h2 id="title">Hi</h2>`));
  });

  it("insert_before: inserts immediately before the target element, nothing else shifts", () => {
    const html = found(
      patchDefinitionNode(MULTI_ROOT_DEFINITION, EMPTY_REGISTRY, "lbl", { op: "insert_before", html: `<b>!</b>` }, "hover"),
    );
    expect(html).toBe(MULTI_ROOT_DEFINITION.replace(`<span id="lbl">`, `<b>!</b><span id="lbl">`));
  });

  it("insert_after: inserts immediately after the target element, nothing else shifts", () => {
    const html = found(
      patchDefinitionNode(MULTI_ROOT_DEFINITION, EMPTY_REGISTRY, "lbl", { op: "insert_after", html: `<b>!</b>` }, "hover"),
    );
    expect(html).toBe(MULTI_ROOT_DEFINITION.replace(`<span id="lbl">Hi</span>`, `<span id="lbl">Hi</span><b>!</b>`));
  });

  it("set_attr: adds a new attribute right before the start tag's closing '>'", () => {
    const html = found(
      patchDefinitionNode(MULTI_ROOT_DEFINITION, EMPTY_REGISTRY, "foot", { op: "set_attr", name: "data-x", value: "1" }, "default"),
    );
    expect(html).toBe(MULTI_ROOT_DEFINITION.replace(`<footer id="foot">`, `<footer id="foot" data-x="1">`));
  });

  it("set_attr: replaces an existing attribute's value in place", () => {
    const html = found(
      patchDefinitionNode(
        MULTI_ROOT_DEFINITION,
        EMPTY_REGISTRY,
        "hero-disabled",
        { op: "set_attr", name: "data-existing", value: "z" },
        "disabled",
      ),
    );
    expect(html).toBe(MULTI_ROOT_DEFINITION.replace(`data-existing="y"`, `data-existing="z"`));
  });

  it("set_attr: removes an existing attribute, including one adjacent leading space", () => {
    const html = found(
      patchDefinitionNode(MULTI_ROOT_DEFINITION, EMPTY_REGISTRY, "hero-disabled", { op: "set_attr", name: "data-existing", value: null }, "disabled"),
    );
    expect(html).toBe(MULTI_ROOT_DEFINITION.replace(` data-existing="y"`, ""));
  });

  it("set_attr: escapes a value containing a double quote", () => {
    const html = found(
      patchDefinitionNode(MULTI_ROOT_DEFINITION, EMPTY_REGISTRY, "foot", { op: "set_attr", name: "title", value: 'say "hi"' }, "default"),
    );
    expect(html).toContain(`title="say &quot;hi&quot;"`);
  });

  it("touches only the addressed variant — the same node id in a different variant is untouched", () => {
    // "hero" only exists in the default variant; asking for it in "hover"
    // must not find the hover section (a different id, "hero-hover").
    const result = patchDefinitionNode(MULTI_ROOT_DEFINITION, EMPTY_REGISTRY, "hero", { op: "delete" }, "hover");
    expect(result.found).toBe(false);
  });

  it("returns found: false for an id that doesn't exist in the given variant", () => {
    const result = patchDefinitionNode(MULTI_ROOT_DEFINITION, EMPTY_REGISTRY, "does-not-exist", { op: "delete" }, "default");
    expect(result).toEqual({ found: false });
  });

  it("returns found: false for a variant that doesn't exist at all", () => {
    const result = patchDefinitionNode(MULTI_ROOT_DEFINITION, EMPTY_REGISTRY, "hero", { op: "delete" }, "no-such-variant");
    expect(result).toEqual({ found: false });
  });
});

describe("patchDefinitionNode — pattern files (no variant scoping)", () => {
  const PATTERN = `<div id="root" style="display: flex">\n  <section id="card1"></section>\n  <section id="card2"></section>\n</div>`;

  it("locates a node when variant is omitted, scoping to the whole file", () => {
    const html = found(patchDefinitionNode(PATTERN, EMPTY_REGISTRY, "card1", { op: "delete" }));
    expect(html).toBe(PATTERN.replace(`<section id="card1"></section>`, ""));
  });
});

describe("patchDefinitionNode — id parity with loadAllDocuments (AC2, AC3)", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("locates the exact node a find_nodes/get_node match against the unmodified file described, including an allocator-generated id (AC2, AC3)", async () => {
    // Root button has no explicit id in the hover variant -> allocator-generated (n1).
    const html =
      `<button id="root"><span id="label">Go</span></button>\n` +
      `<template data-variant="hover"><button><span>Go</span></button></template>`;
    await fx.store.writeComponent("btn", html);

    const registry = await loadRegistry(fx.store);
    const { docs } = await loadAllDocuments(fx.store, registry);
    const hover = docs.find((d) => d.address === "component:btn#hover")!;
    const rootId = hover.doc.rootNodeId;
    const rootNode = hover.doc.nodes[rootId]!;
    expect(rootNode.tag).toBe("button");
    // Confirms this id really is allocator-generated, not an explicit one.
    expect(rootId).toBe("n1");

    const result = patchDefinitionNode(html, registry, rootId, { op: "set_attr", name: "data-marker", value: "x" }, "hover");
    expect(result).toEqual({
      found: true,
      html: html.replace(
        `<template data-variant="hover"><button>`,
        `<template data-variant="hover"><button data-marker="x">`,
      ),
    });
  });

  it("locates a node inside a pattern the same way find_nodes addresses it", async () => {
    const html = `<div id="root"><section id="card1"></section><section id="card2"></section></div>`;
    await fx.store.writePattern("grid", html);

    const registry = await loadRegistry(fx.store);
    const { docs } = await loadAllDocuments(fx.store, registry);
    const pattern = docs.find((d) => d.address === "pattern:grid")!;
    expect(pattern.doc.nodes["card2"]).toBeDefined();

    const result = patchDefinitionNode(html, registry, "card2", { op: "delete" });
    expect(found(result)).toBe(html.replace(`<section id="card2"></section>`, ""));
  });

  it("a component instance's children never consume an id, matching buildElement's slot-override handling", async () => {
    await fx.store.writeComponent("btn-primary", `<button id="root">Go</button>`);
    // The definition below composes btn-primary; its children (the "Click"
    // text) become slot content and must not shift the ids of elements
    // after it in document order, the same way buildElement never recurses
    // into a component instance's children for id allocation.
    const html = `<div id="wrap"><button class="$btn-primary">Click</button><span id="after">tail</span></div>`;
    await fx.store.writePattern("uses-btn", html);

    const registry = await loadRegistry(fx.store);
    const { docs } = await loadAllDocuments(fx.store, registry);
    const pattern = docs.find((d) => d.address === "pattern:uses-btn")!;
    // The component instance itself gets an id (n1); "after" keeps its
    // explicit id regardless.
    const instanceId = pattern.doc.nodes["wrap"]!.childIds[0]!;
    expect(pattern.doc.nodes[instanceId]!.kind).toBe("component_instance");
    expect(pattern.doc.nodes["after"]).toBeDefined();

    const result = patchDefinitionNode(html, registry, instanceId, { op: "set_attr", name: "data-marker", value: "x" });
    expect(found(result)).toBe(html.replace(`<button class="$btn-primary">`, `<button class="$btn-primary" data-marker="x">`));
  });

  // An earlier version's id-recursion decision had
  // no SVG-context guard, so a data-component/$class element found *inside*
  // <svg> was wrongly treated as opaque (a component instance never
  // recurses into its children for id allocation) — inside SVG, buildElement
  // ignores data-component/$class entirely and DOES recurse. That silently
  // shifted every id allocated after the SVG subtree.
  it("recurses into an SVG subtree's children even when they carry data-component/$class (AC2 regression)", async () => {
    const html =
      `<svg id="icon" viewBox="0 0 24 24"><g data-component="btn" id="g1"><rect id="r1"/></g></svg>\n` +
      `<p>after</p>`;
    await fx.store.writePattern("icon-pattern", html);

    const registry = await loadRegistry(fx.store);
    const { docs } = await loadAllDocuments(fx.store, registry);
    const pattern = docs.find((d) => d.address === "pattern:icon-pattern")!;
    // The canonical model gives r1 a real id and treats it as an ordinary
    // svg_path node, never a component instance — data-component is inert
    // inside <svg>.
    expect(pattern.doc.nodes["r1"]).toBeDefined();
    expect(pattern.doc.nodes["r1"]!.kind).toBe("svg_path");

    const result = patchDefinitionNode(html, registry, "r1", { op: "set_attr", name: "data-marker", value: "x" });
    expect(found(result)).toBe(html.replace(`<rect id="r1"/>`, `<rect id="r1" data-marker="x"/>`));
  });
});

// ---------------------------------------------------------------------------
// Structural parity guard: every node id loadAllDocuments
// reports for a source must be locatable by patchDefinitionNode, and the
// located element must be the *same* element — not a future example, a
// standing invariant checked against a table of deliberately awkward
// fixtures. A future divergence between classifyElement's two callers
// (buildElement, patch-definition's assignIds) fails this loudly regardless
// of which specific case it is.
// ---------------------------------------------------------------------------

type ParityFixture = { label: string; kind: "component" | "pattern"; name: string; html: string };

const PARITY_FIXTURES: ParityFixture[] = [
  {
    label: "SVG containing a data-component/$class element, nested more than one level deep",
    kind: "pattern",
    name: "icon",
    html:
      `<svg id="icon" viewBox="0 0 24 24">\n` +
      `  <g data-component="btn" id="g1">\n` +
      `    <rect id="r1"/>\n` +
      `    <g id="g2"><circle id="c1"/></g>\n` +
      `  </g>\n` +
      `</svg>\n` +
      `<p id="after">after</p>`,
  },
  {
    label: "a component instance with children (must stay opaque) followed by an auto-generated sibling",
    kind: "pattern",
    name: "uses-btn",
    html: `<div id="wrap">\n  <button class="$btn-primary"><span>Text</span><b>bold</b></button>\n  <p>tail</p>\n</div>`,
  },
  {
    label: "multiple top-level elements plus multiple <template data-variant> siblings",
    kind: "component",
    name: "multi-root",
    html: MULTI_ROOT_DEFINITION,
  },
  {
    label: "explicit id / data-node-id / both / auto-generated ids, with text and comments interleaved, plus a void element",
    kind: "pattern",
    name: "mixed-ids",
    html:
      `<div id="root">\n` +
      `  <img id="pic" src="x.png">\n` +
      `  Some text\n` +
      `  <!-- a comment -->\n` +
      `  <span id="a">A</span>\n` +
      `  <span data-node-id="b">B</span>\n` +
      `  <span id="c" data-node-id="c-alt">C</span>\n` +
      `  <!-- another comment -->\n` +
      `  more text\n` +
      `  <span>D</span>\n` +
      `  <br>\n` +
      `  <span>E</span>\n` +
      `</div>`,
  },
];

/**
 * For every node id `loadAllDocuments` reports for `name`, confirms
 * `patchDefinitionNode` locates it and that a marker attribute lands on
 * exactly that node (and nowhere else) when re-parsed — "the same element",
 * not merely "found: true". Restores the original file between each id so
 * every check starts from the untouched fixture.
 */
async function assertEveryNodeIsLocatable(fx: ProjectFixture, fixture: ParityFixture): Promise<void> {
  const write = fixture.kind === "component" ? fx.store.writeComponent.bind(fx.store) : fx.store.writePattern.bind(fx.store);
  await write(fixture.name, fixture.html);

  const registry = await loadRegistry(fx.store);
  const sources = (await loadAllDocuments(fx.store, registry)).docs.filter((d) => d.kind === fixture.kind && d.name === fixture.name);
  expect(sources.length, `expected at least one source for ${fixture.label}`).toBeGreaterThan(0);

  for (const source of sources) {
    for (const [id, node] of Object.entries(source.doc.nodes)) {
      if (node.kind === "text") continue; // patch-definition only locates elements (AC's own scope)
      const marker = `loc-${id}`;

      const result = patchDefinitionNode(fixture.html, registry, id, { op: "set_attr", name: "data-loc-test", value: marker }, source.variant);
      expect(result.found, `[${fixture.label}] expected to locate ${source.address}.${id}`).toBe(true);
      if (!result.found) continue;

      await write(fixture.name, result.html);
      const reparsedSource = (await loadAllDocuments(fx.store, registry)).docs.find((d) => d.address === source.address)!;
      const marked = Object.values(reparsedSource.doc.nodes).filter((n) => n.attributes["data-loc-test"] === marker);
      expect(marked, `[${fixture.label}] expected exactly one node marked for ${source.address}.${id}`).toHaveLength(1);
      expect(marked[0]!.id, `[${fixture.label}] marker landed on the wrong node id for ${source.address}.${id}`).toBe(id);
      expect(marked[0]!.tag).toBe(node.tag);

      await write(fixture.name, fixture.html); // restore before the next node id
    }
  }
}

describe("patchDefinitionNode — structural parity with loadAllDocuments", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeComponent("btn-primary", `<button id="root">Go</button>`);
  });
  afterEach(() => fx.cleanup());

  for (const fixture of PARITY_FIXTURES) {
    it(fixture.label, () => assertEveryNodeIsLocatable(fx, fixture));
  }
});
