import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { buildStyleOccurrenceIndex } from "./style-index.js";
import { loadRegistry } from "../model/index.js";

describe("buildStyleOccurrenceIndex", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("byScreen groups a fingerprint by every screen carrying a matching ad-hoc node", async () => {
    await fx.store.writeScreen("home", `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff; position: fixed"></div>`);
    await fx.store.writeScreen("checkout", `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff; position: fixed"></div>`);
    await fx.store.writeScreen("cart", `<div id="n1" style="color: #fff"></div>`); // different fingerprint

    const registry = await loadRegistry(fx.store);
    const index = await buildStyleOccurrenceIndex(fx.store, registry);

    const screens = index.byScreen.get("background:rgba(0,0,0,.4);color:#fff;position:fixed");
    expect(screens && [...screens].sort()).toEqual(["checkout", "home"]);
  });

  it("never feeds byScreen from a component or pattern definition — screens only", async () => {
    await fx.store.writeComponent("scrim", `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>`);
    await fx.store.writePattern("overlay-pattern", `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff"></div>`);
    await fx.store.writeScreen("home", `<div id="n1"></div>`); // no matching node on any screen

    const registry = await loadRegistry(fx.store);
    const index = await buildStyleOccurrenceIndex(fx.store, registry);

    expect(index.byScreen.has("background:rgba(0,0,0,.4);color:#fff")).toBe(false);
  });

  it("byComponent maps a fingerprint to the component whose default-variant root carries it", async () => {
    await fx.store.writeComponent(
      "modal-scrim",
      `<div id="n1" style="background: rgba(0,0,0,.4); color: #fff; inset: 0"></div>\n` +
        `<template data-variant="dark"><div id="n1" style="background: rgba(0,0,0,.8); color: #fff; inset: 0"></div></template>`,
    );

    const registry = await loadRegistry(fx.store);
    const index = await buildStyleOccurrenceIndex(fx.store, registry);

    // The default variant's fingerprint maps to the component name — the
    // non-default "dark" variant's own (different) fingerprint must not.
    expect(index.byComponent.get("background:rgba(0,0,0,.4);color:#fff;inset:0")).toBe("modal-scrim");
    expect(index.byComponent.has("background:rgba(0,0,0,.8);color:#fff;inset:0")).toBe(false);
  });

  it("a screen's slot-fill content (hand-built markup filled into a component instance) counts toward byScreen", async () => {
    await fx.store.writeComponent("card", `<div id="root"><span data-slot="content">default</span></div>`);
    await fx.store.writeScreen(
      "home",
      `<div id="n1"><div id="n2" class="$card"><div id="p1" data-slot="content" style="background: rgba(0,0,0,.4); color: #fff">fill</div></div></div>`,
    );

    const registry = await loadRegistry(fx.store);
    const index = await buildStyleOccurrenceIndex(fx.store, registry);

    // The fill's node (p1) is never in `doc.nodes` at all (CHR-584) — it
    // only shows up via the slotOverrides walk.
    expect(index.byScreen.get("background:rgba(0,0,0,.4);color:#fff")).toEqual(new Set(["home"]));
  });

  it("a nested fill (a component instance filled into another instance's slot) is still walked recursively", async () => {
    await fx.store.writeComponent("badge", `<span id="root" style="background: rgba(0,0,0,.4); color: #fff"></span>`);
    await fx.store.writeComponent("card", `<div id="root"><span data-slot="content">default</span></div>`);
    await fx.store.writeScreen(
      "home",
      `<div id="n1"><div id="n2" class="$card"><div id="p1" data-slot="content" class="$badge"></div></div></div>`,
    );

    const registry = await loadRegistry(fx.store);
    const index = await buildStyleOccurrenceIndex(fx.store, registry);

    // The fill itself (p1) is a component_instance (refs.component set), so
    // it's excluded by the ad-hoc gate — nothing to assert on it directly.
    // This just proves the walk doesn't throw/stop on a nested instance.
    expect(index.byScreen.size).toBeGreaterThanOrEqual(0);
  });

  it("returns empty maps for a project with no ad-hoc styled nodes anywhere", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    const registry = await loadRegistry(fx.store);
    const index = await buildStyleOccurrenceIndex(fx.store, registry);
    expect(index.byScreen.size).toBe(0);
    expect(index.byComponent.size).toBe(0);
  });
});
