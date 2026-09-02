import { describe, it, expect } from "vitest";
import { parseScreen } from "./parser.js";
import { serializeScreen } from "./serializer.js";
import type { DesignSystemRegistry } from "./registry.js";

const registry: DesignSystemRegistry = {
  componentNames: new Set(["btn-primary"]),
  tokenPaths: new Set([
    "color.text-primary",
    "color.text-secondary",
    "color.text-on-primary",
    "color.primary",
    "space.lg",
    "space.md",
    "typo.heading-lg",
    "typo.body",
  ]),
  tokenFlatNames: new Set(["screen-base", "primary", "lg", "md", "heading-lg", "body"]),
};

const WELCOME_SCREEN = `<section id="n1" class="$screen-base" style="padding: $space.lg" data-section="onboarding">
  <h1 id="n2" style="color: $color.text-primary; font: $typo.heading-lg">Welcome to NotesApp</h1>
  <p id="n3" style="color: $color.text-secondary; font: $typo.body">Capture ideas as they come.</p>
  <button id="n4" class="$btn-primary" data-variant="default" data-flow-target="screen-sign-up" data-flow-trigger="tap">Get started<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="$color.text-on-primary"/></svg></button>
</section>`;

describe("parseScreen — round-trip example", () => {
  it("parses the augmentation grammar into the canonical ref model", () => {
    const { doc, errors } = parseScreen(WELCOME_SCREEN, "welcome", registry);

    expect(errors).toEqual([]);
    expect(doc.sectionId).toBe("onboarding");
    expect(doc.rootNodeId).toBe("n1");

    const root = doc.nodes["n1"]!;
    expect(root.kind).toBe("element");
    expect(root.refs.tokens.class).toBe("screen-base");
    expect(root.refs.tokens.padding).toBe("space.lg");

    const h1 = doc.nodes["n2"]!;
    expect(h1.refs.tokens.color).toBe("color.text-primary");
    expect(h1.refs.tokens.font).toBe("typo.heading-lg");

    const button = doc.nodes["n4"]!;
    expect(button.kind).toBe("component_instance");
    expect(button.refs.component).toBe("btn-primary");
    expect(button.refs.variant).toBe("default");
    expect(button.childIds).toEqual([]);
    expect(Object.keys(button.slotOverrides ?? {})).toHaveLength(2);

    expect(doc.flows).toEqual([
      { triggerNodeId: "n4", triggerEvent: "tap", targetKind: "screen", targetId: "screen-sign-up" },
    ]);
  });

  it("round-trips: parse -> serialize -> parse again yields an identical model", () => {
    const first = parseScreen(WELCOME_SCREEN, "welcome", registry);
    expect(first.errors).toEqual([]);

    const serialized = serializeScreen(first.doc);
    const second = parseScreen(serialized, "welcome", registry);

    expect(second.errors).toEqual([]);
    expect(second.doc).toEqual(first.doc);
  });
});

