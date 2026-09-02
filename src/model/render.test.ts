import { describe, it, expect } from "vitest";
import { parseScreen } from "./parser.js";
import { parseComponentDefinition } from "./component.js";
import { renderScreen, type RenderContext } from "./render.js";
import type { DesignSystemRegistry } from "./registry.js";
import type { TokensDocument } from "../store/index.js";

const tokens: TokensDocument = {
  color: { primary: "#3366ff", "on-primary": "#ffffff" },
  space: { md: "16px" },
};

function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
  const registry: DesignSystemRegistry = {
    componentNames: new Set(["btn-primary"]),
    tokenPaths: new Set(["color.primary", "color.on-primary", "space.md"]),
    tokenFlatNames: new Set(["primary", "on-primary", "md"]),
  };
  const btnDef = parseComponentDefinition(
    "btn-primary",
    `<button style="color: $color.on-primary"><span data-slot="icon"></span><span data-slot="label">Default label</span></button>`,
  );
  const componentDefs = new Map([["btn-primary", btnDef]]);
  return { tokens, registry, componentDefs, ...overrides };
}

describe("renderScreen — token resolution", () => {
  it("resolves a plain token ref to its concrete value", () => {
    const { doc } = parseScreen(`<div id="n1" style="color: $color.primary; padding: $space.md"></div>`, "s", makeContext().registry);
    const html = renderScreen(doc, makeContext());
    expect(html).toBe(`<div id="n1" style="color: #3366ff; padding: 16px"></div>`);
  });

  it("leaves a literal inline style value untouched", () => {
    const { doc } = parseScreen(`<div id="n1" style="color: #000000"></div>`, "s", makeContext().registry);
    expect(renderScreen(doc, makeContext())).toBe(`<div id="n1" style="color: #000000"></div>`);
  });

  it("marks an unresolved token path without crashing", () => {
    const { doc } = parseScreen(`<div id="n1" style="color: $color.primary"></div>`, "s", makeContext().registry);
    const ctx = makeContext({ tokens: { color: {} } });
    expect(renderScreen(doc, ctx)).toContain("/* unresolved: $color.primary */");
  });

  it("emits data-unresolved-token on the affected element so the baseline CSS can target it", () => {
    const { doc } = parseScreen(`<div id="n1" style="color: $color.primary"></div>`, "s", makeContext().registry);
    const ctx = makeContext({ tokens: { color: {} } });
    expect(renderScreen(doc, ctx)).toContain('data-unresolved-token="color.primary"');
  });

  it("comma-joins multiple unresolved token paths on the same element", () => {
    const { doc } = parseScreen(
      `<div id="n1" style="color: $color.primary; padding: $space.md"></div>`,
      "s",
      makeContext().registry,
    );
    const ctx = makeContext({ tokens: {} });
    expect(renderScreen(doc, ctx)).toContain('data-unresolved-token="color.primary,space.md"');
  });

  it("resolves a mixed literal/ref value to concrete CSS", () => {
    const { doc } = parseScreen(`<div id="n1" style="border: 1px solid $color.primary"></div>`, "s", makeContext().registry);
    const html = renderScreen(doc, makeContext());
    expect(html).toBe(`<div id="n1" style="border: 1px solid #3366ff"></div>`);
  });

  it("resolves two refs in one mixed value independently", () => {
    const { doc } = parseScreen(`<div id="n1" style="padding: $space.md $space.md"></div>`, "s", makeContext().registry);
    const html = renderScreen(doc, makeContext());
    expect(html).toBe(`<div id="n1" style="padding: 16px 16px"></div>`);
  });

  it("substitutes the unresolved marker in place inside a mixed value, without breaking the rest of it", () => {
    const { doc } = parseScreen(`<div id="n1" style="border: 1px solid $color.primary"></div>`, "s", makeContext().registry);
    const ctx = makeContext({ tokens: { color: {} } });
    const html = renderScreen(doc, ctx);
    expect(html).toBe(
      `<div id="n1" style="border: 1px solid /* unresolved: $color.primary */" data-unresolved-token="color.primary"></div>`,
    );
  });
});

describe("renderScreen — modifier functions", () => {
  it("resolves alpha() to color-mix()", () => {
    const { doc } = parseScreen(`<div id="n1" style="color: alpha($color.primary, 0.1)"></div>`, "s", makeContext().registry);
    expect(renderScreen(doc, makeContext())).toBe(`<div id="n1" style="color: color-mix(in srgb, #3366ff 10%, transparent)"></div>`);
  });

  it("resolves oklab() to a relative-color expression", () => {
    const { doc } = parseScreen(`<div id="n1" style="background: oklab($color.primary)"></div>`, "s", makeContext().registry);
    expect(renderScreen(doc, makeContext())).toBe(`<div id="n1" style="background: oklab(from #3366ff l a b)"></div>`);
  });
});

