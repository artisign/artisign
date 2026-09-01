import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/init-project.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";
import { FsStore } from "../store/index.js";
import { fontsDir, __setFetchForTests, __resetFontMemoForTests } from "../model/index.js";
import { writeHtml } from "../tools/writes.js";

// The webfont fetch always fires on /api/render and
// /api/design-system (it always tries Material Symbols Rounded). Route
// every one of them nowhere near the network: the routes under test here
// don't exercise the fetch path itself (fonts.test.ts owns that), and a
// real Google Fonts call would make this suite flaky and network-dependent.
beforeAll(() => {
  __setFetchForTests((async () => new Response("not found", { status: 404 })) as typeof fetch);
});
afterAll(() => {
  __setFetchForTests(undefined);
});

describe("preview HTTP routes (/api/screens, /api/render/*, /api/design-system)", () => {
  let dir: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;
  let store: FsStore;

  beforeEach(async () => {
    __resetFontMemoForTests();
    dir = await mkdtemp(join(tmpdir(), "artisign-preview-routes-"));
    await initProject(dir);
    store = new FsStore(dir);

    const tokens = await store.readTokens();
    tokens.color = { primary: "#3366ff" };
    await store.writeTokens(tokens);
    await store.writeComponent(
      "btn-primary",
      `<button style="color: $color.primary">Default</button>\n<template data-variant="hover"><button style="color: $color.primary">Hover</button></template>`,
    );
    await store.writePattern(
      "page-header",
      `<header style="color: $color.primary">Default</header>\n<template data-variant="compact"><header style="color: $color.primary">Compact</header></template>`,
    );
    await store.writeScreen("home", `<div id="n1" style="color: $color.primary"></div>`);

    // A private ARTISIGN_HOME so this file's global daemon lock never collides
    // with another test file's daemon running in parallel.
    artisignHome = await setupArtisignHome();
    daemon = await startDaemon({ port: 0, projects: [dir] });
  });

  afterEach(async () => {
    await daemon.stop();
    await artisignHome.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  async function getJson(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("GET /api/screens lists screens with tags/notes (empty defaults)", async () => {
    const { status, json } = await getJson("/api/screens");
    expect(status).toBe(200);
    expect(json).toEqual({ screens: [{ name: "home", tags: [], notes: "" }] });
  });

  it("GET /api/flows returns an empty list when no screen has a flow edge", async () => {
    const { status, json } = await getJson("/api/flows");
    expect(status).toBe(200);
    expect(json).toEqual({ flows: [] });
  });

  it("GET /api/flows returns a data-flow-target edge in PublicFlow shape", async () => {
    await writeHtml(store, {
      screen: "home",
      mode: "replace",
      html_aug: `<div id="n1"><button id="n2" data-flow-target="checkout">Go</button></div>`,
    });
    const { status, json } = await getJson("/api/flows");
    expect(status).toBe(200);
    expect(json).toEqual({ flows: [{ from: "home.n2", event: "tap", to: "checkout", to_kind: "screen" }] });
  });

  it("GET /api/render/<screen> returns resolved (token-free) HTML", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/render/home`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`<div id="n1" style="color: #3366ff"></div>`);
    expect(html).toContain("box-sizing: border-box");
  });

  it("GET /api/render/<unknown> returns a 404 JSON error, not a crash", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/render/does-not-exist`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });

  it("GET /api/design-system returns tokens and every component variant rendered", async () => {
    const { status, json } = await getJson("/api/design-system");
    expect(status).toBe(200);
    expect(json.token_values).toContainEqual({ path: "color.primary", value: "#3366ff" });

    const components = json.component_definitions as Array<{ name: string; variants: Array<{ name: string; rendered_html: string }> }>;
    expect(components).toHaveLength(1);
    const variantNames = components[0]!.variants.map((v) => v.name).sort();
    expect(variantNames).toEqual(["default", "hover"]);
    for (const variant of components[0]!.variants) {
      expect(variant.rendered_html).toContain("color: #3366ff");
      expect(variant.rendered_html).not.toContain("$color");
    }
  });

  it("GET /api/design-system carries idea/decisions/usage from meta.json", async () => {
    await store.writeDesignSystemMeta({
      idea: "consistent, calm checkout",
      decisions: [{ id: "d1", date: "2026-01-01", title: "single page checkout", body: "fewer steps", status: "active" }],
      component_usage: { "btn-primary": "primary CTAs only" },
      pattern_usage: { "page-header": "top of every screen" },
    });

    const { json } = await getJson("/api/design-system");
    expect(json.idea).toBe("consistent, calm checkout");
    expect(json.decisions).toEqual([{ id: "d1", date: "2026-01-01", title: "single page checkout", body: "fewer steps", status: "active" }]);
    const components = json.component_definitions as Array<{ name: string; usage?: string }>;
    expect(components.find((c) => c.name === "btn-primary")?.usage).toBe("primary CTAs only");
    const patterns = json.pattern_definitions as Array<{ name: string; usage?: string }>;
    expect(patterns.find((p) => p.name === "page-header")?.usage).toBe("top of every screen");
  });

  it("GET /api/design-system renders pattern variants the same way as components", async () => {
    const { json } = await getJson("/api/design-system");

    const patterns = json.pattern_definitions as Array<{ name: string; variants: Array<{ name: string; rendered_html: string }> }>;
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.name).toBe("page-header");
    expect(patterns[0]!.variants.map((v) => v.name).sort()).toEqual(["compact", "default"]);
    for (const variant of patterns[0]!.variants) {
      expect(variant.rendered_html).toContain("color: #3366ff");
      expect(variant.rendered_html).not.toContain("$color");
    }
  });

  it("rejects a cross-origin request to the preview routes", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/screens`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("GET /api/mockups lists mockups with their variants", async () => {
    await store.writeMockupMeta("assign-caregiver", {
      title: "Assign caregiver",
      description: "two interaction models",
      variants: [{ id: "a", title: "Toggle", description: "single toggle" }],
    });
    await store.writeMockupVariant("assign-caregiver", "a", "<div>toggle</div>");

    const { status, json } = await getJson("/api/mockups");
    expect(status).toBe(200);
    expect(json).toEqual({
      mockups: [
        {
          name: "assign-caregiver",
          title: "Assign caregiver",
          description: "two interaction models",
          tags: [],
          variants: [{ id: "a", title: "Toggle", description: "single toggle" }],
        },
      ],
    });
  });

  it("GET /api/mockups reports tags set on a mockup", async () => {
    await store.writeMockupMeta("assign-caregiver", { variants: [], tags: ["checkout"] });

    const { status, json } = await getJson("/api/mockups");
    expect(status).toBe(200);
    expect(json).toEqual({
      mockups: [{ name: "assign-caregiver", title: undefined, description: undefined, tags: ["checkout"], variants: [] }],
    });
  });

  it("GET /api/mockups treats a mockup dir without mockup.json as {variants: []} instead of 500ing the whole listing", async () => {
    await store.writeMockupMeta("assign-caregiver", { title: "Assign caregiver", variants: [] });
    // A directory that exists (e.g. its first variant was written mid-write,
    // or mockup.json was deleted by hand) but has no mockup.json yet.
    await store.writeMockupVariant("no-meta-yet", "a", "<div></div>");

    const { status, json } = await getJson("/api/mockups");
    expect(status).toBe(200);
    expect(json).toEqual({
      mockups: [
        { name: "assign-caregiver", title: "Assign caregiver", description: undefined, tags: [], variants: [] },
        { name: "no-meta-yet", title: undefined, description: undefined, tags: [], variants: [] },
      ],
    });
  });

  it("GET /api/render/mockup/<name>/<variant> wraps a fragment with the deterministic baseline", async () => {
    await store.writeMockupMeta("assign-caregiver", { variants: [{ id: "a", title: "Toggle", description: "" }] });
    await store.writeMockupVariant("assign-caregiver", "a", "<div>toggle</div>");

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/render/mockup/assign-caregiver/a`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<div>toggle</div>");
    expect(html).toContain("box-sizing: border-box");
  });

  it("GET /api/render/mockup/<name>/<variant> wraps a fragment that merely contains the literal text \"<html>\" (not at the document start)", async () => {
    await store.writeMockupMeta("assign-caregiver", { variants: [{ id: "b", title: "B", description: "" }] });
    await store.writeMockupVariant("assign-caregiver", "b", "<div>learn about &lt;html&gt; and <html> elements</div>");

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/render/mockup/assign-caregiver/b`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<div>learn about &lt;html&gt; and <html> elements</div>");
    expect(html).toContain("box-sizing: border-box");
  });

  it("GET /api/render/mockup/<name>/<variant> still renders (no fonts) when tokens.json is missing", async () => {
    await store.writeMockupMeta("assign-caregiver", { variants: [{ id: "a", title: "A", description: "" }] });
    await store.writeMockupVariant("assign-caregiver", "a", "<div>toggle</div>");
    await rm(join(dir, "design-system", "tokens.json"));

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/render/mockup/assign-caregiver/a`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<div>toggle</div>");
  });

  it("GET /api/render/mockup/<name>/<variant> serves a full HTML document verbatim", async () => {
    await store.writeMockupMeta("assign-caregiver", { variants: [{ id: "full", title: "Full", description: "" }] });
    const fullDoc = "<html><head><title>x</title></head><body><p>full doc</p></body></html>";
    await store.writeMockupVariant("assign-caregiver", "full", fullDoc);

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/render/mockup/assign-caregiver/full`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(fullDoc);
  });

  it("GET /api/render/mockup/<unknown>/<variant> returns a 404 JSON error", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/render/mockup/does-not-exist/a`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });

  it("GET /api/render/mockup/<name>/<unknown> returns a 404 JSON error", async () => {
    await store.writeMockupMeta("assign-caregiver", { variants: [] });
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/render/mockup/assign-caregiver/does-not-exist`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });
});

describe("webfont routes (/api/fonts/*, @font-face injection)", () => {
  let dir: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;
  let store: FsStore;

  beforeEach(async () => {
    __resetFontMemoForTests();
    dir = await mkdtemp(join(tmpdir(), "artisign-preview-fonts-"));
    await initProject(dir);
    store = new FsStore(dir);
    await store.writeScreen("home", `<div id="n1"></div>`);

    // Seed the derived font cache directly, per the webfont cache's own
    // contract (fetched once, then read from disk) — no network involved here.
    await mkdir(fontsDir(dir), { recursive: true });
    await writeFile(join(fontsDir(dir), "inter-400-normal-0.woff2"), Buffer.from([1, 2, 3, 4]));
    await writeFile(
      join(fontsDir(dir), "manifest.json"),
      JSON.stringify({
        Inter: {
          files: [{ file: "inter-400-normal-0.woff2", weightRange: "400", style: "normal" }],
          css: `@font-face {\n  font-family: 'Inter';\n  font-style: normal;\n  font-weight: 400;\n  src: url(/api/fonts/inter-400-normal-0.woff2) format('woff2');\n}`,
        },
      }),
    );

    // A private ARTISIGN_HOME so this file's global daemon lock never collides
    // with another test file's daemon running in parallel.
    artisignHome = await setupArtisignHome();
    daemon = await startDaemon({ port: 0, projects: [dir] });
  });

  afterEach(async () => {
    await daemon.stop();
    await artisignHome.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("GET /api/fonts/<file> serves the cached woff2 with the right headers", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/fonts/inter-400-normal-0.woff2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(res.headers.get("cache-control")).toBe("max-age=31536000, immutable");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("GET /api/fonts/<unknown> returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/fonts/does-not-exist.woff2`);
    expect(res.status).toBe(404);
  });

  it("rejects a path-traversal attempt with 404, not a filesystem read outside the cache dir", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/fonts/${encodeURIComponent("../../artisign.json")}`);
    expect(res.status).toBe(404);
  });

  it("GET /api/render/<screen> includes the cached family's @font-face rule", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/render/home`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("@font-face");
    expect(html).toContain("font-family: 'Inter'");
    expect(html).toContain("url(/api/fonts/inter-400-normal-0.woff2)");
  });
});

