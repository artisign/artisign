import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { writeMockup, getMockup, promoteMockup, deleteMockupEntity } from "./mockups.js";
import { ToolError } from "./types.js";

describe("write_mockup", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("creates a mockup dir + variant on the first write", async () => {
    const res = await writeMockup(fx.store, { mockup: "hero-options", variant: "a", mode: "create", html: "<div>A</div>" });
    expect(res).toMatchObject({ mockup: "hero-options", variant: "a", path: "mockups/hero-options/a.html", variant_count: 1 });
    expect(await fx.store.readMockupVariant("hero-options", "a")).toBe("<div>A</div>");
    expect(await fx.store.readMockupMeta("hero-options")).toEqual({
      variants: [{ id: "a", title: "a", description: "" }],
    });
  });

  it("title defaults to the variant id; description defaults to empty", async () => {
    await writeMockup(fx.store, { mockup: "m", variant: "b", mode: "create", html: "<div></div>" });
    const meta = await fx.store.readMockupMeta("m");
    expect(meta.variants).toEqual([{ id: "b", title: "b", description: "" }]);
  });

  it("honors an explicit title/description on create", async () => {
    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", title: "Toggle", description: "single toggle", html: "<div></div>" });
    const meta = await fx.store.readMockupMeta("m");
    expect(meta.variants).toEqual([{ id: "a", title: "Toggle", description: "single toggle" }]);
  });

  it("create requires html", async () => {
    await expect(writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create" })).rejects.toMatchObject({ code: "validation_failed" });
    expect(await fx.store.listMockups()).toEqual([]);
  });

  it("create conflicts on an existing variant", async () => {
    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", html: "<div>1</div>" });
    await expect(writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", html: "<div>2</div>" })).rejects.toMatchObject({ code: "conflict" });
    expect(await fx.store.readMockupVariant("m", "a")).toBe("<div>1</div>");
  });

  it("create conflicts on an orphan variant file even when mockup.json doesn't list it", async () => {
    // Simulates mockup.json having lost track of a variant (hand-edited/
    // deleted) while the html file itself is still on disk.
    await fx.store.writeMockupVariant("m", "a", "<div>orphan</div>");

    await expect(writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", html: "<div>overwrite</div>" })).rejects.toMatchObject({ code: "conflict" });
    expect(await fx.store.readMockupVariant("m", "a")).toBe("<div>orphan</div>");
  });

  it("replace not_found on a missing mockup or variant", async () => {
    await expect(writeMockup(fx.store, { mockup: "nope", variant: "a", mode: "replace", html: "<div></div>" })).rejects.toMatchObject({ code: "not_found" });

    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", html: "<div></div>" });
    await expect(writeMockup(fx.store, { mockup: "m", variant: "b", mode: "replace", html: "<div></div>" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("replace rewrites the html and preserves array order across multiple variants", async () => {
    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", html: "<div>A</div>" });
    await writeMockup(fx.store, { mockup: "m", variant: "b", mode: "create", html: "<div>B</div>" });
    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "replace", html: "<div>A2</div>" });

    expect(await fx.store.readMockupVariant("m", "a")).toBe("<div>A2</div>");
    const meta = await fx.store.readMockupMeta("m");
    expect(meta.variants.map((v) => v.id)).toEqual(["a", "b"]);
  });

  it("meta-only replace (no html) keeps the existing html untouched", async () => {
    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", title: "Old", html: "<div>original</div>" });
    const res = await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "replace", title: "New title" });

    expect(res.variant_count).toBe(1);
    expect(await fx.store.readMockupVariant("m", "a")).toBe("<div>original</div>");
    const meta = await fx.store.readMockupMeta("m");
    expect(meta.variants).toEqual([{ id: "a", title: "New title", description: "" }]);
  });

  it("rejects invalid mockup/variant names", async () => {
    await expect(writeMockup(fx.store, { mockup: "bad name", variant: "a", mode: "create", html: "<div></div>" })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(writeMockup(fx.store, { mockup: "m", variant: "bad/id", mode: "create", html: "<div></div>" })).rejects.toMatchObject({ code: "validation_failed" });
    expect(await fx.store.listMockups()).toEqual([]);
  });

  it("commits with a write_mockup message naming mockup and variant", async () => {
    const config = await fx.store.readArtisignConfig();
    config.settings.autoCommit = true;
    await fx.store.writeArtisignConfig(config);

    const res = await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", html: "<div></div>" });
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("get_mockup", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await writeMockup(fx.store, { mockup: "hero-options", variant: "a", mode: "create", title: "Toggle", description: "single toggle", html: "<div>A</div>" });
    await writeMockup(fx.store, { mockup: "hero-options", variant: "b", mode: "create", title: "Radio", description: "explicit choice", html: "<div>B</div>" });
  });
  afterEach(() => fx.cleanup());

  it("summary omits html per variant", async () => {
    const res = await getMockup(fx.store, { mockup: "hero-options" });
    expect(res).toMatchObject({ mockup: "hero-options", path: "mockups/hero-options/mockup.json", variant_count: 2 });
    expect(res.variants).toEqual([
      { id: "a", title: "Toggle", description: "single toggle" },
      { id: "b", title: "Radio", description: "explicit choice" },
    ]);
  });

  it("full includes html per variant", async () => {
    const res = await getMockup(fx.store, { mockup: "hero-options", view: "full" });
    expect(res.variants).toEqual([
      { id: "a", title: "Toggle", description: "single toggle", html: "<div>A</div>" },
      { id: "b", title: "Radio", description: "explicit choice", html: "<div>B</div>" },
    ]);
  });

  it("a variant filter returns only that one", async () => {
    const res = await getMockup(fx.store, { mockup: "hero-options", variant: "b", view: "full" });
    expect(res.variant_count).toBe(2); // still the mockup's total, not the filtered count
    expect(res.variants).toEqual([{ id: "b", title: "Radio", description: "explicit choice", html: "<div>B</div>" }]);
  });

  it("summary and full both default tags to an empty array", async () => {
    const summary = await getMockup(fx.store, { mockup: "hero-options" });
    expect(summary.tags).toEqual([]);
    const full = await getMockup(fx.store, { mockup: "hero-options", view: "full" });
    expect(full.tags).toEqual([]);
  });

  it("reports tags set via set_meta", async () => {
    await fx.store.writeMockupMeta("hero-options", { ...(await fx.store.readMockupMeta("hero-options")), tags: ["checkout"] });
    const res = await getMockup(fx.store, { mockup: "hero-options" });
    expect(res.tags).toEqual(["checkout"]);
  });

  it("not_found for an unknown mockup", async () => {
    await expect(getMockup(fx.store, { mockup: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("not_found for an unknown variant", async () => {
    await expect(getMockup(fx.store, { mockup: "hero-options", variant: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("promote_mockup", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("promotes a variant into a new screen, returning writeHtml's response plus mockup/variant", async () => {
    await writeMockup(fx.store, { mockup: "hero-options", variant: "a", mode: "create", title: "Toggle variant", html: `<div id="n1">A</div>` });

    const res = await promoteMockup(fx.store, { mockup: "hero-options", variant: "a", screen: "hero" });
    expect(res).toMatchObject({ mockup: "hero-options", variant: "a", screen: "hero", path: "screens/hero.html" });
    expect(res.root_node_id).toBeDefined();
    expect(await fx.store.listScreens()).toEqual(["hero"]);
  });

  it("title defaults to the variant's own title", async () => {
    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", title: "My title", html: `<div id="n1"></div>` });
    await promoteMockup(fx.store, { mockup: "m", variant: "a", screen: "s1" });
    const html = await fx.store.readScreen("s1");
    expect(html).toContain('data-title="My title"');
  });

  it("an explicit title overrides the variant's title", async () => {
    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", title: "Variant title", html: `<div id="n1"></div>` });
    await promoteMockup(fx.store, { mockup: "m", variant: "a", screen: "s1", title: "Explicit title" });
    const html = await fx.store.readScreen("s1");
    expect(html).toContain('data-title="Explicit title"');
  });

  it("not_found for an unknown mockup or variant", async () => {
    await expect(promoteMockup(fx.store, { mockup: "nope", variant: "a", screen: "s1" })).rejects.toMatchObject({ code: "not_found" });

    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", html: `<div id="n1"></div>` });
    await expect(promoteMockup(fx.store, { mockup: "m", variant: "nope", screen: "s1" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("promotes <style> + <div> by moving the style into the root, rendering like the mockup", async () => {
    await writeMockup(fx.store, {
      mockup: "m",
      variant: "a",
      mode: "create",
      html: `<style>.x > b{color:red}</style>\n<div id="n1"><b class="x">hi</b></div>`,
    });

    const res = await promoteMockup(fx.store, { mockup: "m", variant: "a", screen: "s1" });
    expect(res.errors).toBeUndefined();
    expect(res.warnings).toEqual([expect.objectContaining({ kind: "mockup_normalized" })]);
    const html = await fx.store.readScreen("s1");
    expect(html).toMatch(/^<div id="n1"[^>]*><style id="[^"]+">\.x > b\{color:red\}<\/style><b /);
  });

  it("promotes a full <html> document: head styles + body content, head metadata dropped", async () => {
    await writeMockup(fx.store, {
      mockup: "m",
      variant: "a",
      mode: "create",
      html:
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>T</title><style>.a{color:red}</style></head>` +
        `<body><style>.b{color:blue}</style><section id="hero"><p class="a b">hi</p></section><script>alert(1)</script></body></html>`,
    });

    const res = await promoteMockup(fx.store, { mockup: "m", variant: "a", screen: "s1" });
    expect(res.errors).toBeUndefined();
    const html = await fx.store.readScreen("s1");
    expect(html).toMatch(/^<section id="hero"[^>]*><style[^>]*>\.a\{color:red\}<\/style><style[^>]*>\.b\{color:blue\}<\/style><p /);
    expect(html).not.toContain("alert");
    expect(html).not.toContain("<meta");
    expect(res.warnings).toContainEqual(expect.objectContaining({ kind: "mockup_normalized", message: expect.stringContaining("script") }));
  });

  it("wraps several top-level nodes in one <div> root", async () => {
    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", html: `<style>.a{color:red}</style><h1 id="h">A</h1><p id="p">B</p>` });

    const res = await promoteMockup(fx.store, { mockup: "m", variant: "a", screen: "s1" });
    expect(res.errors).toBeUndefined();
    const html = await fx.store.readScreen("s1");
    expect(html).toMatch(/^<div id="[^"]+"[^>]*><style[^>]*>\.a\{color:red\}<\/style><h1 id="h">A<\/h1><p id="p">B<\/p><\/div>$/);
    expect(res.warnings).toContainEqual(expect.objectContaining({ kind: "mockup_normalized" }));
  });

  it("wraps top-level text together with an element", async () => {
    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", html: `hello <b id="b">x</b>` });
    const res = await promoteMockup(fx.store, { mockup: "m", variant: "a", screen: "s1" });
    expect(res.errors).toBeUndefined();
    expect(await fx.store.readScreen("s1")).toMatch(/^<div [^>]*>hello <b id="b">x<\/b><\/div>$/);
  });

  it("a single-root variant without styles is written unchanged, with no normalization warning", async () => {
    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", html: `<div id="n1"><p id="n2">x</p></div>` });
    const res = await promoteMockup(fx.store, { mockup: "m", variant: "a", screen: "s1" });
    expect(res.warnings).toEqual([]);
    expect(await fx.store.readScreen("s1")).toBe(`<div id="n1" data-title="a"><p id="n2">x</p></div>`);
  });

  it("carries <body> style and class onto a wrapping <div> root and names other body/html attributes as dropped", async () => {
    await writeMockup(fx.store, {
      mockup: "m",
      variant: "a",
      mode: "create",
      html:
        `<html lang="de"><head><style>.a{color:red}</style></head>` +
        `<body style="background: #eee" class="page" onload="go()"><section id="hero"><p class="a">hi</p></section></body></html>`,
    });

    const res = await promoteMockup(fx.store, { mockup: "m", variant: "a", screen: "s1" });
    expect(res.errors).toBeUndefined();
    const html = await fx.store.readScreen("s1");
    expect(html).toMatch(/^<div [^>]*class="page"[^>]*><style[^>]*>\.a\{color:red\}<\/style><section id="hero"/);
    expect(html).toContain("background: #eee");
    expect(html).not.toContain("onload");
    const message = (res.warnings as { message: string }[])[0]?.message;
    expect(message).toContain("<body onload>");
    expect(message).toContain("<html lang>");
  });

  it("a script-only variant is dropped down to an empty <div> root, with a warning", async () => {
    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", html: `<script>x()</script>` });
    const res = await promoteMockup(fx.store, { mockup: "m", variant: "a", screen: "s1" });
    expect(res.errors).toBeUndefined();
    expect(await fx.store.readScreen("s1")).not.toContain("script");
    expect(res.warnings).toContainEqual(expect.objectContaining({ kind: "mockup_normalized" }));
  });

  it("an empty variant surfaces as malformed_html and writes nothing", async () => {
    await writeMockup(fx.store, { mockup: "m", variant: "a", mode: "create", html: "  " });
    const res = await promoteMockup(fx.store, { mockup: "m", variant: "a", screen: "s1" });
    expect(res.errors).toMatchObject([{ code: "malformed_html" }]);
    expect(await fx.store.listScreens()).toEqual([]);
  });

  it("an unresolved token ref surfaces as a warning, same as a direct write_html call", async () => {
    await writeMockup(fx.store, {
      mockup: "m",
      variant: "a",
      mode: "create",
      html: `<div id="n1" style="color: $color.nope"></div>`,
    });

    const res = await promoteMockup(fx.store, { mockup: "m", variant: "a", screen: "s1" });
    expect(res.warnings).toContainEqual(expect.objectContaining({ kind: "unknown_ref" }));
    expect(await fx.store.listScreens()).toEqual(["s1"]);
  });
});

describe("delete_entity kind:\"mockup\" (deleteMockupEntity)", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await writeMockup(fx.store, { mockup: "hero-options", variant: "a", mode: "create", html: "<div>A</div>" });
    await writeMockup(fx.store, { mockup: "hero-options", variant: "b", mode: "create", html: "<div>B</div>" });
  });
  afterEach(() => fx.cleanup());

  it("deletes a single variant, splicing the meta and keeping the rest", async () => {
    const res = await deleteMockupEntity(fx.store, "hero-options", "a");
    expect(res).toMatchObject({ kind: "mockup", name: "hero-options", variant: "a", remaining_variant_count: 1 });
    const meta = await fx.store.readMockupMeta("hero-options");
    expect(meta.variants.map((v) => v.id)).toEqual(["b"]);
    await expect(fx.store.readMockupVariant("hero-options", "a")).rejects.toThrow();
  });

  it("deletes the last variant, leaving an empty (but present) mockup", async () => {
    await deleteMockupEntity(fx.store, "hero-options", "a");
    const res = await deleteMockupEntity(fx.store, "hero-options", "b");
    expect(res.remaining_variant_count).toBe(0);
    const meta = await fx.store.readMockupMeta("hero-options");
    expect(meta.variants).toEqual([]);
  });

  it("deletes the whole mockup directory", async () => {
    const res = await deleteMockupEntity(fx.store, "hero-options");
    expect(res).toMatchObject({ kind: "mockup", name: "hero-options" });
    expect(res).not.toHaveProperty("variant");
    expect(await fx.store.listMockups()).toEqual([]);
  });

  it("deletes an orphan mockup dir (variant html present, mockup.json missing) — review fix 1", async () => {
    await fx.store.writeMockupVariant("orphan", "a", "<div></div>");
    // No writeMockupMeta call — mockup.json never landed for this one.

    const res = await deleteMockupEntity(fx.store, "orphan");
    expect(res).toMatchObject({ kind: "mockup", name: "orphan" });
    expect(await fx.store.listMockups()).not.toContain("orphan");
  });

  it("not_found for an unknown mockup", async () => {
    await expect(deleteMockupEntity(fx.store, "nope")).rejects.toBeInstanceOf(ToolError);
    await expect(deleteMockupEntity(fx.store, "nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("not_found for an unknown variant", async () => {
    await expect(deleteMockupEntity(fx.store, "hero-options", "nope")).rejects.toMatchObject({ code: "not_found" });
  });
});
