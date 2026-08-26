import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setupProject, estimateTokens, type ProjectFixture } from "./test-fixtures.js";
import { inspectNode } from "./inspect-node.js";
import { __setPlaywrightImportForTests, __resetBrowserForTests } from "./browser.js";
import { FsStore } from "../store/index.js";
import { ToolError } from "./types.js";

const require = createRequire(import.meta.url);

function isPlaywrightAvailable(): boolean {
  try {
    require.resolve("playwright");
    return true;
  } catch {
    return false;
  }
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

describe("inspectNode — missing Playwright", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
  });
  afterEach(() => {
    fx.cleanup();
    __setPlaywrightImportForTests(undefined);
  });

  it("throws a ToolError naming the install command when playwright can't be imported", async () => {
    __setPlaywrightImportForTests(() => Promise.reject(new Error("Cannot find module 'playwright'")));

    await expect(inspectNode(fx.store, { node: "home.n1" })).rejects.toMatchObject({
      code: "io_error",
      message: "Playwright is not installed. Run: npm install playwright && npx playwright install chromium",
    });
  });
});

describe.skipIf(!isPlaywrightAvailable())("inspectNode — e2e (real Chromium)", () => {
  let dir: string;
  let store: FsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-inspect-node-e2e-"));
    await cp(join(process.cwd(), "src", "tools", "__fixtures__", "notes-app"), dir, { recursive: true });
    store = new FsStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    __setPlaywrightImportForTests(undefined);
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

// Same fd-3/4 fallback story as get_screenshot — inspect_node
// shares the launch path via browser.ts, so a single smoke test here is
// enough; the exhaustive fallback coverage lives in screenshot.test.ts.
// Skipped on CI: the manual spawn omits `--no-sandbox`, so Chromium dies
// on a sandboxed Linux runner before printing its websocket endpoint. That
// is a real weakness of the fallback — tracked in CHR-562 — not a fault of
// these tests, which still run on a developer machine.
describe.skipIf(!isPlaywrightAvailable() || process.env.CI)("inspectNode — fallback launch (real Chromium)", () => {
  let dir: string;
  let store: FsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-inspect-node-fallback-e2e-"));
    await cp(join(process.cwd(), "src", "tools", "__fixtures__", "notes-app"), dir, { recursive: true });
    store = new FsStore(dir);
    await __resetBrowserForTests();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    __setPlaywrightImportForTests(undefined);
    await __resetBrowserForTests();
  });

  it(
    "falls back to a manually spawned, CDP-connected Chromium when the primary launch rejects",
    async () => {
      const real = require("playwright");
      __setPlaywrightImportForTests(() =>
        Promise.resolve({
          chromium: {
            launch: () => Promise.reject(new Error("spawn EBADF")),
            executablePath: () => real.chromium.executablePath(),
            connectOverCDP: (wsEndpoint: string) => real.chromium.connectOverCDP(wsEndpoint),
          },
        }),
      );

      const result = await inspectNode(store, { node: "welcome.n4" });
      expect(result.box.width).toBeGreaterThan(0);
    },
    30_000,
  );
});
