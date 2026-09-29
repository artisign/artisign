import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { setMeta } from "./meta.js";
import { ToolError } from "./types.js";

describe("set_meta — screen target", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
  });
  afterEach(() => fx.cleanup());

  it("sets notes and tags on a fresh screen", async () => {
    const res = await setMeta(fx.store, { target: { kind: "screen", screen: "home" }, notes: "check contrast", tags: ["checkout", "wip"] });
    expect(res.meta).toEqual({ notes: "check contrast", tags: ["checkout", "wip"] });
    expect(await fx.store.readScreenMeta("home")).toEqual({ notes: "check contrast", tags: ["checkout", "wip"] });
  });

  it("setting notes keeps existing tags (merge, not replace)", async () => {
    await setMeta(fx.store, { target: { kind: "screen", screen: "home" }, tags: ["a", "b"] });
    const res = await setMeta(fx.store, { target: { kind: "screen", screen: "home" }, notes: "new note" });
    expect(res.meta).toEqual({ notes: "new note", tags: ["a", "b"] });
  });

  it("setting tags keeps the existing notes", async () => {
    await setMeta(fx.store, { target: { kind: "screen", screen: "home" }, notes: "keep me" });
    const res = await setMeta(fx.store, { target: { kind: "screen", screen: "home" }, tags: ["x"] });
    expect(res.meta).toEqual({ notes: "keep me", tags: ["x"] });
  });

  it("tags is a full replace, not a merge of arrays", async () => {
    await setMeta(fx.store, { target: { kind: "screen", screen: "home" }, tags: ["a", "b"] });
    const res = await setMeta(fx.store, { target: { kind: "screen", screen: "home" }, tags: ["c"] });
    expect(res.meta).toEqual({ notes: "", tags: ["c"] });
  });

  it("throws not_found for a screen that doesn't exist", async () => {
    await expect(setMeta(fx.store, { target: { kind: "screen", screen: "nope" }, notes: "x" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("throws validation_failed when neither notes nor tags is given (would rewrite unchanged and create a junk commit)", async () => {
    await expect(setMeta(fx.store, { target: { kind: "screen", screen: "home" } })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("throws validation_failed when a design_system/component/pattern/mockup field is set on a screen target", async () => {
    await expect(setMeta(fx.store, { target: { kind: "screen", screen: "home" }, idea: "x" } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "screen", screen: "home" }, usage: "x" } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "screen", screen: "home" }, title: "x" } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "screen", screen: "home" }, description: "x" } as never)).rejects.toThrow(ToolError);
  });

  it("commits with a set_meta message including the target", async () => {
    const config = await fx.store.readArtisignConfig();
    config.settings.autoCommit = true;
    await fx.store.writeArtisignConfig(config);

    const res = await setMeta(fx.store, { target: { kind: "screen", screen: "home" }, notes: "x" });
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("set_meta — mockup target", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeMockupMeta("hero-options", { variants: [{ id: "a", title: "A", description: "" }] });
  });
  afterEach(() => fx.cleanup());

  it("sets tags on a mockup", async () => {
    const res = await setMeta(fx.store, { target: { kind: "mockup", mockup: "hero-options" }, tags: ["checkout", "wip"] });
    expect(res.meta).toEqual({ tags: ["checkout", "wip"] });
    expect((await fx.store.readMockupMeta("hero-options")).tags).toEqual(["checkout", "wip"]);
  });

  it("sets title and description on a mockup", async () => {
    const res = await setMeta(fx.store, { target: { kind: "mockup", mockup: "hero-options" }, title: "Hero options", description: "three directions" });
    expect(res.meta).toEqual({ tags: [], title: "Hero options", description: "three directions" });
  });

  it("setting tags keeps existing title/description (merge, not replace)", async () => {
    await setMeta(fx.store, { target: { kind: "mockup", mockup: "hero-options" }, title: "Hero options" });
    const res = await setMeta(fx.store, { target: { kind: "mockup", mockup: "hero-options" }, tags: ["a"] });
    expect(res.meta).toEqual({ tags: ["a"], title: "Hero options" });
  });

  it("tags is a full replace, not a merge of arrays", async () => {
    await setMeta(fx.store, { target: { kind: "mockup", mockup: "hero-options" }, tags: ["a", "b"] });
    const res = await setMeta(fx.store, { target: { kind: "mockup", mockup: "hero-options" }, tags: ["c"] });
    expect(res.meta).toEqual({ tags: ["c"] });
  });

  it("does not disturb existing variants", async () => {
    await setMeta(fx.store, { target: { kind: "mockup", mockup: "hero-options" }, tags: ["x"] });
    expect((await fx.store.readMockupMeta("hero-options")).variants).toEqual([{ id: "a", title: "A", description: "" }]);
  });

  it("throws not_found for a mockup that doesn't exist", async () => {
    await expect(setMeta(fx.store, { target: { kind: "mockup", mockup: "nope" }, tags: ["x"] })).rejects.toMatchObject({ code: "not_found" });
  });

  it("throws validation_failed when neither tags, title nor description is given (would rewrite unchanged and create a junk commit)", async () => {
    await expect(setMeta(fx.store, { target: { kind: "mockup", mockup: "hero-options" } })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("throws validation_failed when a screen/design_system/component field is set on a mockup target", async () => {
    await expect(setMeta(fx.store, { target: { kind: "mockup", mockup: "hero-options" }, notes: "x", tags: ["y"] } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "mockup", mockup: "hero-options" }, idea: "x", tags: ["y"] } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "mockup", mockup: "hero-options" }, usage: "x", tags: ["y"] } as never)).rejects.toThrow(ToolError);
  });

  it("commits with a set_meta message including the target", async () => {
    const config = await fx.store.readArtisignConfig();
    config.settings.autoCommit = true;
    await fx.store.writeArtisignConfig(config);

    const res = await setMeta(fx.store, { target: { kind: "mockup", mockup: "hero-options" }, tags: ["x"] });
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("set_meta — design_system target", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("sets idea", async () => {
    const res = await setMeta(fx.store, { target: { kind: "design_system" }, idea: "consistent, calm checkout" });
    expect(res.meta).toEqual({ idea: "consistent, calm checkout", decisions: [] });
  });

  it("decision defaults: date to today (ISO), status to active", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await setMeta(fx.store, {
      target: { kind: "design_system" },
      decisions: [{ id: "d1", title: "single page checkout", body: "fewer steps" }],
    });
    expect(res.meta).toEqual({
      idea: "",
      decisions: [{ id: "d1", date: today, title: "single page checkout", body: "fewer steps", status: "active" }],
    });
  });

  it("honors an explicit date and status", async () => {
    const res = await setMeta(fx.store, {
      target: { kind: "design_system" },
      decisions: [{ id: "d1", date: "2025-01-01", title: "old approach", body: "superseded now", status: "superseded" }],
    });
    const decisions = res.meta as { decisions: Array<{ date: string; status: string }> };
    expect(decisions.decisions[0]).toMatchObject({ date: "2025-01-01", status: "superseded" });
  });

  it("decisions is a full replace, not an append", async () => {
    await setMeta(fx.store, { target: { kind: "design_system" }, decisions: [{ id: "d1", title: "a", body: "a" }] });
    const res = await setMeta(fx.store, { target: { kind: "design_system" }, decisions: [{ id: "d2", title: "b", body: "b" }] });
    const decisions = res.meta as { decisions: Array<{ id: string }> };
    expect(decisions.decisions.map((d) => d.id)).toEqual(["d2"]);
  });

  it("setting idea keeps existing decisions", async () => {
    await setMeta(fx.store, { target: { kind: "design_system" }, decisions: [{ id: "d1", title: "a", body: "a" }] });
    const res = await setMeta(fx.store, { target: { kind: "design_system" }, idea: "new idea" });
    const decisions = res.meta as { decisions: Array<{ id: string }> };
    expect(decisions.decisions.map((d) => d.id)).toEqual(["d1"]);
  });

  it("throws validation_failed when a screen/component/pattern/mockup field is set on a design_system target", async () => {
    await expect(setMeta(fx.store, { target: { kind: "design_system" }, notes: "x" } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "design_system" }, tags: ["x"] } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "design_system" }, usage: "x" } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "design_system" }, title: "x" } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "design_system" }, description: "x" } as never)).rejects.toThrow(ToolError);
  });

  it("throws validation_failed when neither idea nor decisions is given (would rewrite unchanged and create a junk commit)", async () => {
    await expect(setMeta(fx.store, { target: { kind: "design_system" } })).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("set_meta — tag target", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("sets notes on a tag no screen carries yet — deliberately no not_found check", async () => {
    const res = await setMeta(fx.store, { target: { kind: "tag", tag: "chr-244" }, notes: "spec lives here" });
    expect(res.meta).toEqual({ notes: "spec lives here" });
    expect(await fx.store.readTagMeta("chr-244")).toEqual({ notes: "spec lives here" });
  });

  it("notes is a full replace, not an append", async () => {
    await setMeta(fx.store, { target: { kind: "tag", tag: "chr-244" }, notes: "first draft" });
    const res = await setMeta(fx.store, { target: { kind: "tag", tag: "chr-244" }, notes: "revised" });
    expect(res.meta).toEqual({ notes: "revised" });
  });

  it("lowercases the tag name on disk (CHR-244 and chr-244 are the same document)", async () => {
    await setMeta(fx.store, { target: { kind: "tag", tag: "CHR-244" }, notes: "upper" });
    expect(await fx.store.readTagMeta("chr-244")).toEqual({ notes: "upper" });
  });

  it("throws validation_failed when notes is missing", async () => {
    await expect(setMeta(fx.store, { target: { kind: "tag", tag: "chr-244" } })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("throws validation_failed when a screen/mockup/design_system/component field is set on a tag target", async () => {
    await expect(setMeta(fx.store, { target: { kind: "tag", tag: "chr-244" }, tags: ["x"], notes: "y" } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "tag", tag: "chr-244" }, title: "x", notes: "y" } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "tag", tag: "chr-244" }, idea: "x", notes: "y" } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "tag", tag: "chr-244" }, usage: "x", notes: "y" } as never)).rejects.toThrow(ToolError);
  });

  it("throws validation_failed for a tag name that fails assertValidTagName", async () => {
    await expect(setMeta(fx.store, { target: { kind: "tag", tag: "not a tag" }, notes: "x" })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("commits with a set_meta message including the target", async () => {
    const config = await fx.store.readArtisignConfig();
    config.settings.autoCommit = true;
    await fx.store.writeArtisignConfig(config);

    const res = await setMeta(fx.store, { target: { kind: "tag", tag: "chr-244" }, notes: "x" });
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("set_meta — component/pattern target", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeComponent("btn-primary", `<button id="n1">Go</button>`);
    await fx.store.writePattern("card-grid", `<div id="n1"></div>`);
  });
  afterEach(() => fx.cleanup());

  it("sets usage on a component", async () => {
    const res = await setMeta(fx.store, { target: { kind: "component", name: "btn-primary" }, usage: "primary CTAs only" });
    expect(res.meta).toEqual({ usage: "primary CTAs only" });
    expect((await fx.store.readDesignSystemMeta()).component_usage).toEqual({ "btn-primary": "primary CTAs only" });
  });

  it("sets usage on a pattern", async () => {
    const res = await setMeta(fx.store, { target: { kind: "pattern", name: "card-grid" }, usage: "gallery/listing layouts" });
    expect(res.meta).toEqual({ usage: "gallery/listing layouts" });
    expect((await fx.store.readDesignSystemMeta()).pattern_usage).toEqual({ "card-grid": "gallery/listing layouts" });
  });

  it("throws not_found for an unknown component/pattern name", async () => {
    await expect(setMeta(fx.store, { target: { kind: "component", name: "nope" }, usage: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(setMeta(fx.store, { target: { kind: "pattern", name: "nope" }, usage: "x" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("throws validation_failed when usage is missing", async () => {
    await expect(setMeta(fx.store, { target: { kind: "component", name: "btn-primary" } })).rejects.toThrow(ToolError);
  });

  it("throws validation_failed when a screen/design_system/mockup field is set on a component target", async () => {
    await expect(setMeta(fx.store, { target: { kind: "component", name: "btn-primary" }, notes: "x", usage: "y" } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "component", name: "btn-primary" }, idea: "x", usage: "y" } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "component", name: "btn-primary" }, title: "x", usage: "y" } as never)).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "component", name: "btn-primary" }, description: "x", usage: "y" } as never)).rejects.toThrow(ToolError);
  });
});

describe("set_meta — a screen tag has to be a usable tag name (CHR-596)", () => {
  let fx: ProjectFixture;
  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
  });
  afterEach(() => fx.cleanup());

  it("refuses a screen tag that could not be a filename", async () => {
    // A tag is tags/<tag>.meta.json now. Unvalidated, this would be written
    // happily and then break every later get_screen on this screen.
    await expect(setMeta(fx.store, { target: { kind: "screen", screen: "home" }, tags: ["../../evil"] })).rejects.toThrow(ToolError);
    await expect(setMeta(fx.store, { target: { kind: "screen", screen: "home" }, tags: ["has space"] })).rejects.toThrow(ToolError);
    expect((await fx.store.readScreenMeta("home")).tags).toEqual([]);
  });

  it("still accepts the ordinary ones", async () => {
    await setMeta(fx.store, { target: { kind: "screen", screen: "home" }, tags: ["chr-244", "empty-state", "design-system"] });
    expect((await fx.store.readScreenMeta("home")).tags).toEqual(["chr-244", "empty-state", "design-system"]);
  });
});

