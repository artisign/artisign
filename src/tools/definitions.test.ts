import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRegistry } from "../model/index.js";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { loadAllDocuments } from "./definitions.js";

describe("loadAllDocuments", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("loads one source per screen, per component variant, and per pattern, each with its addressing scheme", async () => {
    await fx.store.writeScreen("home", `<div id="root"><button id="btn">Go</button></div>`);
    await fx.store.writeComponent(
      "btn-primary",
      `<button id="btn">Go</button>\n<template data-variant="hover"><button id="btn">Go (hover)</button></template>`,
    );
    await fx.store.writePattern("card-grid", `<div id="root"><section id="card1"></section></div>`);

    const registry = await loadRegistry(fx.store);
    const { docs: sources, warnings } = await loadAllDocuments(fx.store, registry);
    expect(warnings).toEqual([]);

    expect(sources.map((s) => s.address).sort()).toEqual(
      ["home", "component:btn-primary#default", "component:btn-primary#hover", "pattern:card-grid"].sort(),
    );

    const screenSource = sources.find((s) => s.address === "home")!;
    expect(screenSource).toMatchObject({ kind: "screen", name: "home" });
    expect(screenSource.variant).toBeUndefined();
    expect(screenSource.doc.nodes["btn"]).toBeDefined();

    const defaultVariant = sources.find((s) => s.address === "component:btn-primary#default")!;
    expect(defaultVariant).toMatchObject({ kind: "component", name: "btn-primary", variant: "default" });
    expect(defaultVariant.doc.nodes["btn"]!.text ?? defaultVariant.doc.nodes["btn"]).toBeDefined();

    const hoverVariant = sources.find((s) => s.address === "component:btn-primary#hover")!;
    expect(hoverVariant).toMatchObject({ kind: "component", name: "btn-primary", variant: "hover" });
    // Same explicit id "btn" as the default variant — legitimate, since each
    // variant is parsed independently with its own allocator.
    expect(hoverVariant.doc.nodes["btn"]).toBeDefined();

    const patternSource = sources.find((s) => s.address === "pattern:card-grid")!;
    expect(patternSource).toMatchObject({ kind: "pattern", name: "card-grid" });
    expect(patternSource.variant).toBeUndefined();
    expect(patternSource.doc.nodes["card1"]).toBeDefined();

    // No source appears twice.
    expect(new Set(sources.map((s) => s.address)).size).toBe(sources.length);
  });

  it("returns an empty list for a project with no screens, components, or patterns", async () => {
    const registry = await loadRegistry(fx.store);
    const { docs: sources, warnings } = await loadAllDocuments(fx.store, registry);
    expect(sources).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("loads a multi-rooted pattern's every top-level element, not just the first", async () => {
    await fx.store.writePattern("hero", `<div id="a"></div>\n<div id="b"><button id="c">Go</button></div>`);

    const registry = await loadRegistry(fx.store);
    const { docs: sources } = await loadAllDocuments(fx.store, registry);

    const pattern = sources.find((s) => s.address === "pattern:hero")!;
    expect(pattern.doc.nodes["a"]).toBeDefined();
    expect(pattern.doc.nodes["b"]).toBeDefined();
    expect(pattern.doc.nodes["c"]).toBeDefined();
  });

  it("loads a multi-rooted component default variant's every top-level element", async () => {
    await fx.store.writeComponent("group", `<span id="a">A</span>\n<span id="b">B</span>`);

    const registry = await loadRegistry(fx.store);
    const { docs: sources } = await loadAllDocuments(fx.store, registry);

    const defaultVariant = sources.find((s) => s.address === "component:group#default")!;
    expect(defaultVariant.doc.nodes["a"]).toBeDefined();
    expect(defaultVariant.doc.nodes["b"]).toBeDefined();
  });

  it("loads a pattern that legitimately starts with <tr>, without the row being dropped by table tree-construction", async () => {
    await fx.store.writePattern("row", `<tr id="r1"><td id="c1">A</td></tr>`);

    const registry = await loadRegistry(fx.store);
    const { docs: sources, warnings } = await loadAllDocuments(fx.store, registry);
    expect(warnings).toEqual([]);

    const pattern = sources.find((s) => s.address === "pattern:row")!;
    expect(pattern.doc.nodes["r1"]).toBeDefined();
    expect(pattern.doc.nodes["c1"]).toBeDefined();
  });

  it("loads a pattern that starts with a bare <td>, without table tree-construction dropping it", async () => {
    await fx.store.writePattern("cell", `<td id="c1">A</td>`);

    const registry = await loadRegistry(fx.store);
    const { docs: sources, warnings } = await loadAllDocuments(fx.store, registry);
    expect(warnings).toEqual([]);

    const pattern = sources.find((s) => s.address === "pattern:cell")!;
    expect(pattern.doc.nodes["c1"]).toBeDefined();
  });

  it("loads a pattern that starts with <li>, without list tree-construction dropping it", async () => {
    await fx.store.writePattern("item", `<li id="i1">A</li>`);

    const registry = await loadRegistry(fx.store);
    const { docs: sources, warnings } = await loadAllDocuments(fx.store, registry);
    expect(warnings).toEqual([]);

    const pattern = sources.find((s) => s.address === "pattern:item")!;
    expect(pattern.doc.nodes["i1"]).toBeDefined();
  });

  it("loads a pattern that starts with <tbody>, not covered by a tag-by-tag heuristic", async () => {
    await fx.store.writePattern("body", `<tbody id="tb"><tr id="r1"><td id="c1">A</td></tr></tbody>`);

    const registry = await loadRegistry(fx.store);
    const { docs: sources, warnings } = await loadAllDocuments(fx.store, registry);
    expect(warnings).toEqual([]);

    const pattern = sources.find((s) => s.address === "pattern:body")!;
    expect(pattern.doc.nodes["tb"]).toBeDefined();
    expect(pattern.doc.nodes["r1"]).toBeDefined();
    expect(pattern.doc.nodes["c1"]).toBeDefined();
  });

  it("loads a pattern with a leading comment before <tr>, which a leading-tag heuristic would miss", async () => {
    await fx.store.writePattern("commented-row", `<!-- a row --><tr id="r1"><td id="c1">A</td></tr>`);

    const registry = await loadRegistry(fx.store);
    const { docs: sources, warnings } = await loadAllDocuments(fx.store, registry);
    expect(warnings).toEqual([]);

    const pattern = sources.find((s) => s.address === "pattern:commented-row")!;
    expect(pattern.doc.nodes["r1"]).toBeDefined();
    expect(pattern.doc.nodes["c1"]).toBeDefined();
  });

  it("loads a pattern that starts with <col>, not covered by a tag-by-tag heuristic", async () => {
    await fx.store.writePattern("column", `<col id="co1">`);

    const registry = await loadRegistry(fx.store);
    const { docs: sources, warnings } = await loadAllDocuments(fx.store, registry);
    expect(warnings).toEqual([]);

    const pattern = sources.find((s) => s.address === "pattern:column")!;
    expect(pattern.doc.nodes["co1"]).toBeDefined();
  });

  it("does not consume the definition's first auto-generated id for the synthetic wrapper", async () => {
    await fx.store.writeComponent("btn", `<button style="color: #3366ff">Go</button>`);

    const registry = await loadRegistry(fx.store);
    const { docs: sources } = await loadAllDocuments(fx.store, registry);

    const defaultVariant = sources.find((s) => s.address === "component:btn#default")!;
    // Same id an unwrapped parse of this same markup would give it.
    expect(defaultVariant.doc.rootNodeId).toBe("n1");
    expect(defaultVariant.doc.nodes["n1"]).toBeDefined();
  });

  it("loads an empty pattern as an empty document, without a phantom wrapper node", async () => {
    await fx.store.writePattern("empty", ``);

    const registry = await loadRegistry(fx.store);
    const { docs: sources, warnings } = await loadAllDocuments(fx.store, registry);
    expect(warnings).toEqual([]);

    const pattern = sources.find((s) => s.address === "pattern:empty")!;
    expect(pattern.doc.nodes).toEqual({});
  });

  it("skips a component with a duplicate variant name and warns, without affecting other sources", async () => {
    // Bare markup (implicit "default") plus a <template> without
    // data-variant (also implicit "default") — two variants named "default".
    await fx.store.writeComponent(
      "btn-primary",
      `<button id="btn">Go</button>\n<template><button id="btn2">Go</button></template>`,
    );
    await fx.store.writeScreen("home", `<div id="n1"></div>`);

    const registry = await loadRegistry(fx.store);
    const { docs: sources, warnings } = await loadAllDocuments(fx.store, registry);

    expect(sources.some((s) => s.name === "btn-primary")).toBe(false);
    expect(sources.some((s) => s.address === "home")).toBe(true);
    expect(warnings).toEqual([
      {
        kind: "load_failed",
        target: "design-system/components/btn-primary.html",
        message: expect.stringContaining('duplicate variant "default"'),
      },
    ]);
  });

  it("skips a source with a blocking parse issue and warns, without affecting other sources", async () => {
    // Two elements sharing the same explicit id — duplicate_node_id is a
    // blocking issue.
    await fx.store.writePattern("broken", `<div id="dup"></div>\n<div id="dup"></div>`);
    await fx.store.writeScreen("home", `<div id="n1"></div>`);

    const registry = await loadRegistry(fx.store);
    const { docs: sources, warnings } = await loadAllDocuments(fx.store, registry);

    expect(sources.some((s) => s.name === "broken")).toBe(false);
    expect(sources.some((s) => s.address === "home")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: "load_failed", target: "design-system/patterns/broken.html" });
  });

  it("excludes a named component from loading entirely, per excludeComponents", async () => {
    await fx.store.writeComponent("btn-primary", `<button id="btn">Go</button>`);
    await fx.store.writeComponent("card", `<div id="c">Card</div>`);

    const registry = await loadRegistry(fx.store);
    const { docs: sources } = await loadAllDocuments(fx.store, registry, { excludeComponents: ["btn-primary"] });

    expect(sources.some((s) => s.name === "btn-primary")).toBe(false);
    expect(sources.some((s) => s.name === "card")).toBe(true);
  });
});
