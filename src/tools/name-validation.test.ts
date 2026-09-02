import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { writeHtml } from "./writes.js";
import { importHtml, promoteToSystem, initProjectTool } from "./lifecycle.js";
import { assertValidEntityName, assertValidVariantName } from "./name-validation.js";

describe("assertValidEntityName", () => {
  it.each([":", "#", "."])('rejects a name containing "%s"', (char) => {
    expect(() => assertValidEntityName("screen", `home${char}x`)).toThrowError(
      expect.objectContaining({ code: "validation_failed" }),
    );
  });

  it("accepts the names the example project ships", () => {
    for (const name of ["new-note", "notes", "welcome"]) assertValidEntityName("screen", name);
    assertValidEntityName("component", "btn-primary");
    assertValidEntityName("pattern", "card_grid");
  });
});

describe("assertValidVariantName", () => {
  it.each([":", "#", ".", '"', "<", ">", "&"])('rejects a variant name containing "%s"', (char) => {
    expect(() => assertValidVariantName(`hov${char}er`)).toThrowError(expect.objectContaining({ code: "validation_failed" }));
  });

  it("rejects an empty name and one carrying whitespace — neither survives a #variant address", () => {
    expect(() => assertValidVariantName("")).toThrowError(expect.objectContaining({ code: "validation_failed" }));
    expect(() => assertValidVariantName("size lg")).toThrowError(expect.objectContaining({ code: "validation_failed" }));
  });

  it("accepts ordinary variant names unchanged", () => {
    for (const name of ["default", "hover", "disabled", "size-lg", "dark_mode", "v2"]) assertValidVariantName(name);
  });
});

describe("variant names at both doors (CHR-556)", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<div id="card"><h3 id="t">T</h3></div>`);
  });
  afterEach(() => fx.cleanup());

  it.each([`ho"ver`, "hov<er", "hov>er", "hov:er", "hov#er", "hov.er"])(
    "promote_to_system rejects variant %j with validation_failed and writes nothing",
    async (variant) => {
      await expect(
        promoteToSystem(fx.store, { node: "home.card", kind: "component", name: "card", variants: [variant] }),
      ).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("variant name") });
      expect(await fx.store.listComponents()).not.toContain("card");
      expect(await fx.store.readScreen("home")).not.toContain("$card");
    },
  );

  // The CHR-555 review case, in the shape that used to slip through: the
  // injected markup manufactures a *distinct* second variant, so the
  // duplicate check never fired and two templates the caller never asked for
  // reached the file.
  it("promote_to_system rejects a markup injection that manufactures a distinct variant", async () => {
    await expect(
      promoteToSystem(fx.store, {
        node: "home.card",
        kind: "component",
        name: "card",
        variants: [`a"></template><template data-variant="hover`],
      }),
    ).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("variant name") });
    expect(await fx.store.listComponents()).not.toContain("card");
  });

  it("promote_to_system still accepts ordinary variant names", async () => {
    const res = await promoteToSystem(fx.store, {
      node: "home.card",
      kind: "component",
      name: "card",
      variants: ["hover", "disabled", "size-lg"],
    });
    expect(res).toMatchObject({ entity: { kind: "component", name: "card" } });
    const file = await fx.store.readComponent("card");
    for (const v of ["hover", "disabled", "size-lg"]) expect(file).toContain(`data-variant="${v}"`);
  });

  it.each(["hov#er", "hov:er", "hov.er", "size lg"])(
    "write_html rejects a definition whose data-variant is %j with validation_failed",
    async (variant) => {
      const res = await writeHtml(fx.store, {
        screen: "card",
        mode: "create",
        kind: "component",
        html_aug: `<div id="n1"><span id="n2" data-slot="label">T</span></div>\n<template data-variant="${variant}"><div id="n1"><span id="n2" data-slot="label">T</span></div></template>`,
      });
      expect(res).toMatchObject({ commit: null, errors: [{ code: "validation_failed", message: expect.stringContaining("variant name") }] });
      expect(await fx.store.listComponents()).not.toContain("card");
    },
  );

  it("write_html still accepts ordinary variant names", async () => {
    const res = await writeHtml(fx.store, {
      screen: "card",
      mode: "create",
      kind: "component",
      html_aug: `<div id="n1"><span id="n2" data-slot="label">T</span></div>\n<template data-variant="size-lg"><div id="n1"><span id="n2" data-slot="label">T</span></div></template>`,
    });
    expect(res).toMatchObject({ variants: ["default", "size-lg"] });
    expect(res).not.toHaveProperty("errors");
    expect(await fx.store.listComponents()).toContain("card");
  });
});

