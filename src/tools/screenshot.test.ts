import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import {
  getScreenshot,
  resolveViewport,
  computeNodeClip,
  clampWidth,
  NODE_SCREENSHOT_PADDING_PX,
  __setBrowserForTests,
  __resetBrowserForTests,
} from "./screenshot.js";
import {
  NO_BROWSER_MESSAGE,
  discoverBrowsers,
  selectBrowser,
  getBrowser,
  BROWSER_ENV,
} from "./browser.js";
import { parseScreen, loadRegistry } from "../model/index.js";
import { FsStore } from "../store/index.js";
import { ToolError } from "./types.js";

/** The real-browser suites run wherever a supported browser is installed (CI: Chrome and Firefox). */
function isBrowserAvailable(): boolean {
  return Boolean(process.env[BROWSER_ENV]) || discoverBrowsers().length > 0;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("resolveViewport", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("resolves plain px width/height off the root node's inline styles", async () => {
    await fx.store.writeScreen("home", `<div id="n1" style="width: 320px; height: 640px"></div>`);
    const registry = await loadRegistry(fx.store);
    const { doc } = parseScreen(await fx.store.readScreen("home"), "home", registry);
    const root = doc.nodes[doc.rootNodeId]!;

    expect(resolveViewport(root, await fx.store.readTokens())).toEqual({ width: 320, height: 640 });
  });

  it("resolves a $token-ref width/height via the same token resolution the renderer uses", async () => {
    const tokens = await fx.store.readTokens();
    tokens.size = { screen_w: "412px", screen_h: "915px" };
    await fx.store.writeTokens(tokens);
    await fx.store.writeScreen("home", `<div id="n1" style="width: $size.screen_w; height: $size.screen_h"></div>`);
    const registry = await loadRegistry(fx.store);
    const { doc } = parseScreen(await fx.store.readScreen("home"), "home", registry);
    const root = doc.nodes[doc.rootNodeId]!;

    expect(resolveViewport(root, await fx.store.readTokens())).toEqual({ width: 412, height: 915 });
  });

  it("falls back to a default mobile viewport when the root declares no size", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    const registry = await loadRegistry(fx.store);
    const { doc } = parseScreen(await fx.store.readScreen("home"), "home", registry);
    const root = doc.nodes[doc.rootNodeId]!;

    expect(resolveViewport(root, await fx.store.readTokens())).toEqual({ width: 390, height: 844 });
  });
});

describe("clampWidth", () => {
  it("defaults to 390 when undefined", () => {
    expect(clampWidth(undefined)).toBe(390);
  });

  it("passes an in-range width through unchanged", () => {
    expect(clampWidth(500)).toBe(500);
  });

  it("clamps below 200 up to 200, and above 3000 down to 3000", () => {
    expect(clampWidth(10)).toBe(200);
    expect(clampWidth(50_000)).toBe(3000);
  });

  it("rounds a non-integer width", () => {
    expect(clampWidth(390.6)).toBe(391);
  });

  it("rejects NaN/Infinity with validation_failed", () => {
    expect(() => clampWidth(Number.NaN)).toThrow(ToolError);
    expect(() => clampWidth(Number.NaN)).toThrow(expect.objectContaining({ code: "validation_failed" }));
    expect(() => clampWidth(Number.POSITIVE_INFINITY)).toThrow(expect.objectContaining({ code: "validation_failed" }));
  });
});

describe("computeNodeClip", () => {
  it("pads a box on every side", () => {
    expect(computeNodeClip({ x: 50, y: 100, width: 40, height: 20 }, NODE_SCREENSHOT_PADDING_PX)).toEqual({
      x: 42,
      y: 92,
      width: 56,
      height: 36,
    });
  });

  it("clamps left/top padding at the document origin instead of going negative", () => {
    expect(computeNodeClip({ x: 0, y: 0, width: 4, height: 4 }, NODE_SCREENSHOT_PADDING_PX)).toEqual({
      x: 0,
      y: 0,
      width: 12,
      height: 12,
    });
  });

  it("leaves right/bottom unclamped past the viewport — the caller grows the viewport to fit", () => {
    // A node well below a 390x844 fallback viewport: the padded box extends
    // to y=948, past the viewport's 844 — computeNodeClip must not truncate
    // this, or the review-loop screenshot silently clips the element.
    expect(computeNodeClip({ x: 0, y: 900, width: 40, height: 40 }, NODE_SCREENSHOT_PADDING_PX)).toEqual({
      x: 0,
      y: 892,
      width: 48,
      height: 56,
    });
  });
});