describe("parseScreen — modifier functions", () => {
  it("parses alpha() and oklab() modifiers", () => {
    const html = `<div id="n1" style="color: alpha($color.primary, 0.1); background: oklab($color.primary)"></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);
    expect(errors).toEqual([]);
    expect(doc.nodes["n1"]!.refs.tokens.color).toEqual({ fn: "alpha", args: ["color.primary", 0.1] });
    expect(doc.nodes["n1"]!.refs.tokens.background).toEqual({ fn: "oklab", args: ["color.primary"] });
  });

  it("round-trips a modifier function through serialization", () => {
    const html = `<div id="n1" style="color: alpha($color.primary, 0.1)"></div>`;
    const first = parseScreen(html, "s", registry);
    const second = parseScreen(serializeScreen(first.doc), "s", registry);
    expect(second.doc).toEqual(first.doc);
  });
});

describe("parseScreen — validation errors", () => {
  it("flags unresolved_ref for an unknown class ref", () => {
    const html = `<div id="n1" class="$does-not-exist"></div>`;
    const { errors } = parseScreen(html, "s", registry);
    expect(errors).toContainEqual({
      code: "unresolved_ref",
      message: '"$does-not-exist" does not resolve in the design system',
      nodeId: "n1",
    });
  });

  it("flags unresolved_ref for an unknown style token path", () => {
    const html = `<div id="n1" style="color: $color.nope"></div>`;
    const { errors } = parseScreen(html, "s", registry);
    expect(errors).toContainEqual({
      code: "unresolved_ref",
      message: '"$color.nope" does not resolve in the design system',
      nodeId: "n1",
    });
  });

  it("flags ambiguous_class_ref when a name is both a component and a token-class", () => {
    const ambiguousRegistry: DesignSystemRegistry = {
      componentNames: new Set(["shared-name"]),
      tokenPaths: new Set(),
      tokenFlatNames: new Set(["shared-name"]),
    };
    const html = `<div id="n1" class="$shared-name"></div>`;
    const { errors } = parseScreen(html, "s", ambiguousRegistry);
    expect(errors).toContainEqual({
      code: "ambiguous_class_ref",
      message: '"$shared-name" resolves to both a component and a token',
      nodeId: "n1",
    });
  });

  it("flags malformed_html for markup parse5 cannot parse cleanly", () => {
    const html = `<div id="n1" class="a"b="c">broken</div>`;
    const { errors } = parseScreen(html, "s", registry);
    expect(errors.some((e) => e.code === "malformed_html")).toBe(true);
  });

  it("parses a $ref mixed with literal text as a MixedTokenValue, with no errors", () => {
    const html = `<div id="n1" style="border: $space.md solid $color.primary"></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);
    expect(errors).toEqual([]);
    expect(doc.nodes["n1"]!.refs.tokens.border).toEqual({
      parts: ["", "space.md", " solid ", "color.primary", ""],
    });
  });

  it("flags unknown_modifier for an unrecognized modifier function", () => {
    const html = `<div id="n1" style="color: darken($color.primary, 0.1)"></div>`;
    const { errors } = parseScreen(html, "s", registry);
    expect(errors).toContainEqual({
      code: "unknown_modifier",
      message: 'unknown_modifier in style "color: darken($color.primary, 0.1)"',
      nodeId: "n1",
    });
  });

  it("flags suspicious_attr for a misspelled augmentation attribute but keeps it on the node", () => {
    const html = `<div id="n1" data-varient="hover"></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);
    expect(errors).toContainEqual({
      code: "suspicious_attr",
      message: 'attribute "data-varient" is not part of the augmentation grammar — did you mean "data-variant"?',
      nodeId: "n1",
    });
    expect(doc.nodes["n1"]!.attributes["data-varient"]).toBe("hover");
  });

  it("does not flag an agent's own data-* attribute", () => {
    const html = `<div id="n1" data-testid="hero"></div>`;
    const { errors } = parseScreen(html, "s", registry);
    expect(errors.some((e) => e.code === "suspicious_attr")).toBe(false);
  });
});

describe("parseScreen — mixed token values", () => {
  const mixedRegistry: DesignSystemRegistry = {
    componentNames: new Set(),
    tokenPaths: new Set(["color.border", "spacing.sm", "spacing.lg"]),
    tokenFlatNames: new Set(["border", "sm", "lg"]),
  };

  it("parses two refs separated by whitespace, verbatim", () => {
    const html = `<div id="n1" style="padding: $spacing.sm $spacing.lg"></div>`;
    const { doc, errors } = parseScreen(html, "s", mixedRegistry);
    expect(errors).toEqual([]);
    expect(doc.nodes["n1"]!.refs.tokens.padding).toEqual({
      parts: ["", "spacing.sm", " ", "spacing.lg", ""],
    });
  });

  it("parses a modifier call as one segment of a mixed value", () => {
    const html = `<div id="n1" style="border: 1px solid alpha($color.border, 0.5)"></div>`;
    const { doc, errors } = parseScreen(html, "s", mixedRegistry);
    expect(errors).toEqual([]);
    expect(doc.nodes["n1"]!.refs.tokens.border).toEqual({
      parts: ["1px solid ", { fn: "alpha", args: ["color.border", 0.5] }, ""],
    });
  });

  it("still flags multi_ref_value when a modifier call embedded in a mixed value has malformed args", () => {
    const html = `<div id="n1" style="border: 1px solid alpha($color.border, oops)"></div>`;
    const { errors } = parseScreen(html, "s", mixedRegistry);
    expect(errors).toContainEqual(
      expect.objectContaining({ code: "multi_ref_value", nodeId: "n1" }),
    );
  });

  it("substitutes a ref embedded in a plain CSS function like calc()", () => {
    // A value that IS exactly one whole-value function call, e.g.
    // "calc($spacing.sm * 2)" on its own, still hits the whole-value
    // CALL_RE fast path (unchanged — same as any other unrecognized
    // function name, see the "still flags unknown_modifier..." test
    // above); calc() only reaches the mixed tokenizer once it's not the
    // *entire* value, same as any other literal-mixed CSS.
    const html = `<div id="n1" style="width: 0px + calc($spacing.sm * 2)"></div>`;
    const { doc, errors } = parseScreen(html, "s", mixedRegistry);
    expect(errors).toEqual([]);
    expect(doc.nodes["n1"]!.refs.tokens.width).toEqual({
      parts: ["0px + calc(", "spacing.sm", " * 2)"],
    });
  });

  it("treats a lone $ with no valid ref syntax as a literal, no error", () => {
    const html = `<div id="n1" style="content: $"></div>`;
    const { doc, errors } = parseScreen(html, "s", mixedRegistry);
    expect(errors).toEqual([]);
    expect(doc.nodes["n1"]!.inlineStyles.content).toBe("$");
    expect(doc.nodes["n1"]!.refs.tokens.content).toBeUndefined();
  });

  it("still flags an unresolved path inside a mixed value, non-blocking", () => {
    const html = `<div id="n1" style="border: 1px solid $color.nope"></div>`;
    const { errors } = parseScreen(html, "s", mixedRegistry);
    expect(errors).toContainEqual({
      code: "unresolved_ref",
      message: '"$color.nope" does not resolve in the design system',
      nodeId: "n1",
    });
  });

  it("keeps a single-ref value as a plain string, not wrapped in parts (compat guard)", () => {
    const html = `<div id="n1" style="color: $color.border"></div>`;
    const { doc, errors } = parseScreen(html, "s", mixedRegistry);
    expect(errors).toEqual([]);
    expect(doc.nodes["n1"]!.refs.tokens.color).toBe("color.border");
  });

  it("round-trips a mixed CSS value byte-stably", () => {
    const html = `<div id="n1" style="border: 1px solid $color.border; padding: $spacing.sm $spacing.lg"></div>`;
    const first = parseScreen(html, "s", mixedRegistry);
    expect(first.errors).toEqual([]);

    const serialized = serializeScreen(first.doc);
    expect(serialized).toContain('style="border: 1px solid $color.border; padding: $spacing.sm $spacing.lg"');

    const second = parseScreen(serialized, "s", mixedRegistry);
    expect(second.errors).toEqual([]);
    expect(second.doc).toEqual(first.doc);
  });

  it("round-trips a mixed SVG fill value byte-stably", () => {
    const html = `<svg id="n1"><path id="n2" d="M0 0" fill="$color.border none"/></svg>`;
    const first = parseScreen(html, "s", mixedRegistry);
    expect(first.errors).toEqual([]);
    expect(first.doc.nodes["n2"]!.refs.tokens.fill).toEqual({ parts: ["", "color.border", " none"] });

    const serialized = serializeScreen(first.doc);
    expect(serialized).toContain('fill="$color.border none"');

    const second = parseScreen(serialized, "s", mixedRegistry);
    expect(second.errors).toEqual([]);
    expect(second.doc).toEqual(first.doc);
  });
});

describe("parseScreen — SVG refs", () => {
  it("resolves fill/stroke token refs identically to CSS values", () => {
    const html = `<svg id="n1" viewBox="0 0 24 24"><path id="n2" d="M0 0" fill="$color.primary" stroke="none"/></svg>`;
    const { doc, errors } = parseScreen(html, "s", registry);
    expect(errors).toEqual([]);
    expect(doc.nodes["n1"]!.kind).toBe("svg");
    expect(doc.nodes["n2"]!.kind).toBe("svg_path");
    expect(doc.nodes["n2"]!.refs.tokens.fill).toBe("color.primary");
    expect(doc.nodes["n2"]!.attributes.stroke).toBe("none");
  });
});

describe("parseScreen — node id collisions", () => {
  it("does not let an auto-generated id clobber an explicit id seen later in the tree", () => {
    // Without a pre-scan, the root div would be auto-assigned "n1" (first
    // counter value), colliding with the span's explicit id="n1" and
    // silently overwriting it in the flat node map.
    const html = `<div><span id="n1">x</span></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);

    expect(doc.nodes["n1"]!.tag).toBe("span");
    expect(doc.rootNodeId).not.toBe("n1");
    expect(doc.nodes[doc.rootNodeId]!.tag).toBe("div");
    // root, span, and the span's text child must all survive.
    expect(Object.keys(doc.nodes)).toHaveLength(3);
    expect(errors.some((e) => e.code === "duplicate_node_id")).toBe(false);
  });

  it("flags duplicate explicit ids and does not let the second occurrence clobber the first", () => {
    const html = `<div id="dup"><span id="dup">x</span></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);

    expect(errors).toContainEqual({ code: "duplicate_node_id", message: 'id "dup" is used 2 times' });
    expect(doc.nodes["dup"]!.tag).toBe("div");
    // the span must still be present in the model, under a fallback id.
    const span = Object.values(doc.nodes).find((n) => n.tag === "span");
    expect(span).toBeDefined();
    expect(span!.id).not.toBe("dup");
    expect(Object.keys(doc.nodes)).toHaveLength(3);
  });
});

describe("parseScreen — CSS functions without refs", () => {
  it("treats non-modifier CSS functions as literal inline styles, not unknown_modifier errors", () => {
    const html = `<div id="n1" style="background: rgb(0, 0, 0); width: calc(100% - 10px); background-image: url(a.png)"></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);

    expect(errors).toEqual([]);
    expect(doc.nodes["n1"]!.inlineStyles.background).toBe("rgb(0, 0, 0)");
    expect(doc.nodes["n1"]!.inlineStyles.width).toBe("calc(100% - 10px)");
    expect(doc.nodes["n1"]!.inlineStyles["background-image"]).toBe("url(a.png)");
  });

  it("still flags unknown_modifier for a $ref wrapped in an unrecognized function, but keeps the raw value", () => {
    const html = `<div id="n1" style="color: darken($color.primary, 0.1)"></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);

    expect(errors).toContainEqual({
      code: "unknown_modifier",
      message: 'unknown_modifier in style "color: darken($color.primary, 0.1)"',
      nodeId: "n1",
    });
    // the declaration must not be silently dropped.
    expect(doc.nodes["n1"]!.inlineStyles.color).toBe("darken($color.primary, 0.1)");
  });

  it("keeps a raw SVG fill/stroke value when it references an unresolvable modifier", () => {
    const html = `<svg id="n1"><path id="n2" d="M0 0" fill="darken($color.primary, 0.1)"/></svg>`;
    const { doc, errors } = parseScreen(html, "s", registry);

    expect(errors.some((e) => e.code === "unknown_modifier")).toBe(true);
    expect(doc.nodes["n2"]!.attributes.fill).toBe("darken($color.primary, 0.1)");
  });
});

describe("parseScreen — void elements round-trip", () => {
  it("round-trips a screen containing an <img>", () => {
    const html = `<div id="n1"><img id="n2" src="a.png"/></div>`;
    const first = parseScreen(html, "s", registry);
    expect(first.errors).toEqual([]);

    const serialized = serializeScreen(first.doc);
    expect(serialized).not.toContain("</img>");

    const second = parseScreen(serialized, "s", registry);
    expect(second.errors).toEqual([]);
    expect(second.doc).toEqual(first.doc);
  });
});

describe("parseScreen — named slots round-trip", () => {
  it("preserves an explicit data-slot name across a parse -> serialize -> parse cycle", () => {
    const html = `<div id="n1" class="$btn-primary"><span id="n2" data-slot="icon">i</span><span id="n3">label</span></div>`;
    const first = parseScreen(html, "s", registry);
    expect(first.errors).toEqual([]);
    expect(first.doc.nodes["n1"]!.slotOverrides).toHaveProperty("icon");

    const serialized = serializeScreen(first.doc);
    const second = parseScreen(serialized, "s", registry);

    expect(second.errors).toEqual([]);
    expect(second.doc).toEqual(first.doc);
    expect(second.doc.nodes["n1"]!.slotOverrides).toHaveProperty("icon");
  });

  it("does not let a positional slot key silently overwrite an explicit one with the same name", () => {
    // child1 claims "slot-1" explicitly; child2 positionally takes "slot-0";
    // child3 would positionally land on "slot-1" next, which is already
    // taken — it must be bumped to a free key ("slot-2") instead of
    // clobbering child1's content.
    const html = `<div id="n1" class="$btn-primary"><span id="n2" data-slot="slot-1">first</span><span id="n3">second</span><span id="n4">third</span></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);

    const overrides = doc.nodes["n1"]!.slotOverrides ?? {};
    const keys = Object.keys(overrides);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(3);
    expect(overrides["slot-1"]?.children[0]?.text).toBe("first");
    expect(errors.filter((e) => e.code === "malformed_html")).toEqual([]);
  });
});

