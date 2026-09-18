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
    expect(await resolveAssetRefs(html, store, "url")).toBe(
      `<img src="/api/assets/does-not-exist.png?project=${encodeURIComponent(store.projectDir)}">`,
    );
  });

  it("url mode rewrites both src= and a background-image url()", async () => {
    const html = `<img src="assets/hero.png"><div style="background-image: url(assets/icons/logo.svg)"></div>`;
    const out = await resolveAssetRefs(html, store, "url");
    expect(out).toContain(`src="/api/assets/hero.png?project=${encodeURIComponent(store.projectDir)}"`);
    expect(out).toContain(`url('/api/assets/icons/logo.svg?project=${encodeURIComponent(store.projectDir)}')`);
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
    expect(out).toBe(`<img src='/api/assets/hero.png?project=${encodeURIComponent(store.projectDir)}'>`);
  });

  it("url mode percent-encodes a filename with a space (macOS's own default when duplicating a file)", async () => {
    await writeFile(join(dir, "assets", "hero copy.png"), Buffer.from([1, 2, 3, 4]));
    const html = `<img src="assets/hero copy.png">`;
    const out = await resolveAssetRefs(html, store, "url");
    expect(out).toBe(`<img src="/api/assets/hero%20copy.png?project=${encodeURIComponent(store.projectDir)}">`);
  });

  it("url mode percent-encodes a '#' in a filename so it doesn't get read as a URL fragment", async () => {
    await writeFile(join(dir, "assets", "hero#2.png"), Buffer.from([1, 2, 3, 4]));
    const html = `<img src="assets/hero#2.png">`;
    const out = await resolveAssetRefs(html, store, "url");
    expect(out).toBe(`<img src="/api/assets/hero%232.png?project=${encodeURIComponent(store.projectDir)}">`);
  });

  it("inline mode is unaffected by spaces/# — it reads the file directly, no URL involved", async () => {
    await writeFile(join(dir, "assets", "hero copy.png"), Buffer.from([5, 6, 7, 8]));
    const html = `<img src="assets/hero copy.png">`;
    const out = await resolveAssetRefs(html, store, "inline");
    expect(out).toBe(`<img src="data:image/png;base64,${Buffer.from([5, 6, 7, 8]).toString("base64")}">`);
  });

  // A double-quoted url() argument inside a `style="…"` attribute has
  // already been through `escapeAttr` (html-syntax.ts) by the time it
  // reaches `resolveAssetRefs` — its literal `"` delimiters arrive as
  // `&quot;`, not `"`. render-context.test.ts / preview-routes.test.ts cover
  // this through the real render pipeline; these two exercise the escaped
  // text directly, the shape `resolveAssetRefs` actually has to parse.
  it("rewrites a &quot;-delimited url() (a double-quoted CSS url() after HTML attribute escaping)", async () => {
    const html = `<div style="background-image: url(&quot;assets/icons/logo.svg&quot;)"></div>`;
    const out = await resolveAssetRefs(html, store, "url");
    expect(out).toBe(
      `<div style="background-image: url('/api/assets/icons/logo.svg?project=${encodeURIComponent(store.projectDir)}')"></div>`,
    );
  });

  it("&quot; rewrite never introduces a literal \" that would close the enclosing style attribute early", async () => {
    const html = `<div style="background-image: url(&quot;assets/icons/logo.svg&quot;)" id="n1"></div>`;
    const out = await resolveAssetRefs(html, store, "url");
    expect(out).not.toContain('url("');
    // The id attribute must still parse as its own attribute, not as part of style's value.
    expect(out).toContain('" id="n1">');
  });

  it("unescapes &amp; in a captured reference before using it as a path or URL segment (a literal & in a filename)", async () => {
    await writeFile(join(dir, "assets", "a&b.png"), Buffer.from([1, 2, 3, 4]));
    // What the render pipeline actually produces for `src="assets/a&b.png"`
    // once escapeAttr has run over it.
    const html = `<img src="assets/a&amp;b.png">`;
    const out = await resolveAssetRefs(html, store, "url");
    expect(out).toBe(`<img src="/api/assets/a%26b.png?project=${encodeURIComponent(store.projectDir)}">`);
  });

  it("unescapes &amp; in an inline-mode reference too, so the file is actually found", async () => {
    await writeFile(join(dir, "assets", "a&b.png"), Buffer.from([1, 2, 3, 4]));
    const html = `<img src="assets/a&amp;b.png">`;
    const out = await resolveAssetRefs(html, store, "inline");
    expect(out).toBe(`<img src="data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}">`);
  });

  it("trims interior whitespace CSS permits around an unquoted url() argument", async () => {
    const html = `<div style="background-image: url( assets/icons/logo.svg )"></div>`;
    const out = await resolveAssetRefs(html, store, "url");
    expect(out).toBe(
      `<div style="background-image: url('/api/assets/icons/logo.svg?project=${encodeURIComponent(store.projectDir)}')"></div>`,
    );
  });

  it("inline mode carries no ?project= — it never leaves an HTTP reference behind", async () => {
    const html = `<img src="assets/hero.png">`;
    const out = await resolveAssetRefs(html, store, "inline");
    expect(out).not.toContain("project=");
  });

  it("a project dir with a space, an apostrophe and parentheses survives inside src=\"…\" and inside url(…)", async () => {
    const weirdDir = `${dir}/Christian's (alt)`;
    await mkdir(join(weirdDir, "assets"), { recursive: true });
    await writeFile(join(weirdDir, "assets", "hero.png"), Buffer.from([1, 2, 3, 4]));
    const weirdStore = new FsStore(weirdDir);

    const srcHtml = `<img src="assets/hero.png">`;
    const srcOut = await resolveAssetRefs(srcHtml, weirdStore, "url");
    const srcMatch = /src="([^"]+)"/.exec(srcOut);
    expect(srcMatch).not.toBeNull();
    expect(srcMatch![1]).not.toMatch(/['"()]/);
    expect(new URL(srcMatch![1]!, "http://127.0.0.1").searchParams.get("project")).toBe(weirdDir);

    const urlHtml = `<div style="background-image: url(assets/hero.png)"></div>`;
    const urlOut = await resolveAssetRefs(urlHtml, weirdStore, "url");
    const urlMatch = /url\('([^']+)'\)/.exec(urlOut);
    expect(urlMatch).not.toBeNull();
    expect(urlMatch![1]).not.toMatch(/['()]/);
    expect(new URL(urlMatch![1]!, "http://127.0.0.1").searchParams.get("project")).toBe(weirdDir);
  });
});