describe("asset routes (/api/assets/*, src/url() rewriting)", () => {
  let dir: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;
  let store: FsStore;

  beforeEach(async () => {
    __resetFontMemoForTests();
    dir = await mkdtemp(join(tmpdir(), "artisign-preview-assets-"));
    await initProject(dir);
    store = new FsStore(dir);
    await mkdir(join(dir, "assets", "icons"), { recursive: true });
    await writeFile(join(dir, "assets", "hero.png"), Buffer.from([1, 2, 3, 4]));
    await writeFile(join(dir, "assets", "icons", "logo.svg"), "<svg></svg>");
    await store.writeScreen(
      "home",
      `<div id="n1"><img id="hero" src="assets/hero.png"><div id="bg" style="background-image: url(assets/icons/logo.svg)"></div></div>`,
    );

    artisignHome = await setupArtisignHome();
    daemon = await startDaemon({ port: 0, projects: [dir] });
  });

  afterEach(async () => {
    await daemon.stop();
    await artisignHome.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("GET /api/assets/<path> serves a project asset with the right content-type", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/assets/hero.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("GET /api/assets/<path> sends a CSP + nosniff header (an SVG in assets/ must never run as script on this origin)", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/assets/icons/logo.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("GET /api/render/<screen> rewrites a double-quoted CSS url() through the real render pipeline (escapeAttr turns its quotes into &quot;)", async () => {
    // The outer `style` attribute is single-quoted in the *source* so the
    // CSS url() argument's own double quotes don't need escaping there — the
    // parser decodes this into a real `url("assets/…")` internally, and
    // render.ts's escapeAttr then re-encodes those quotes as `&quot;` when
    // it re-serializes the (always double-quoted) style attribute. This is
    // the actual escaped shape resolveAssetRefs has to handle, produced by
    // the real pipeline rather than hand-written.
    await store.writeScreen("home", `<div id="n1" style='background-image: url("assets/icons/logo.svg")'></div>`);

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/render/home`);
    const html = await res.text();
    expect(html).toContain("url('/api/assets/icons/logo.svg')");
    expect(html).not.toContain("&quot;");

    const assetMatch = /url\('([^']+)'\)/.exec(html);
    const assetRes = await fetch(`http://127.0.0.1:${daemon.port}${assetMatch![1]}`);
    expect(assetRes.status).toBe(200);
    expect(await assetRes.text()).toBe("<svg></svg>");
  });

  it("GET /api/assets/<encoded path> round-trips a filename with a space", async () => {
    await writeFile(join(dir, "assets", "hero copy.png"), Buffer.from([9, 9, 9]));
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/assets/${encodeURIComponent("hero copy.png")}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([9, 9, 9]));
  });

  it("GET /api/render/<screen> rewrites a filename with a space to a route the server can decode", async () => {
    await writeFile(join(dir, "assets", "hero copy.png"), Buffer.from([9, 9, 9]));
    await store.writeScreen("home", `<div id="n1"><img id="hero2" src="assets/hero copy.png"></div>`);

    const renderRes = await fetch(`http://127.0.0.1:${daemon.port}/api/render/home`);
    const html = await renderRes.text();
    const srcMatch = /id="hero2" src="([^"]+)"/.exec(html);
    expect(srcMatch?.[1]).toBe("/api/assets/hero%20copy.png");

    const assetRes = await fetch(`http://127.0.0.1:${daemon.port}${srcMatch![1]}`);
    expect(assetRes.status).toBe(200);
    expect(Buffer.from(await assetRes.arrayBuffer())).toEqual(Buffer.from([9, 9, 9]));
  });

  it("GET /api/assets/<nested path> serves a file from a subdirectory", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/assets/icons/logo.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(await res.text()).toBe("<svg></svg>");
  });

  it("GET /api/assets/<unknown> returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/assets/does-not-exist.png`);
    expect(res.status).toBe(404);
  });

  it("rejects a path-traversal attempt with 404, not a filesystem read outside assets/", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/assets/${encodeURIComponent("../artisign.json")}`);
    expect(res.status).toBe(404);
  });

  it("GET /api/render/<screen> rewrites src and url() asset refs to /api/assets/*", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/render/home`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('src="/api/assets/hero.png"');
    expect(html).toContain("url('/api/assets/icons/logo.svg')");
  });
});
