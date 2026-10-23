import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/init-project.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";

describe("static preview assets (/, *.js, *.css)", () => {
  let dir: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-static-preview-"));
    await initProject(dir);
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

  it("GET / serves index.html", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>Artisign</title>");
  });

  it("GET /app.js serves the entry module with a JS content type", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("import");
  });

  it("GET /style.css serves the stylesheet with a CSS content type", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("GET /fonts/material-symbols-rounded.woff2 serves the bundled icon font", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/fonts/material-symbols-rounded.woff2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 4).toString("ascii")).toBe("wOF2");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("answers a matching If-None-Match with 304 and no body", async () => {
    const url = `http://127.0.0.1:${daemon.port}/fonts/material-symbols-rounded.woff2`;
    const etag = (await fetch(url)).headers.get("etag") ?? "";
    const res = await fetch(url, { headers: { "if-none-match": etag } });
    expect(res.status).toBe(304);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("allows HEAD and rejects other methods with 405", async () => {
    const url = `http://127.0.0.1:${daemon.port}/fonts/material-symbols-rounded.woff2`;
    expect((await fetch(url, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
  });

  it("404s for any other font path", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/fonts/other.woff2`);
    expect(res.status).toBe(404);
  });

  it("404s for an unknown static path", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/does-not-exist.js`);
    expect(res.status).toBe(404);
  });

  it("404s instead of escaping the preview directory via path traversal", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/../package.json`);
    expect(res.status).toBe(404);
  });

  it("sandboxes the screen iframe with allow-same-origin only, never allow-scripts", async () => {
    // This origin also serves /api/tools/* guarded only by an Origin-header
    // check — allow-scripts on the screen iframe would let agent-authored
    // (untrusted) screen HTML call those tools same-origin. The sandbox
    // attribute is the only barrier; pin it so a future edit can't drop it
    // silently.
    const res = await fetch(`http://127.0.0.1:${daemon.port}/`);
    const html = await res.text();
    const match = /<iframe id="screen-frame"[^>]*sandbox="([^"]*)"/.exec(html);
    expect(match?.[1]).toBe("allow-same-origin");
  });
});

describe("preview icon font with no project open", () => {
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    artisignHome = await setupArtisignHome();
    daemon = await startDaemon({ port: 0 });
  });

  afterEach(async () => {
    await daemon.stop();
    await artisignHome.cleanup();
  });

  it("serves the font without a project", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/fonts/material-symbols-rounded.woff2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
  });
});