describe("reserved characters at every write entry point", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  const html_aug = `<section id="n1"><h1 id="n2">Hi</h1></section>`;

  it("rejects a screen name in write_html create", async () => {
    await expect(writeHtml(fx.store, { screen: "home.v2", mode: "create", title: "Home", html_aug })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects a component name in write_html create and replace", async () => {
    await expect(
      writeHtml(fx.store, { screen: "btn:primary", mode: "create", kind: "component", html_aug }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      writeHtml(fx.store, { screen: "btn#primary", mode: "replace", kind: "component", html_aug }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("rejects a pattern name in write_html", async () => {
    await expect(
      writeHtml(fx.store, { screen: "card.grid", mode: "create", kind: "pattern", html_aug }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("rejects a screen name in import_html", async () => {
    await expect(importHtml(fx.store, { source: { kind: "html", html_aug, screen: "landing#hero" } })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects a seed screen name in init_project — the fifth path, found in review", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artisign-init-"));
    try {
      await expect(
        initProjectTool({ dir, seed: { kind: "html", screen: "home.v2", html_aug } }),
      ).rejects.toMatchObject({ code: "validation_failed" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a component name in promote_to_system", async () => {
    await writeHtml(fx.store, { screen: "home", mode: "create", title: "Home", html_aug });
    await expect(
      promoteToSystem(fx.store, { node: "home.n2", kind: "component", name: "heading.large" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("still accepts a token dot-path in promote_to_system — token names are not node-ref names", async () => {
    await writeHtml(fx.store, {
      screen: "home",
      mode: "create",
      title: "Home",
      html_aug: `<section id="n1" style="color: #123456"><h1 id="n2">Hi</h1></section>`,
    });
    const res = await promoteToSystem(fx.store, { node: "home.n1", kind: "token", name: "color.brand" });
    expect(res).toMatchObject({ entity: { kind: "token", name: "$color.brand" } });
  });
});

/**
 * Guards against the four call sites drifting into four
 * independent regexes: every one of them must route through the shared
 * validator module.
 */
describe("all call sites share one validator", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("./name-validation.js");
    fx.cleanup();
  });

  it("calls assertValidEntityName from write_html, import_html and promote_to_system", async () => {
    const spy = vi.fn();
    const variantSpy = vi.fn();
    vi.doMock("./name-validation.js", () => ({ assertValidEntityName: spy, assertValidVariantName: variantSpy }));

    const writes = await import("./writes.js");
    const lifecycle = await import("./lifecycle.js");
    const html = `<section id="n1"><h1 id="n2">Hi</h1></section>`;

    await writes.writeHtml(fx.store, { screen: "home", mode: "create", title: "Home", html_aug: html });
    expect(spy).toHaveBeenCalledWith("screen", "home");

    await writes.writeHtml(fx.store, { screen: "btn-primary", mode: "create", kind: "component", html_aug: html });
    expect(spy).toHaveBeenCalledWith("component", "btn-primary");

    await lifecycle.importHtml(fx.store, { source: { kind: "html", html_aug: html, screen: "landing" }, dedupe: false });
    expect(spy).toHaveBeenCalledWith("screen", "landing");

    await lifecycle.promoteToSystem(fx.store, { node: "home.n2", kind: "component", name: "heading" });
    expect(spy).toHaveBeenCalledWith("component", "heading");
  });

  it("calls assertValidVariantName from write_html and promote_to_system — one rule, both doors", async () => {
    const variantSpy = vi.fn();
    vi.doMock("./name-validation.js", () => ({ assertValidEntityName: vi.fn(), assertValidVariantName: variantSpy }));

    const writes = await import("./writes.js");
    const lifecycle = await import("./lifecycle.js");

    await writes.writeHtml(fx.store, {
      screen: "btn-primary",
      mode: "create",
      kind: "component",
      html_aug: `<button id="n1">Go</button>\n<template data-variant="hover"><button id="n1">Go</button></template>`,
    });
    expect(variantSpy).toHaveBeenCalledWith("default");
    expect(variantSpy).toHaveBeenCalledWith("hover");

    await writes.writeHtml(fx.store, { screen: "home", mode: "create", title: "Home", html_aug: `<section id="n1"><h1 id="n2">Hi</h1></section>` });
    await lifecycle.promoteToSystem(fx.store, { node: "home.n2", kind: "component", name: "heading", variants: ["large"] });
    expect(variantSpy).toHaveBeenCalledWith("large");
  });
});