describe("renderScreen — SVG refs", () => {
  it("resolves fill/stroke to concrete values, keeps literal values as-is", () => {
    const registry = makeContext().registry;
    const { doc } = parseScreen(
      `<svg id="n1"><path id="n2" d="M0 0" fill="$color.primary" stroke="none"/></svg>`,
      "s",
      registry,
    );
    expect(renderScreen(doc, makeContext())).toBe(
      `<svg id="n1"><path id="n2" fill="#3366ff" d="M0 0" stroke="none"></path></svg>`,
    );
  });
});

describe("renderScreen — ids and flows preserved", () => {
  it("keeps node ids and data-flow-target/-trigger in the output", () => {
    const registry = makeContext().registry;
    const { doc } = parseScreen(
      `<div id="n1"><button id="n2" data-flow-target="checkout" data-flow-trigger="longpress">Go</button></div>`,
      "s",
      registry,
    );
    const html = renderScreen(doc, makeContext());
    expect(html).toContain('id="n2"');
    expect(html).toContain('data-flow-target="checkout"');
    expect(html).toContain('data-flow-trigger="longpress"');
  });
});

describe("renderScreen — component expansion", () => {
  it("expands a component instance into its default variant with slots filled", () => {
    const ctx = makeContext();
    const { doc } = parseScreen(
      `<div id="n1"><button id="n2" class="$btn-primary"><span id="n3" data-slot="label">Get started</span></button></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);

    expect(html).toContain('id="n2"'); // instance root keeps its own id
    expect(html).toContain('style="color: #ffffff"'); // component's own token ref resolved
    expect(html).toContain("Get started"); // slot override content
    expect(html).not.toContain("Default label"); // template default replaced, not appended
    expect(html).toContain('data-variant="default"');
  });

  it("selects a named variant and namespaces descendant template ids per instance", () => {
    const hoverDef = parseComponentDefinition(
      "btn-primary",
      `<button style="color: $color.on-primary"><span data-slot="label">Default</span></button>\n<template data-variant="hover"><button id="root"><em id="deco">!</em><span data-slot="label">Default</span></button></template>`,
    );
    const ctx = makeContext({ componentDefs: new Map([["btn-primary", hoverDef]]) });
    const { doc } = parseScreen(
      `<div id="n1"><button id="n2" class="$btn-primary" data-variant="hover"></button></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);

    expect(html).toContain('data-variant="hover"');
    expect(html).toContain('id="n2--deco"'); // namespaced, not the template's raw "deco"
    expect(html).not.toContain('id="deco"');
  });

  it("does not crash on a component ref that no longer resolves", () => {
    const ctx = makeContext({ componentDefs: new Map() });
    const { doc } = parseScreen(`<div id="n1"><button id="n2" class="$btn-primary"></button></div>`, "s", ctx.registry);
    expect(() => renderScreen(doc, ctx)).not.toThrow();
    expect(renderScreen(doc, ctx)).toContain("data-unresolved-component");
  });

  it("gives two instances of the same component distinct descendant ids", () => {
    const def = parseComponentDefinition("btn-primary", `<button><i id="icon"></i></button>`);
    const ctx = makeContext({ componentDefs: new Map([["btn-primary", def]]) });
    const { doc } = parseScreen(
      `<div id="n1"><button id="a" class="$btn-primary"></button><button id="b" class="$btn-primary"></button></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);
    expect(html).toContain('id="a--icon"');
    expect(html).toContain('id="b--icon"');
  });
});

describe("renderScreen — nested component instances", () => {
  it("namespaces a nested instance root under its outer instance, recursively, across two nesting levels", () => {
    const registry: DesignSystemRegistry = {
      componentNames: new Set(["comp-a", "comp-b", "comp-c"]),
      tokenPaths: new Set(),
      tokenFlatNames: new Set(),
    };
    const componentDefs = new Map([
      ["comp-c", parseComponentDefinition("comp-c", `<i id="c-root"><b id="icon"></b></i>`)],
      ["comp-b", parseComponentDefinition("comp-b", `<button id="btn-root"><span id="c-inst" class="$comp-c"></span></button>`)],
      ["comp-a", parseComponentDefinition("comp-a", `<div id="a-root"><span id="b-inst" class="$comp-b"></span></div>`)],
    ]);
    const ctx: RenderContext = { tokens: {}, registry, componentDefs };
    const { doc } = parseScreen(
      `<div id="n1"><section id="x1" class="$comp-a"></section><section id="x2" class="$comp-a"></section></div>`,
      "s",
      registry,
    );
    const html = renderScreen(doc, ctx);

    // outer instance roots keep their own id, unnamespaced
    expect(html).toContain('id="x1"');
    expect(html).toContain('id="x2"');
    // nested instance roots (comp-b, comp-c) are namespaced under the full
    // chain of enclosing instance ids, recursively — not the template's own
    // raw id, which would collide across the x1/x2 sibling expansions
    expect(html).toContain('id="x1--b-inst"');
    expect(html).toContain('id="x2--b-inst"');
    expect(html).toContain('id="x1--b-inst--c-inst"');
    expect(html).toContain('id="x2--b-inst--c-inst"');
    // a plain element nested inside the innermost instance's template is
    // namespaced under that instance's already-namespaced id
    expect(html).toContain('id="x1--b-inst--c-inst--icon"');
    expect(html).toContain('id="x2--b-inst--c-inst--icon"');

    // the un-namespaced, colliding forms must not appear at all
    expect(html).not.toContain('id="b-inst"');
    expect(html).not.toContain('id="c-inst"');
    expect(html).not.toContain('id="icon"');
    expect(html).not.toContain('id="btn-root"');
    expect(html).not.toContain('id="a-root"');
    expect(html).not.toContain('id="c-root"');

    const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("renderScreen — data-component instance syntax", () => {
  it("expands a data-component instance with data-slot overrides into its variant template, same as class=\"$name\"", () => {
    const ctx = makeContext();
    const { doc } = parseScreen(
      `<div id="n1"><button id="n2" data-component="btn-primary"><span id="n3" data-slot="label">Get started</span></button></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);

    expect(html).toContain('id="n2"');
    expect(html).toContain('style="color: #ffffff"');
    expect(html).toContain("Get started");
    expect(html).not.toContain("Default label");
    expect(html).toContain('data-variant="default"');
    expect(html).not.toContain("data-component=");
  });
});