describe("set_meta — screen variants (ADR-006)", () => {
  let fx: ProjectFixture;
  const target = (screen: string) => ({ kind: "screen" as const, screen });

  beforeEach(async () => {
    fx = await setupProject();
    for (const name of ["main", "child", "grandchild", "other"]) await fx.store.writeScreen(name, `<div id="n1"></div>`);
  });
  afterEach(() => fx.cleanup());

  /** Asserts the call rejected with `code`, wrote no sidecar and made no commit. */
  async function expectRejected(input: Parameters<typeof setMeta>[1], code: string, screens: string[]): Promise<void> {
    const before = await Promise.all(screens.map((n) => fx.store.readScreenMeta(n)));
    const commit = vi.spyOn(fx.store, "commit");
    const write = vi.spyOn(fx.store, "writeScreenMeta");
    await expect(setMeta(fx.store, input)).rejects.toMatchObject({ code });
    expect(commit).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await Promise.all(screens.map((n) => fx.store.readScreenMeta(n)))).toEqual(before);
    vi.restoreAllMocks();
  }

  it("sets both fields and echoes them", async () => {
    const res = await setMeta(fx.store, { target: target("child"), variant_of: "main", variant_kind: "state" });
    expect(res.meta).toEqual({ notes: "", tags: [], variant_of: "main", variant_kind: "state" });
    expect(await fx.store.readScreenMeta("child")).toEqual({ notes: "", tags: [], variant_of: "main", variant_kind: "state" });
  });

  it("rejects a missing parent", async () => {
    await expectRejected({ target: target("child"), variant_of: "nope", variant_kind: "state" }, "not_found", ["child"]);
  });

  it("rejects a self-reference", async () => {
    await expectRejected({ target: target("child"), variant_of: "child", variant_kind: "state" }, "validation_failed", ["child"]);
  });

  it("rejects a direct cycle", async () => {
    await setMeta(fx.store, { target: target("child"), variant_of: "main", variant_kind: "state" });
    await expectRejected({ target: target("main"), variant_of: "child", variant_kind: "step" }, "validation_failed", ["main", "child"]);
  });

  it("rejects a deep cycle by re-parenting onto a grandchild", async () => {
    await setMeta(fx.store, { target: target("child"), variant_of: "main", variant_kind: "state" });
    await setMeta(fx.store, { target: target("grandchild"), variant_of: "child", variant_kind: "overlay" });
    await expectRejected({ target: target("main"), variant_of: "grandchild", variant_kind: "step" }, "validation_failed", ["main", "child", "grandchild"]);
  });

  it("rejects variant_of without a kind, on the call and stored", async () => {
    await expectRejected({ target: target("child"), variant_of: "main" }, "validation_failed", ["child"]);
  });

  it("rejects variant_kind on a screen with no parent", async () => {
    await expectRejected({ target: target("child"), variant_kind: "state" }, "validation_failed", ["child"]);
  });

  it("rejects clearing the parent while passing a kind", async () => {
    await expectRejected({ target: target("child"), variant_of: null, variant_kind: "state" }, "validation_failed", ["child"]);
  });

  it("rejects an invalid kind", async () => {
    await expectRejected({ target: target("child"), variant_of: "main", variant_kind: "bogus" }, "validation_failed", ["child"]);
  });

  it("allows changing only the kind of an existing variant", async () => {
    await setMeta(fx.store, { target: target("child"), variant_of: "main", variant_kind: "state" });
    const res = await setMeta(fx.store, { target: target("child"), variant_kind: "overlay" });
    expect(res.meta).toEqual({ notes: "", tags: [], variant_of: "main", variant_kind: "overlay" });
  });

  it("allows re-parenting to a non-descendant", async () => {
    await setMeta(fx.store, { target: target("child"), variant_of: "main", variant_kind: "state" });
    const res = await setMeta(fx.store, { target: target("child"), variant_of: "other" });
    expect(res.meta).toMatchObject({ variant_of: "other", variant_kind: "state" });
  });

  it("clearing variant_of removes both fields from the sidecar and the response", async () => {
    await setMeta(fx.store, { target: target("child"), variant_of: "main", variant_kind: "state" });
    const res = await setMeta(fx.store, { target: target("child"), variant_of: null });
    expect(res.meta).toEqual({ notes: "", tags: [] });
    expect(await fx.store.readScreenMeta("child")).toEqual({ notes: "", tags: [] });
  });

  it("setting notes/tags on a variant keeps both fields", async () => {
    await setMeta(fx.store, { target: target("child"), variant_of: "main", variant_kind: "step" });
    await setMeta(fx.store, { target: target("child"), notes: "n" });
    const res = await setMeta(fx.store, { target: target("child"), tags: ["t"] });
    expect(res.meta).toEqual({ notes: "n", tags: ["t"], variant_of: "main", variant_kind: "step" });
  });

  it("rejects variant fields on a non-screen target", async () => {
    await expect(setMeta(fx.store, { target: { kind: "tag", tag: "x" }, notes: "n", variant_of: "main" })).rejects.toMatchObject({ code: "validation_failed" });
  });
});