describe("parseScreen — data-flow-trigger validation", () => {
  it("flags an invalid data-flow-trigger and falls back to tap", () => {
    const html = `<div id="n1" data-flow-target="x" data-flow-trigger="bogus"></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);

    expect(errors).toContainEqual({
      code: "unknown_flow_trigger",
      message: '"bogus" is not a valid data-flow-trigger',
      nodeId: "n1",
    });
    expect(doc.flows[0]!.triggerEvent).toBe("tap");
  });
});

describe("parseScreen — fill/stroke style props on non-SVG nodes", () => {
  it("round-trips a literal 'fill' CSS property on a non-SVG element", () => {
    const html = `<div id="n1" style="fill: $color.primary"></div>`;
    const first = parseScreen(html, "s", registry);
    expect(first.errors).toEqual([]);
    expect(first.doc.nodes["n1"]!.refs.tokens.fill).toBe("color.primary");

    const second = parseScreen(serializeScreen(first.doc), "s", registry);
    expect(second.doc).toEqual(first.doc);
  });
});

describe("parseScreen — data-title round-trip", () => {
  it("preserves an explicit data-title across a parse -> serialize -> parse cycle", () => {
    const html = `<div id="n1" data-title="Checkout">x</div>`;
    const first = parseScreen(html, "s", registry);
    expect(first.doc.title).toBe("Checkout");

    const second = parseScreen(serializeScreen(first.doc), "s", registry);
    expect(second.doc.title).toBe("Checkout");
    expect(second.doc).toEqual(first.doc);
  });

  it("does not fabricate a data-title attribute when none was set", () => {
    const html = `<div id="n1">x</div>`;
    const { doc } = parseScreen(html, "s", registry);
    expect(doc.title).toBe("s");
    expect(serializeScreen(doc)).not.toContain("data-title");
  });
});

describe("parseScreen — whitespace-only text nodes", () => {
  it("does not create model nodes for pure-whitespace text between tags", () => {
    const html = `<div id="n1">\n  <span id="n2">x</span>\n</div>`;
    const { doc } = parseScreen(html, "s", registry);

    expect(Object.keys(doc.nodes)).toHaveLength(3); // n1, n2, n2's text "x"
    expect(doc.nodes["n1"]!.childIds).toEqual(["n2"]);
  });
});

describe("parseScreen — data-component / data-slot instance syntax", () => {
  it("parses a data-component element as a component_instance", () => {
    const html = `<div id="n1" data-component="btn-primary" data-variant="hover"><span id="n2" data-slot="icon">i</span></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);

    expect(errors).toEqual([]);
    const node = doc.nodes["n1"]!;
    expect(node.kind).toBe("component_instance");
    expect(node.refs.component).toBe("btn-primary");
    expect(node.refs.variant).toBe("hover");
    expect(node.instanceSyntax).toBe("data-attr");
    expect(node.attributes["data-component"]).toBeUndefined();
  });

  it("routes named data-slot children into slot_overrides, same as class=$name instances", () => {
    const html = `<div id="n1" data-component="btn-primary"><span id="n2" data-slot="icon">i</span><span id="n3">label</span></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);

    expect(errors).toEqual([]);
    const overrides = doc.nodes["n1"]!.slotOverrides ?? {};
    expect(Object.keys(overrides)).toHaveLength(2);
    expect(overrides["icon"]?.children[0]?.text).toBe("i");
  });

  it("flags unresolved_ref for an unknown data-component name but keeps it a component_instance", () => {
    const html = `<div id="n1" data-component="does-not-exist"></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);

    expect(errors).toContainEqual({
      code: "unresolved_ref",
      message: 'component "does-not-exist" (data-component) is not in the design system',
      nodeId: "n1",
    });
    expect(doc.nodes["n1"]!.kind).toBe("component_instance");
    expect(doc.nodes["n1"]!.refs.component).toBe("does-not-exist");
  });

  it("leaves class=\"$name\" behavior unchanged when data-component is absent", () => {
    const html = `<div id="n1" class="$btn-primary"></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);

    expect(errors).toEqual([]);
    expect(doc.nodes["n1"]!.kind).toBe("component_instance");
    expect(doc.nodes["n1"]!.instanceSyntax).toBe("class");
  });

  it("prefers data-component over a $-class token when both are present, naming both in the issue", () => {
    const html = `<div id="n1" data-component="btn-primary" class="$btn-primary"></div>`;
    const { doc, errors } = parseScreen(html, "s", registry);

    const node = doc.nodes["n1"]!;
    expect(node.kind).toBe("component_instance");
    expect(node.refs.component).toBe("btn-primary");
    expect(node.instanceSyntax).toBe("data-attr");
    // The $-class token is kept as a plain class rather than dropped.
    expect(node.attributes.class).toBe("$btn-primary");
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: "ambiguous_class_ref",
        nodeId: "n1",
        message: expect.stringContaining("btn-primary"),
      }),
    );
    const issue = errors.find((e) => e.code === "ambiguous_class_ref");
    expect(issue?.message).toContain("data-component");
    expect(issue?.message).toContain("class=");
  });
});

describe("parseScreen — data-component round-trip", () => {
  it("preserves data-component syntax across parse -> serialize -> parse", () => {
    const html = `<div id="n1" data-component="btn-primary" data-variant="hover"><span id="n2" data-slot="icon">i</span></div>`;
    const first = parseScreen(html, "s", registry);
    expect(first.errors).toEqual([]);

    const serialized = serializeScreen(first.doc);
    expect(serialized).toContain('data-component="btn-primary"');
    expect(serialized).not.toContain('class="$btn-primary"');

    const second = parseScreen(serialized, "s", registry);
    expect(second.errors).toEqual([]);
    expect(second.doc).toEqual(first.doc);
  });

  it("preserves class=\"$name\" syntax across parse -> serialize -> parse", () => {
    const html = `<div id="n1" class="$btn-primary" data-variant="hover"><span id="n2" data-slot="icon">i</span></div>`;
    const first = parseScreen(html, "s", registry);
    expect(first.errors).toEqual([]);

    const serialized = serializeScreen(first.doc);
    expect(serialized).toContain('class="$btn-primary"');
    expect(serialized).not.toContain("data-component=");

    const second = parseScreen(serialized, "s", registry);
    expect(second.errors).toEqual([]);
    expect(second.doc).toEqual(first.doc);
  });
});

describe("parseScreen — <template> content model", () => {
  it("builds a <template>'s children from its content, not from its (always-empty) childNodes", () => {
    const { doc, errors } = parseScreen(`<template id="t1"><span id="s1">A</span></template>`, "s", registry);
    expect(errors).toEqual([]);
    expect(doc.nodes["s1"]).toBeDefined();
    expect(doc.nodes["t1"]!.childIds).toEqual(["s1"]);
  });

  it("preserves <tr>/<td>/<li> inside a <template>, which HTML's ordinary tree-construction rules would otherwise drop", () => {
    const tr = parseScreen(`<template><tr id="r1"><td id="c1">X</td></tr></template>`, "s", registry);
    expect(tr.errors).toEqual([]);
    expect(tr.doc.nodes["r1"]).toBeDefined();
    expect(tr.doc.nodes["c1"]).toBeDefined();

    const li = parseScreen(`<template><li id="i1">X</li></template>`, "s", registry);
    expect(li.errors).toEqual([]);
    expect(li.doc.nodes["i1"]).toBeDefined();
  });
});

describe("component instances inside slot fills (CHR-581)", () => {
  const cardRegistry: DesignSystemRegistry = {
    ...registry,
    componentNames: new Set([...registry.componentNames, "card"]),
  };

  it("models a $ref inside slot content as a component_instance with its id, variant and nested slots", () => {
    const { doc, errors } = parseScreen(
      `<div id="n1"><div id="n2" class="$card"><button id="n3" data-slot="content" class="$btn-primary wide" data-variant="hover"><span id="n4" data-slot="label">Go</span></button></div></div>`,
      "s",
      cardRegistry,
    );
    expect(errors).toEqual([]);
    const fill = doc.nodes["n2"]!.slotOverrides!["content"]!;
    expect(fill).toMatchObject({
      kind: "component_instance",
      id: "n3",
      tag: "button",
      attributes: { class: "wide" },
      refs: { component: "btn-primary", variant: "hover" },
      children: [],
    });
    expect(fill.slotOverrides!["label"]).toMatchObject({ kind: "element", id: "n4", tag: "span" });
    // Slot content stays out of the flat node map, as before.
    expect(doc.nodes["n3"]).toBeUndefined();
  });

  it("round-trips a fill instance's id, ref and variant through the serializer", () => {
    const source = `<div id="n1"><div id="n2" class="$card"><button id="n3" data-slot="content" class="$btn-primary" data-variant="hover"><span id="n4" data-slot="label">Go</span></button></div></div>`;
    const { doc } = parseScreen(source, "s", cardRegistry);
    const out = serializeScreen(doc);
    expect(out).toContain('<button id="n3" data-slot="content" class="$btn-primary" data-variant="hover">');
    expect(out).toContain('<span id="n4" data-slot="label">Go</span>');
    // And it parses back to the same model.
    const again = parseScreen(out, "s", cardRegistry);
    expect(again.doc.nodes["n2"]!.slotOverrides).toEqual(doc.nodes["n2"]!.slotOverrides);
  });

  it("reports an unresolved $ref inside slot content instead of keeping it as a class", () => {
    const { doc, errors } = parseScreen(
      `<div id="n1"><div id="n2" class="$card"><button data-slot="content" class="$btn-ghost">Go</button></div></div>`,
      "s",
      cardRegistry,
    );
    expect(errors).toContainEqual(expect.objectContaining({ code: "unresolved_ref" }));
    const fill = doc.nodes["n2"]!.slotOverrides!["content"]!;
    expect(fill.kind).toBe("element");
    expect(fill.attributes.class).toBeUndefined();
  });
});
