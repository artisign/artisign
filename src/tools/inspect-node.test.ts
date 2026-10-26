import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupProject, estimateTokens, type ProjectFixture } from "./test-fixtures.js";
import { inspectNode } from "./inspect-node.js";
import { NO_BROWSER_MESSAGE, BROWSER_ENV, discoverBrowsers, selectBrowser } from "./browser.js";
import { __setBrowserForTests, __resetBrowserForTests, getBrowser } from "./browser.js";
import { FsStore } from "../store/index.js";
import { ToolError } from "./types.js";

function isBrowserAvailable(): boolean {
  return Boolean(process.env[BROWSER_ENV]) || discoverBrowsers().length > 0;
}

describe("inspectNode — validation (no browser needed)", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
  });
  afterEach(() => fx.cleanup());

  it("rejects a malformed node ref", async () => {
    await expect(inspectNode(fx.store, { node: "not-qualified" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects an unknown screen", async () => {
    await expect(inspectNode(fx.store, { node: "does-not-exist.n1" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("an unknown screen that names a component hints the definition ref with the requested node id (CHR-930)", async () => {
    await fx.store.writeComponent("eyebrow", `<span id="e"><b id="label">x</b></span>`);
    const err = await inspectNode(fx.store, { node: "eyebrow.label" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "not_found" });
    expect((err as Error).message).toContain('address it by its own node ref: "component:eyebrow#default.label"');
    expect((err as Error).message).not.toMatch(/without screen/);
  });

  it("rejects an unknown node id without needing the browser", async () => {
    await expect(inspectNode(fx.store, { node: "home.does-not-exist" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(inspectNode(fx.store, { node: "home.does-not-exist" })).rejects.toBeInstanceOf(ToolError);
  });

  it("rejects a component/pattern ref naming a definition that doesn't exist, without needing the browser", async () => {
    await expect(inspectNode(fx.store, { node: "component:does-not-exist#default.n1" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(inspectNode(fx.store, { node: "pattern:does-not-exist.n1" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("inspectNode — no usable browser", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
  });
  afterEach(() => {
    fx.cleanup();
    __setBrowserForTests(undefined);
  });

  it("throws a ToolError naming the remedy when no browser is installed", async () => {
    __setBrowserForTests({ select: (kind) => selectBrowser(kind, { platform: "linux", env: { PATH: "/usr/bin" }, exists: () => false }) });

    await expect(inspectNode(fx.store, { node: "home.n1" })).rejects.toMatchObject({
      code: "io_error",
      message: NO_BROWSER_MESSAGE,
    });
  });
});

describe.skipIf(!isBrowserAvailable())("inspectNode — e2e (installed browser)", () => {
  let dir: string;
  let store: FsStore;

  // The first launch reads the browser from a cold disk (CHR-885) — give it its
  // own budget, so the tests' 30 s cover rendering only.
  beforeAll(() => getBrowser(), 90_000);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-inspect-node-e2e-"));
    await cp(join(process.cwd(), "src", "tools", "__fixtures__", "notes-app"), dir, { recursive: true });
    store = new FsStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await __resetBrowserForTests();
  });

  it(
    "returns a bounding box and the curated computed styles for a styled node",
    async () => {
      const result = await inspectNode(store, { node: "welcome.n4" });

      expect(result.box.width).toBeGreaterThan(0);
      expect(result.box.height).toBeGreaterThan(0);
      expect(result.styles.display).not.toBe("");
      // welcome.n4 is `class="$btn-primary"` — the design-system button
      // component sets a non-transparent background.
      expect(result.styles.background_color).toMatch(/^rgba?\(/);
      expect(Object.keys(result.styles).sort()).toEqual(
        [
          "background_color",
          "border",
          "border_radius",
          "color",
          "display",
          "font_size",
          "font_weight",
          "line_height",
          "margin",
          "overflow",
          "padding",
          "position",
        ].sort(),
      );
    },
    30_000,
  );

  it(
    "rejects a node id that isn't in the parsed model, without needing a browser render",
    async () => {
      await expect(inspectNode(store, { node: "welcome.does-not-exist" })).rejects.toMatchObject({
        code: "not_found",
      });
    },
    30_000,
  );

  it(
    "renders the containing variant standalone and clips to a component node ref (ADR-004 §1)",
    async () => {
      const result = await inspectNode(store, { node: "component:btn-primary#hover.n1" });

      expect(result.box.width).toBeGreaterThan(0);
      expect(result.box.height).toBeGreaterThan(0);
      // The hover variant sets a box-shadow the default variant doesn't.
      expect(result.styles.background_color).toMatch(/^rgba?\(/);
    },
    30_000,
  );

  it(
    "keeps a representative response within a few hundred tokens (chars/4 heuristic)",
    async () => {
      const result = await inspectNode(store, { node: "welcome.n4" });
      expect(estimateTokens(result)).toBeLessThanOrEqual(400);
    },
    30_000,
  );
});
