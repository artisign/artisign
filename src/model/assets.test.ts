import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/init-project.js";
import { FsStore } from "../store/index.js";
import { assetContentType, resolveAssetRefs } from "./assets.js";

describe("assetContentType", () => {
  it("maps known image extensions", () => {
    expect(assetContentType("hero.png")).toBe("image/png");
    expect(assetContentType("hero.JPG")).toBe("image/jpeg");
    expect(assetContentType("icons/logo.svg")).toBe("image/svg+xml");
  });

  it("returns undefined for an unknown or missing extension", () => {
    expect(assetContentType("hero")).toBeUndefined();
    expect(assetContentType("hero.bin")).toBeUndefined();
  });
});

describe("resolveAssetRefs", () => {
  let dir: string;
  let store: FsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-assets-"));
    await initProject(dir);
    store = new FsStore(dir);
    await mkdir(join(dir, "assets", "icons"), { recursive: true });
    await writeFile(join(dir, "assets", "hero.png"), Buffer.from([1, 2, 3, 4]));
    await writeFile(join(dir, "assets", "icons", "logo.svg"), "<svg></svg>");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rewrites an html unchanged when it has no asset refs", async () => {
    const html = "<div>no assets here</div>";
    expect(await resolveAssetRefs(html, store, "url")).toBe(html);
  });

  it("url mode rewrites src= to /api/assets/*, unconditionally (no filesystem check)", async () => {
    const html = `<img src="assets/does-not-exist.png">`;
    expect(await resolveAssetRefs(html, store, "url")).toBe(`<img src="/api/assets/does-not-exist.png">`);
  });

  it("url mode rewrites both src= and a background-image url()", async () => {
    const html = `<img src="assets/hero.png"><div style="background-image: url(assets/icons/logo.svg)"></div>`;
    const out = await resolveAssetRefs(html, store, "url");
    expect(out).toContain('src="/api/assets/hero.png"');
    expect(out).toContain("url('/api/assets/icons/logo.svg')");
  });

  it("inline mode embeds the file as a data: URI", async () => {
    const html = `<img src="assets/hero.png">`;
    const out = await resolveAssetRefs(html, store, "inline");
    expect(out).toBe(`<img src="data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}">`);
  });

  it("inline mode leaves an unresolvable reference unchanged", async () => {
    const html = `<img src="assets/does-not-exist.png">`;
    expect(await resolveAssetRefs(html, store, "inline")).toBe(html);
  });

  it("preserves the original quote style on src", async () => {
    const html = `<img src='assets/hero.png'>`;
    const out = await resolveAssetRefs(html, store, "url");
    expect(out).toBe(`<img src='/api/assets/hero.png'>`);
  });

  it("url mode percent-encodes a filename with a space (macOS's own default when duplicating a file)", async () => {
    await writeFile(join(dir, "assets", "hero copy.png"), Buffer.from([1, 2, 3, 4]));
    const html = `<img src="assets/hero copy.png">`;
    const out = await resolveAssetRefs(html, store, "url");
    expect(out).toBe(`<img src="/api/assets/hero%20copy.png">`);
  });

  it("url mode percent-encodes a '#' in a filename so it doesn't get read as a URL fragment", async () => {
    await writeFile(join(dir, "assets", "hero#2.png"), Buffer.from([1, 2, 3, 4]));
    const html = `<img src="assets/hero#2.png">`;
    const out = await resolveAssetRefs(html, store, "url");
    expect(out).toBe(`<img src="/api/assets/hero%232.png">`);
  });

  it("inline mode is unaffected by spaces/# — it reads the file directly, no URL involved", async () => {
    await writeFile(join(dir, "assets", "hero copy.png"), Buffer.from([5, 6, 7, 8]));
    const html = `<img src="assets/hero copy.png">`;
    const out = await resolveAssetRefs(html, store, "inline");
    expect(out).toBe(`<img src="data:image/png;base64,${Buffer.from([5, 6, 7, 8]).toString("base64")}">`);
  });
});
