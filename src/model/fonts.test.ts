import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/init-project.js";
import { FsStore } from "../store/index.js";
import {
  extractFontFamilies,
  ensureFontsCached,
  buildFontFaceCss,
  isMaterialSymbolsAvailable,
  clearFontMemo,
  fontsDir,
  __setFetchForTests,
  __resetFontMemoForTests,
} from "./fonts.js";

const GOOGLE_FONTS_CSS = (family: string) => `/* latin */
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/${family.toLowerCase().replace(/\s+/g, "")}/regular.woff2) format('woff2');
}`;

function mockFetch(options: { fail?: Set<string> } = {}): typeof fetch {
  const fail = options.fail ?? new Set<string>();
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const familyMatch = /family=([^&]+)/.exec(url);
    if (familyMatch) {
      const family = decodeURIComponent(familyMatch[1]!.replace(/\+/g, " "));
      if (fail.has(family)) return new Response("not found", { status: 404 });
      return new Response(GOOGLE_FONTS_CSS(family), { status: 200 });
    }
    if (url.includes("fonts.gstatic.com")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("extractFontFamilies", () => {
  it("extracts a quoted family from a typography shorthand", () => {
    const families = extractFontFamilies({
      typography: { heading: "600 24px/1.2 'Plus Jakarta Sans', sans-serif" },
    });
    expect(families).toEqual(["Plus Jakarta Sans"]);
  });

  it("extracts an unquoted family", () => {
    const families = extractFontFamilies({ typography: { body: "400 16px/1.5 Inter, sans-serif" } });
    expect(families).toEqual(["Inter"]);
  });

  it("skips generic and system font stacks", () => {
    const families = extractFontFamilies({
      typography: {
        a: "400 16px/1.5 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        b: "400 16px/1.5 system-ui, ui-sans-serif, monospace",
      },
    });
    expect(families).toEqual([]);
  });

  it("dedupes families across multiple typography entries", () => {
    const families = extractFontFamilies({
      typography: {
        heading: "600 24px/1.2 'Inter', sans-serif",
        body: "400 16px/1.5 'Inter', sans-serif",
      },
    });
    expect(families).toEqual(["Inter"]);
  });

  it("returns an empty array when there is no typography bucket", () => {
    expect(extractFontFamilies({})).toEqual([]);
  });
});

describe("ensureFontsCached / buildFontFaceCss", () => {
  let dir: string;
  let store: FsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-fonts-"));
    await initProject(dir);
    store = new FsStore(dir);
    __resetFontMemoForTests();
  });

  afterEach(async () => {
    __setFetchForTests(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("downloads woff2 files and writes a manifest", async () => {
    __setFetchForTests(mockFetch());
    await ensureFontsCached(store, ["Inter"]);

    const manifestRaw = await readFile(join(fontsDir(dir), "manifest.json"), "utf-8");
    const manifest = JSON.parse(manifestRaw) as Record<string, { files: { file: string }[]; css: string }>;

    expect(Object.keys(manifest).sort()).toEqual(["Inter", "Material Symbols Rounded"]);
    expect(manifest.Inter!.files).toHaveLength(1);
    expect(manifest.Inter!.css).toContain("@font-face");
    expect(manifest.Inter!.css).toContain("/api/fonts/");

    const woff2 = await readFile(join(fontsDir(dir), manifest.Inter!.files[0]!.file));
    expect(woff2.length).toBeGreaterThan(0);
  });

  it("recreates .artisign/.gitignore even if the cache dir was deleted first (self-ignoring, independent of index writes)", async () => {
    await rm(join(dir, ".artisign"), { recursive: true, force: true });
    __setFetchForTests(mockFetch());

    await ensureFontsCached(store, ["Inter"]);

    await expect(readFile(join(dir, ".artisign", ".gitignore"), "utf-8")).resolves.toBe("*\n");
  });

  it("does not throw and writes no manifest entry when a family fetch fails", async () => {
    __setFetchForTests(mockFetch({ fail: new Set(["Unknown Family"]) }));
    await expect(ensureFontsCached(store, ["Unknown Family"])).resolves.toBeUndefined();

    const raw = await readFile(join(fontsDir(dir), "manifest.json"), "utf-8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    expect(manifest["Unknown Family"]).toBeUndefined();
  });

  it("memoizes resolved families and does not refetch them", async () => {
    let calls = 0;
    const base = mockFetch();
    __setFetchForTests((async (input: string | URL | Request) => {
      calls++;
      return base(input as string);
    }) as typeof fetch);

    await ensureFontsCached(store, ["Inter"]);
    const callsAfterFirst = calls;
    await ensureFontsCached(store, ["Inter"]);
    expect(calls).toBe(callsAfterFirst);
  });

  it("buildFontFaceCss returns an empty string when no manifest exists", async () => {
    expect(await buildFontFaceCss(dir, { mode: "url" })).toBe("");
  });

  it("buildFontFaceCss in url mode references /api/fonts/<file>", async () => {
    __setFetchForTests(mockFetch());
    await ensureFontsCached(store, ["Inter"]);
    const css = await buildFontFaceCss(dir, { mode: "url" });
    expect(css).toContain("url(/api/fonts/");
    expect(css).not.toContain("data:font/woff2");
  });

  it("buildFontFaceCss in inline mode embeds the woff2 as base64 data URIs", async () => {
    __setFetchForTests(mockFetch());
    await ensureFontsCached(store, ["Inter"]);
    const css = await buildFontFaceCss(dir, { mode: "inline" });
    expect(css).toContain("data:font/woff2;base64,");
    expect(css).not.toContain("/api/fonts/");
  });

  it("always includes Material Symbols Rounded even when no families are requested", async () => {
    __setFetchForTests(mockFetch());
    await ensureFontsCached(store, []);
    const raw = await readFile(join(fontsDir(dir), "manifest.json"), "utf-8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    expect(manifest["Material Symbols Rounded"]).toBeDefined();
  });

  it("isMaterialSymbolsAvailable is undefined before ensureFontsCached has run", () => {
    expect(isMaterialSymbolsAvailable(dir)).toBeUndefined();
  });

  it("isMaterialSymbolsAvailable is true after a successful live fetch", async () => {
    __setFetchForTests(mockFetch());
    await ensureFontsCached(store, []);
    expect(isMaterialSymbolsAvailable(dir)).toBe(true);
  });

  it("clearFontMemo removes only the given root's keys", async () => {
    const otherDir = await mkdtemp(join(tmpdir(), "artisign-fonts-other-"));
    await initProject(otherDir);
    const otherStore = new FsStore(otherDir);
    try {
      __setFetchForTests(mockFetch());
      await ensureFontsCached(store, []);
      await ensureFontsCached(otherStore, []);
      expect(isMaterialSymbolsAvailable(dir)).toBe(true);
      expect(isMaterialSymbolsAvailable(otherDir)).toBe(true);

      clearFontMemo(dir);

      expect(isMaterialSymbolsAvailable(dir)).toBeUndefined();
      expect(isMaterialSymbolsAvailable(otherDir)).toBe(true);
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });
});

describe("Material Symbols Rounded bundled fallback", () => {
  let dir: string;
  let store: FsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-fonts-icon-fallback-"));
    await initProject(dir);
    store = new FsStore(dir);
    __resetFontMemoForTests();
  });

  afterEach(async () => {
    __setFetchForTests(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back to the package's bundled woff2 when the live Google Fonts fetch fails, and reports it as available", async () => {
    __setFetchForTests(mockFetch({ fail: new Set(["Material Symbols Rounded"]) }));
    await ensureFontsCached(store, []);

    expect(isMaterialSymbolsAvailable(dir)).toBe(true);

    const raw = await readFile(join(fontsDir(dir), "manifest.json"), "utf-8");
    const manifest = JSON.parse(raw) as Record<string, { files: { file: string }[]; css: string }>;
    const entry = manifest["Material Symbols Rounded"];
    expect(entry).toBeDefined();
    expect(entry!.css).toContain("Material Symbols Rounded");
    expect(entry!.css).toContain("/api/fonts/");

    // The real bundled asset (~370KB), not a mock stand-in — proves the
    // fallback reads the actual package asset, not just some placeholder.
    const woff2 = await readFile(join(fontsDir(dir), entry!.files[0]!.file));
    expect(woff2.length).toBeGreaterThan(100_000);
  });

  it("buildFontFaceCss (inline mode) embeds the bundled fallback as a data URI too, same as a live-fetched family", async () => {
    __setFetchForTests(mockFetch({ fail: new Set(["Material Symbols Rounded"]) }));
    await ensureFontsCached(store, []);

    const css = await buildFontFaceCss(dir, { mode: "inline" });
    expect(css).toContain("data:font/woff2;base64,");
  });
});
