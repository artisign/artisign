import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