describe("renderScreen — slot substitution", () => {
  it("fills a single template slot positionally when the screen doesn't name data-slot itself", () => {
    // This is the *normal* authoring path: collectSlotOverrides (parser)
    // assigns positional keys ("slot-0") when the screen's child carries no
    // explicit data-slot — those must still match up against the
    // template's named placeholder, not just literal key equality.
    const def = parseComponentDefinition("btn-primary", `<button><span data-slot="label">Default label</span></button>`);
    const ctx = makeContext({ componentDefs: new Map([["btn-primary", def]]) });
    const { doc } = parseScreen(
      `<div id="n1"><button id="n2" class="$btn-primary"><span id="n3">Get started</span></button></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);
    expect(html).toContain("Get started");
    expect(html).not.toContain("Default label");
  });

  it("zips multiple positional overrides onto multiple template slots in document order", () => {
    const def = parseComponentDefinition(
      "btn-primary",
      `<button><span data-slot="icon">i</span><span data-slot="label">Default label</span></button>`,
    );
    const ctx = makeContext({ componentDefs: new Map([["btn-primary", def]]) });
    const { doc } = parseScreen(
      `<div id="n1"><button id="n2" class="$btn-primary"><em id="n3">★</em><span id="n4">Get started</span></button></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);
    expect(html).toContain("★");
    expect(html).toContain("Get started");
    expect(html).not.toContain("Default label");
  });

  it("prefers an exact data-slot name match over positional order", () => {
    const def = parseComponentDefinition(
      "btn-primary",
      `<button><span data-slot="icon">i</span><span data-slot="label">Default label</span></button>`,
    );
    const ctx = makeContext({ componentDefs: new Map([["btn-primary", def]]) });
    // Explicit data-slot="label" on the screen's child, appearing FIRST —
    // positional order alone would zip it to "icon"; the name match must win.
    const { doc } = parseScreen(
      `<div id="n1"><button id="n2" class="$btn-primary"><span id="n3" data-slot="label">Get started</span></button></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);
    expect(html).toContain("Get started");
    expect(html).not.toContain("Default label");
  });

  it("replaces the placeholder element entirely instead of nesting the override inside it", () => {
    const def = parseComponentDefinition("btn-primary", `<button><span data-slot="label">Default label</span></button>`);
    const ctx = makeContext({ componentDefs: new Map([["btn-primary", def]]) });
    const { doc } = parseScreen(
      `<div id="n1"><button id="n2" class="$btn-primary"><strong id="n3">Bold</strong></button></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);
    // The fill keeps its authored id (CHR-581) and replaces the placeholder whole.
    expect(html).toContain('<strong id="n3">Bold</strong>');
    expect(html).not.toMatch(/<span[^>]*><strong/); // not nested inside the placeholder's own <span>
  });

  it("substitutes per-instance text into a template whose only slot is a bare text child (acceptance review blocker)", () => {
    // A promoted <button>Click me</button> — text nodes can't carry a
    // data-slot attribute at all, so this must resolve purely positionally.
    const def = parseComponentDefinition("btn-primary", `<button>Click me</button>`);
    const ctx = makeContext({ componentDefs: new Map([["btn-primary", def]]) });
    const { doc } = parseScreen(`<div id="n1"><button id="n2" class="$btn-primary">Save</button></div>`, "s", ctx.registry);
    const html = renderScreen(doc, ctx);
    expect(html).toContain("Save");
    expect(html).not.toContain("Click me");
  });

  it("aligns positional slot indices consistently for mixed text + element children (acceptance review blocker)", () => {
    const def = parseComponentDefinition("btn-primary", `<div>Label<span>S</span></div>`);
    const ctx = makeContext({ componentDefs: new Map([["btn-primary", def]]) });
    const { doc } = parseScreen(
      `<div id="n1"><div id="n2" class="$btn-primary">MYLABEL<span id="n3">X</span></div></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);
    expect(html).toContain("MYLABEL");
    expect(html).toContain(">X<");
    expect(html).not.toContain("Label"); // template's own literal text didn't leak through
    expect(html).not.toContain(">S<");
  });

  // The flip side of "replaces the placeholder entirely" — styling a
  // component author puts on the slot element itself never reaches the render.
  // Characterized here because the behaviour is deliberate (see the comment in
  // renderTemplateNode) and write_html now warns about it instead of changing it.
  // The recommended wrapper is safe only while
  // instances name their slots. A wrapper directly under the definition root
  // is itself positional slot-0, so an unnamed instance child replaces the
  // wrapper — styling and nested named slot together.
  it("replaces a root-level wrapper when the instance fills slots positionally, and spares it when they are named", () => {
    const def = parseComponentDefinition("card", `<div style="padding: 8px"><div style="font-weight: 700"><h3 data-slot="title">T</h3></div></div>`);
    const ctx = makeContext({ componentDefs: new Map([["card", def]]) });
    const registry = { ...ctx.registry, componentNames: new Set(["card"]) };

    const positional = parseScreen(`<div id="n1"><div id="n2" class="$card"><span id="n3">A</span></div></div>`, "s", registry);
    expect(renderScreen(positional.doc, { ...ctx, registry })).not.toContain("font-weight");

    const named = parseScreen(`<div id="n1"><div id="n2" class="$card"><span id="n3" data-slot="title">A</span></div></div>`, "s", registry);
    expect(renderScreen(named.doc, { ...ctx, registry })).toContain("font-weight: 700");
  });

  it("keeps a styled slot's own styling when no instance fills that slot", () => {
    const def = parseComponentDefinition("card", `<div><h3 data-slot="title" style="font-weight: 700">T</h3></div>`);
    const ctx = makeContext({ componentDefs: new Map([["card", def]]) });
    const registry = { ...ctx.registry, componentNames: new Set(["card"]) };
    const { doc } = parseScreen(`<div id="n1"><div id="n2" class="$card"></div></div>`, "s", registry);

    expect(renderScreen(doc, { ...ctx, registry })).toContain("font-weight: 700");
  });

  it("discards styling the definition puts on a substituted slot element", () => {
    const def = parseComponentDefinition(
      "card",
      `<div><h3 data-slot="title" style="font-weight: 700; font-size: 20px">Default title</h3></div>`,
    );
    const ctx = makeContext({ componentDefs: new Map([["card", def]]) });
    // "card" must be in componentNames or the instance never expands and the
    // assertion below passes without the definition ever being touched.
    const registry = { ...ctx.registry, componentNames: new Set(["card"]) };
    const { doc } = parseScreen(`<div id="n1"><div id="n2" class="$card"><span id="n3">Real title</span></div></div>`, "s", registry);
    const html = renderScreen(doc, { ...ctx, registry });
    expect(html).toContain("Real title");
    expect(html).toContain("data-variant"); // the instance really did expand
    expect(html).not.toContain("font-weight");
  });
});

describe("renderScreen — recursive component guard", () => {
  it("does not blow the stack when a component instantiates itself", () => {
    const registry: DesignSystemRegistry = {
      componentNames: new Set(["loopy"]),
      tokenPaths: new Set(),
      tokenFlatNames: new Set(),
    };
    const loopyDef = parseComponentDefinition("loopy", `<div class="$loopy"></div>`);
    const ctx: RenderContext = { tokens: {}, registry, componentDefs: new Map([["loopy", loopyDef]]) };
    const { doc } = parseScreen(`<div id="n1"><span id="n2" class="$loopy"></span></div>`, "s", registry);

    expect(() => renderScreen(doc, ctx)).not.toThrow();
    expect(renderScreen(doc, ctx)).toContain("data-recursive-component");
  });

  it("does not blow the stack on an indirect A -> B -> A cycle", () => {
    const registry: DesignSystemRegistry = {
      componentNames: new Set(["comp-a", "comp-b"]),
      tokenPaths: new Set(),
      tokenFlatNames: new Set(),
    };
    const componentDefs = new Map([
      ["comp-a", parseComponentDefinition("comp-a", `<div class="$comp-b"></div>`)],
      ["comp-b", parseComponentDefinition("comp-b", `<div class="$comp-a"></div>`)],
    ]);
    const ctx: RenderContext = { tokens: {}, registry, componentDefs };
    const { doc } = parseScreen(`<div id="n1"><span id="n2" class="$comp-a"></span></div>`, "s", registry);

    expect(() => renderScreen(doc, ctx)).not.toThrow();
  });
});

describe("renderScreen — instance attributes on an expanded component", () => {
  it("keeps a plain attribute authored on the instance", () => {
    const ctx = makeContext();
    const { doc } = parseScreen(
      `<div id="n1"><a id="n2" class="$btn-primary" href="/imprint"><span data-slot="label">Imprint</span></a></div>`,
      "s",
      ctx.registry,
    );
    // The href is the whole point of the element; dropping it renders a link to nowhere.
    expect(renderScreen(doc, ctx)).toContain('href="/imprint"');
  });

  it("keeps several instance attributes at once", () => {
    const ctx = makeContext();
    const { doc } = parseScreen(
      `<div id="n1"><a id="n2" class="$btn-primary" href="/x" aria-label="Go now" target="_blank"><span data-slot="label">Go</span></a></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);
    expect(html).toContain('href="/x"');
    expect(html).toContain('aria-label="Go now"');
    expect(html).toContain('target="_blank"');
  });

  it("appends the instance's own style after the component's, so the instance wins the inline cascade", () => {
    const ctx = makeContext();
    const { doc } = parseScreen(
      `<div id="n1"><button id="n2" class="$btn-primary" style="flex: 1"><span data-slot="label">Go</span></button></div>`,
      "s",
      ctx.registry,
    );
    expect(renderScreen(doc, ctx)).toContain('style="color: #ffffff; flex: 1"');
  });

  it("resolves a token ref used in the instance's own style", () => {
    const ctx = makeContext();
    const { doc } = parseScreen(
      `<div id="n1"><button id="n2" class="$btn-primary" style="margin-top: $space.md"><span data-slot="label">Go</span></button></div>`,
      "s",
      ctx.registry,
    );
    expect(renderScreen(doc, ctx)).toContain("margin-top: 16px");
  });

  it("marks an unresolved token used in the instance's own style", () => {
    const ctx = makeContext({ tokens: { color: { "on-primary": "#ffffff" } } });
    const { doc } = parseScreen(
      `<div id="n1"><button id="n2" class="$btn-primary" style="margin-top: $space.md"><span data-slot="label">Go</span></button></div>`,
      "s",
      makeContext().registry,
    );
    expect(renderScreen(doc, ctx)).toContain('data-unresolved-token="space.md"');
  });

  it("merges an extra class on the instance with the component's own", () => {
    const classDef = parseComponentDefinition(
      "btn-primary",
      `<button class="btn" style="color: $color.on-primary"><span data-slot="label">Default label</span></button>`,
    );
    const ctx = makeContext({ componentDefs: new Map([["btn-primary", classDef]]) });
    const { doc } = parseScreen(
      `<div id="n1"><button id="n2" class="$btn-primary wide"><span data-slot="label">Go</span></button></div>`,
      "s",
      ctx.registry,
    );
    expect(renderScreen(doc, ctx)).toContain('class="btn wide"');
  });

  it("never emits data-variant twice when the instance names a variant", () => {
    const hoverDef = parseComponentDefinition(
      "btn-primary",
      `<button style="color: $color.on-primary"><span data-slot="label">Default</span></button>\n<template data-variant="hover"><button><span data-slot="label">Default</span></button></template>`,
    );
    const ctx = makeContext({ componentDefs: new Map([["btn-primary", hoverDef]]) });
    const { doc } = parseScreen(
      `<div id="n1"><a id="n2" class="$btn-primary" data-variant="hover" href="/x"><span data-slot="label">Go</span></a></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);
    expect(html.match(/data-variant=/g)).toHaveLength(1);
    expect(html).toContain('data-variant="hover"');
    expect(html).toContain('href="/x"');
  });

  it("applies the instance's attributes to the expanded root only, not to descendants", () => {
    const ctx = makeContext();
    const { doc } = parseScreen(
      `<div id="n1"><a id="n2" class="$btn-primary" href="/x"><span data-slot="label">Go</span></a></div>`,
      "s",
      ctx.registry,
    );
    // One href in the whole document — the expansion's inner <span> must not inherit it.
    expect(renderScreen(doc, ctx).match(/href=/g)).toHaveLength(1);
  });

  // README "Screens are augmented HTML" example, verbatim: a component ref, a
  // variant, an instance-level style with a token ref, and a flow target on
  // one element. CHR-582 found the documented example did not render its
  // padding-inline at all; this keeps the README's own example executable.
  it("renders the README's canonical instance example with its own padding-inline, variant and flow intact", () => {
    const readmeTokens: TokensDocument = { spacing: { md: "16px" }, color: { "on-primary": "#ffffff" } };
    const registry: DesignSystemRegistry = {
      componentNames: new Set(["btn-primary"]),
      tokenPaths: new Set(["spacing.md", "color.on-primary"]),
      tokenFlatNames: new Set(["md", "on-primary"]),
    };
    const def = parseComponentDefinition(
      "btn-primary",
      `<button style="color: $color.on-primary; padding-inline: 8px">Default</button>\n<template data-variant="hover"><button style="color: $color.on-primary; padding-inline: 8px; opacity: 0.9">Default</button></template>`,
    );
    const ctx: RenderContext = { tokens: readmeTokens, registry, componentDefs: new Map([["btn-primary", def]]) };
    const { doc, errors } = parseScreen(
      `<div id="root"><button id="btn-login" class="$btn-primary" data-variant="hover"
        style="padding-inline: $spacing.md" data-flow-target="dashboard">
  Log in
</button></div>`,
      "s",
      registry,
    );
    expect(errors).toEqual([]);
    const html = renderScreen(doc, ctx);

    // The hover variant was expanded, and the instance's padding-inline comes
    // last so it wins the inline cascade over the definition's 8px.
    expect(html).toContain("opacity: 0.9");
    expect(html).toMatch(/style="[^"]*padding-inline: 8px[^"]*padding-inline: 16px"/);
    expect(html).toContain("Log in");
    expect(html.match(/data-variant=/g)).toHaveLength(1);
    expect(html).toContain('data-variant="hover"');
    expect(html.match(/data-flow-target=/g)).toHaveLength(1);
    expect(html).toContain('data-flow-target="dashboard"');
    expect(html).toContain('id="btn-login"');
    expect(html).not.toContain("$");
  });

  it("carries instance attributes on a component nested inside another component's template", () => {
    const cardDef = parseComponentDefinition("card", `<div style="padding: $space.md"><a id="cta" class="$btn-primary" href="/nested"><span data-slot="label">Go</span></a></div>`);
    const btnDef = parseComponentDefinition("btn-primary", `<a style="color: $color.on-primary"><span data-slot="label">Default</span></a>`);
    const ctx = makeContext({
      componentDefs: new Map([
        ["card", cardDef],
        ["btn-primary", btnDef],
      ]),
      registry: { ...makeContext().registry, componentNames: new Set(["card", "btn-primary"]) },
    });
    const { doc } = parseScreen(`<div id="n1"><div id="n2" class="$card"></div></div>`, "s", ctx.registry);
    expect(renderScreen(doc, ctx)).toContain('href="/nested"');
  });
});

describe("renderScreen — component robustness", () => {
  it("does not emit a duplicate data-variant attribute", () => {
    const def = parseComponentDefinition(
      "btn-primary",
      `<button>Default</button>\n<template data-variant="hover"><button data-variant="squished">Text</button></template>`,
    );
    const ctx = makeContext({ componentDefs: new Map([["btn-primary", def]]) });
    const { doc } = parseScreen(`<div id="n1"><button id="n2" class="$btn-primary" data-variant="hover"></button></div>`, "s", ctx.registry);
    const html = renderScreen(doc, ctx);
    expect(html.match(/data-variant=/g)).toHaveLength(1);
  });

  it("degrades a single unresolved ref inside a component gracefully instead of failing the whole component", () => {
    const def = parseComponentDefinition("btn-primary", `<button style="color: $color.nope">Text</button>`);
    const ctx = makeContext({ componentDefs: new Map([["btn-primary", def]]) });
    const { doc } = parseScreen(`<div id="n1"><button id="n2" class="$btn-primary"></button></div>`, "s", ctx.registry);
    const html = renderScreen(doc, ctx);
    expect(html).not.toContain("data-invalid-component");
    expect(html).toContain("Text");
    expect(html).toContain("/* unresolved: $color.nope */");
  });

  it("never emits NaN when alpha() is missing its fraction argument", () => {
    const { doc } = parseScreen(`<div id="n1" style="color: alpha($color.primary)"></div>`, "s", makeContext().registry);
    const html = renderScreen(doc, makeContext());
    expect(html).not.toContain("NaN");
  });
});

describe("renderScreen — icon-font diagnostic", () => {
  it("does not mark .icon usage when iconFontAvailable is unset (default: no diagnostic)", () => {
    const { doc } = parseScreen(`<span id="n1" class="icon">search</span>`, "s", makeContext().registry);
    const html = renderScreen(doc, makeContext());
    expect(html).not.toContain("data-unresolved-icon-font");
  });

  it("does not mark .icon usage when iconFontAvailable is true", () => {
    const { doc } = parseScreen(`<span id="n1" class="icon">search</span>`, "s", makeContext().registry);
    const ctx = makeContext({ iconFontAvailable: true });
    expect(renderScreen(doc, ctx)).not.toContain("data-unresolved-icon-font");
  });

  it("marks an element carrying the .icon class with data-unresolved-icon-font when iconFontAvailable is false", () => {
    const { doc } = parseScreen(`<span id="n1" class="icon">search</span>`, "s", makeContext().registry);
    const ctx = makeContext({ iconFontAvailable: false });
    expect(renderScreen(doc, ctx)).toContain('data-unresolved-icon-font="Material Symbols Rounded"');
  });

  it("only marks elements that actually carry the .icon class, not every element, when the font is unavailable", () => {
    const { doc } = parseScreen(
      `<div id="n1"><span id="n2" class="icon">search</span><p id="n3">plain text</p></div>`,
      "s",
      makeContext().registry,
    );
    const html = renderScreen(doc, makeContext({ iconFontAvailable: false }));
    expect(html).toContain('<span id="n2" class="icon" data-unresolved-icon-font="Material Symbols Rounded">');
    const n1Match = /<div id="n1"([^>]*)>/.exec(html);
    expect(n1Match?.[1]).not.toContain("data-unresolved-icon-font");
    const n3Match = /<p id="n3"([^>]*)>/.exec(html);
    expect(n3Match?.[1]).not.toContain("data-unresolved-icon-font");
  });

  it("matches .icon among several classes, not just an exact class attribute", () => {
    const { doc } = parseScreen(`<span id="n1" class="icon large">search</span>`, "s", makeContext().registry);
    const html = renderScreen(doc, makeContext({ iconFontAvailable: false }));
    expect(html).toContain("data-unresolved-icon-font");
  });
});

describe("renderScreen — determinism", () => {
  it("produces byte-identical output for the same input across repeated renders", () => {
    const ctx = makeContext();
    const { doc } = parseScreen(
      `<div id="n1" style="padding: $space.md"><button id="n2" class="$btn-primary"><span id="n3" data-slot="label">Hi</span></button></div>`,
      "s",
      ctx.registry,
    );
    const first = renderScreen(doc, ctx);
    const second = renderScreen(doc, makeContext());
    expect(second).toBe(first);
  });
});

describe("renderScreen — component instances inside slot fills (CHR-581)", () => {
  const cardDef = parseComponentDefinition("card", `<div style="padding: $space.md"><span data-slot="content">C</span></div>`);
  const btnDef = parseComponentDefinition(
    "btn-primary",
    `<button style="color: $color.on-primary"><span data-slot="label">Default label</span></button>\n<template data-variant="hover"><button style="color: $color.on-primary; opacity: 0.9"><span data-slot="label">Default label</span></button></template>`,
  );

  function slotContext(extraDefs: [string, ReturnType<typeof parseComponentDefinition>][] = []): RenderContext {
    const ctx = makeContext({ componentDefs: new Map([["card", cardDef], ["btn-primary", btnDef], ...extraDefs]) });
    const componentNames = new Set(["card", "btn-primary", ...extraDefs.map(([name]) => name)]);
    return { ...ctx, registry: { ...ctx.registry, componentNames } };
  }

  it("expands a component instance that fills another component's slot, with its id, and never leaks the $ref", () => {
    const ctx = slotContext();
    const { doc, errors } = parseScreen(
      `<div id="n1"><div id="n2" class="$card"><button id="n3" data-slot="content" class="$btn-primary"><span data-slot="label">Go</span></button></div></div>`,
      "s",
      ctx.registry,
    );
    expect(errors).toEqual([]);
    const html = renderScreen(doc, ctx);
    expect(html).toContain('<div id="n2" style="padding: 16px" data-variant="default">');
    expect(html).toMatch(/<button id="n3" style="color: #ffffff" data-variant="default">/);
    expect(html).toContain(">Go<");
    expect(html).not.toContain("Default label");
    expect(html).not.toContain("$");
  });

  it("resolves the nested instance's own variant and nested slots", () => {
    const ctx = slotContext();
    const { doc } = parseScreen(
      `<div id="n1"><div id="n2" class="$card"><button id="n3" data-slot="content" class="$btn-primary" data-variant="hover"><span data-slot="label">Hover me</span></button></div></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);
    expect(html).toContain("opacity: 0.9");
    expect(html).toContain('id="n3" style="color: #ffffff; opacity: 0.9" data-variant="hover"');
    expect(html).toContain(">Hover me<");
    expect(html.match(/data-variant=/g)).toHaveLength(2); // the card's and the button's, once each
  });

  it("carries the nested instance's own attributes onto its expanded root (CHR-583 applies inside fills too)", () => {
    const ctx = slotContext();
    const { doc } = parseScreen(
      `<div id="n1"><div id="n2" class="$card"><a id="n3" data-slot="content" class="$btn-primary" href="/go" style="flex: 1"><span data-slot="label">Go</span></a></div></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);
    expect(html).toContain('href="/go"');
    expect(html).toContain('style="color: #ffffff; flex: 1"');
  });

  it("expands a fill instance nested deeper inside plain slot content", () => {
    const ctx = slotContext();
    const { doc } = parseScreen(
      `<div id="n1"><div id="n2" class="$card"><div data-slot="content" id="w"><p id="p"><a id="n3" class="$btn-primary"><span data-slot="label">Deep</span></a></p></div></div></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);
    // The definition's root tag wins over the instance's <a>, as it does for a top-level instance.
    expect(html).toContain('<div id="w"><p id="p"><button id="n3" style="color: #ffffff" data-variant="default">');
    expect(html).toContain(">Deep<");
    expect(html).not.toContain("$btn-primary");
  });

  it("gives an id-less fill instance an id under the expansion it fills", () => {
    const ctx = slotContext();
    const { doc } = parseScreen(
      `<div id="n1"><div id="n2" class="$card"><button data-slot="content" class="$btn-primary"><span data-slot="label">Go</span></button></div></div>`,
      "s",
      ctx.registry,
    );
    expect(renderScreen(doc, ctx)).toContain('<button id="n2--fill1" style="color: #ffffff"');
  });

  it("keeps the ids of plain elements inside a slot fill", () => {
    const ctx = slotContext();
    const { doc } = parseScreen(
      `<div id="n1"><div id="n2" class="$card"><div data-slot="content" id="x1"><b id="x2">t</b></div></div></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);
    expect(html).toContain('<div id="x1"><b id="x2">t</b></div>');
  });

  it("treats the same component nested through a screen-authored fill as nesting, not recursion", () => {
    const ctx = slotContext();
    const { doc } = parseScreen(
      `<div id="n1"><div id="n2" class="$card"><div id="n3" data-slot="content" class="$card"><span data-slot="content">inner</span></div></div></div>`,
      "s",
      ctx.registry,
    );
    const html = renderScreen(doc, ctx);
    expect(html).not.toContain("data-recursive-component");
    expect(html.match(/padding: 16px/g)).toHaveLength(2);
    expect(html).toContain(">inner<");
  });

  it("guards a cycle that runs through a template's own slot fill", () => {
    // wrap's template puts a `$wrap` inside a `$card`'s slot: expanding wrap
    // expands card, whose fill instantiates wrap again — forever, without
    // the fill carrying its author's expansion path.
    const wrapDef = parseComponentDefinition("wrap", `<div><div class="$card"><div class="$wrap" data-slot="content">x</div></div></div>`);
    const ctx = slotContext([["wrap", wrapDef]]);
    const { doc } = parseScreen(`<div id="n1"><div id="n2" class="$wrap"></div></div>`, "s", ctx.registry);
    const html = renderScreen(doc, ctx);
    expect(html).toContain('data-recursive-component="wrap"');
    expect(html.match(/padding: 16px/g)).toHaveLength(1);
  });

  it("namespaces the ids of a fill authored inside a template under that expansion", () => {
    const shellDef = parseComponentDefinition("shell", `<div><div class="$card"><b id="inner" data-slot="content">t</b></div></div>`);
    const ctx = slotContext([["shell", shellDef]]);
    const { doc } = parseScreen(`<div id="n1"><div id="n2" class="$shell"></div><div id="n4" class="$shell"></div></div>`, "s", ctx.registry);
    const html = renderScreen(doc, ctx);
    expect(html).toContain('<b id="n2--inner">t</b>');
    expect(html).toContain('<b id="n4--inner">t</b>');
  });

  it("marks an unresolved component ref inside a fill instead of leaking it, and the parser reports it", () => {
    const ctx = slotContext();
    const { doc, errors } = parseScreen(
      `<div id="n1"><div id="n2" class="$card"><button id="n3" data-slot="content" class="$btn-ghost">Go</button></div></div>`,
      "s",
      ctx.registry,
    );
    expect(errors).toContainEqual(expect.objectContaining({ code: "unresolved_ref", message: expect.stringContaining("$btn-ghost") }));
    const html = renderScreen(doc, ctx);
    expect(html).not.toContain("$btn-ghost");
    expect(html).toContain('<button id="n3">Go</button>');
  });
});