describe("getScreenshot — node/screen validation (no browser needed)", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
  });
  afterEach(() => fx.cleanup());

  it("rejects a node ref whose screen doesn't match the requested screen", async () => {
    await expect(getScreenshot(fx.store, { screen: "home", node: "other.n1" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects a malformed node ref", async () => {
    await expect(getScreenshot(fx.store, { screen: "home", node: "not-qualified" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects neither screen nor mockup+variant given", async () => {
    await expect(getScreenshot(fx.store, {})).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("rejects both screen and mockup+variant given", async () => {
    await expect(getScreenshot(fx.store, { screen: "home", mockup: "m", variant: "a" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects mockup without variant, and variant without mockup", async () => {
    await expect(getScreenshot(fx.store, { mockup: "m" })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(getScreenshot(fx.store, { variant: "a" })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("rejects node together with mockup+variant", async () => {
    await expect(getScreenshot(fx.store, { mockup: "m", variant: "a", node: "home.n1" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("mockup not_found before the browser is touched", async () => {
    await expect(getScreenshot(fx.store, { mockup: "nope", variant: "a" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("mockup variant not_found before the browser is touched", async () => {
    await fx.store.writeMockupMeta("m", { variants: [] });
    await expect(getScreenshot(fx.store, { mockup: "m", variant: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects width given together with screen", async () => {
    const err = await getScreenshot(fx.store, { screen: "home", width: 500 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "validation_failed" });
    // The message must point at the fix — the root's declared width — not just say "no".
    expect((err as Error).message).toMatch(/root/);
    expect((err as Error).message).toMatch(/390x844/);
  });

  it("rejects a non-finite width for a mockup before the browser is touched", async () => {
    await fx.store.writeMockupMeta("m", { variants: [{ id: "a", title: "a", description: "" }] });
    await expect(getScreenshot(fx.store, { mockup: "m", variant: "a", width: Number.NaN })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  // ADR-004 §1 — a component:/pattern: node ref is self-addressing and
  // stands alone; it must not be paired with screen/mockup/width.
  it("rejects a component/pattern node ref given together with screen", async () => {
    await expect(getScreenshot(fx.store, { screen: "home", node: "component:btn-primary#hover.n1" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects a component/pattern node ref given together with mockup+variant", async () => {
    await expect(
      getScreenshot(fx.store, { mockup: "m", variant: "a", node: "component:btn-primary#hover.n1" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("rejects width given together with a component/pattern node ref", async () => {
    await expect(getScreenshot(fx.store, { node: "component:btn-primary#hover.n1", width: 500 })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("component/pattern not_found before the browser is touched", async () => {
    await expect(getScreenshot(fx.store, { node: "component:does-not-exist#default.n1" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getScreenshot(fx.store, { node: "pattern:does-not-exist.n1" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  // CHR-776 — a component/pattern passed as screen fails before the browser
  // is touched; the not_found names the exact node ref to send instead.
  it("screen not_found for a component name hints the default variant's root node ref", async () => {
    await fx.store.writeComponent("eyebrow", `<span id="e">x</span><template data-variant="muted"><span id="m">x</span></template>`);
    const hint = 'use node: "component:eyebrow#default.e" without screen';
    for (const screen of ["eyebrow", "component:eyebrow", "component:eyebrow#default"]) {
      const err = await getScreenshot(fx.store, { screen }).catch((e: unknown) => e);
      expect(err, screen).toMatchObject({ code: "not_found" });
      expect((err as Error).message, screen).toContain(hint);
    }
    const muted = await getScreenshot(fx.store, { screen: "component:eyebrow#muted" }).catch((e: unknown) => e);
    expect((muted as Error).message).toContain('use node: "component:eyebrow#muted.m"');
  });

  it("screen not_found for a pattern name hints the pattern's root node ref", async () => {
    await fx.store.writePattern("card", `<div id="card-root"></div>`);
    for (const screen of ["card", "pattern:card"]) {
      const err = await getScreenshot(fx.store, { screen }).catch((e: unknown) => e);
      expect(err, screen).toMatchObject({ code: "not_found" });
      expect((err as Error).message, screen).toContain('use node: "pattern:card.card-root" without screen');
    }
  });

  it("screen not_found without a matching definition carries no hint", async () => {
    const err = await getScreenshot(fx.store, { screen: "nope" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "not_found", message: 'screen "nope" was not found' });
  });
});

describe("getScreenshot — no usable browser", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
  });
  afterEach(async () => {
    fx.cleanup();
    __setBrowserForTests(undefined);
    await __resetBrowserForTests();
  });

  it("throws a ToolError naming the remedy when no browser is installed", async () => {
    __setBrowserForTests({ select: (kind) => selectBrowser(kind, { platform: "linux", env: { PATH: "/usr/bin" }, exists: () => false }) });

    await expect(getScreenshot(fx.store, { screen: "home" })).rejects.toMatchObject({
      code: "io_error",
      message: NO_BROWSER_MESSAGE,
    });
    await expect(getScreenshot(fx.store, { screen: "home" })).rejects.toBeInstanceOf(ToolError);
    expect(NO_BROWSER_MESSAGE).toContain(BROWSER_ENV);
  });

  it("names the installed alternatives when the requested browser is missing", async () => {
    __setBrowserForTests({
      select: (kind) =>
        selectBrowser(kind, { platform: "linux", env: { PATH: "/usr/bin" }, exists: (path) => path === "/usr/bin/google-chrome" }),
    });

    await expect(getScreenshot(fx.store, { screen: "home", browser: "firefox" })).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("available: chrome"),
    });
  });

  it("wraps a failed launch in a single ToolError naming the browser and the executable", async () => {
    __setBrowserForTests({ select: () => ({ kind: "chrome", executable: "/nonexistent/artisign-test/chrome" }) });

    const err = await getScreenshot(fx.store, { screen: "home" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toMatchObject({ code: "io_error", message: expect.stringContaining("Could not start Chrome (/nonexistent/artisign-test/chrome)") });
  });

  it("does not cache a failed launch: the next call launches again", async () => {
    let calls = 0;
    __setBrowserForTests({
      select: () => ({ kind: "chrome", executable: "/fake/chrome" }),
      launch: () => {
        calls += 1;
        return Promise.reject(new ToolError("io_error", "launch failed"));
      },
    });
    await expect(getScreenshot(fx.store, { screen: "home" })).rejects.toMatchObject({ code: "io_error" });
    await expect(getScreenshot(fx.store, { screen: "home" })).rejects.toMatchObject({ code: "io_error" });
    expect(calls).toBe(2);
  });
});

describe.skipIf(!isBrowserAvailable())("getScreenshot — e2e (installed browser)", () => {
  let dir: string;
  let store: FsStore;

  // The first launch reads the browser from a cold disk (CHR-885) — give it its
  // own budget, so the tests' 30 s cover rendering only.
  beforeAll(() => getBrowser(), 90_000);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-screenshot-e2e-"));
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
    "names the browser that rendered it and returns a PNG of exactly the reported size",
    async () => {
      for (const input of [
        { screen: "welcome" },
        { screen: "welcome", scale: 2 },
        { screen: "welcome", node: "welcome.n4" },
        { mockup: "welcome-hero", variant: "bold" },
        { mockup: "welcome-hero", variant: "bold", width: 1200 },
      ]) {
        const result = await getScreenshot(store, input);
        expect(result.browser).toMatch(/^(Chrome|Edge|Brave|Chromium|Firefox) \d/);
        const buffer = Buffer.from(result.__image.data, "base64");
        // IHDR: width and height as big-endian uint32 at bytes 16 and 20.
        expect({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }).toEqual({
          width: result.width,
          height: result.height,
        });
      }
    },
    60_000,
  );

  it(
    "screenshots the full screen as a PNG matching the fallback viewport",
    async () => {
      const result = await getScreenshot(store, { screen: "welcome" });

      expect(result.__image.mimeType).toBe("image/png");
      const buffer = Buffer.from(result.__image.data, "base64");
      expect(buffer.subarray(0, 8)).toEqual(PNG_MAGIC);
      expect(result.width).toBe(390);
      expect(result.height).toBe(844);
    },
    30_000,
  );

  it(
    "screenshots a component variant standalone via a component: node ref, clipped to its root node (ADR-004 §1)",
    async () => {
      const result = await getScreenshot(store, { node: "component:btn-primary#hover.n1" });

      expect(result.__image.mimeType).toBe("image/png");
      const buffer = Buffer.from(result.__image.data, "base64");
      expect(buffer.subarray(0, 8)).toEqual(PNG_MAGIC);
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
    },
    30_000,
  );

  it(
    "crops to a single node plus padding, smaller than the full screen",
    async () => {
      const result = await getScreenshot(store, { screen: "welcome", node: "welcome.n4" });

      expect(result.__image.mimeType).toBe("image/png");
      const buffer = Buffer.from(result.__image.data, "base64");
      expect(buffer.subarray(0, 8)).toEqual(PNG_MAGIC);
      expect(result.width).toBeLessThan(390);
      expect(result.height).toBeLessThan(844);
    },
    30_000,
  );

  it(
    "rejects a node id that isn't in the rendered DOM",
    async () => {
      await expect(getScreenshot(store, { screen: "welcome", node: "welcome.does-not-exist" })).rejects.toMatchObject(
        { code: "not_found" },
      );
    },
    30_000,
  );

  it(
    "rejects a node ref belonging to a different screen without needing the browser",
    async () => {
      await expect(getScreenshot(store, { screen: "welcome", node: "other-screen.n4" })).rejects.toMatchObject({
        code: "validation_failed",
      });
    },
    30_000,
  );

  it(
    "captures a node past the fold in full instead of erroring or truncating",
    async () => {
      const original = await store.readScreen("welcome");
      // A screen needs exactly one top-level element, so the fold-pushing
      // node has to live inside the existing root, not as a sibling.
      const withBelowFoldNode = original.replace(
        "</section>",
        `<div id="below-fold" style="margin-top: 1000px; width: 100px; height: 50px"></div></section>`,
      );
      await store.writeScreen("welcome", withBelowFoldNode);

      const result = await getScreenshot(store, { screen: "welcome", node: "welcome.below-fold" });

      expect(result.__image.mimeType).toBe("image/png");
      const buffer = Buffer.from(result.__image.data, "base64");
      expect(buffer.subarray(0, 8)).toEqual(PNG_MAGIC);
      // 100x50 node + 8px padding on every side.
      expect(result.width).toBe(116);
      expect(result.height).toBe(66);
    },
    30_000,
  );
});
