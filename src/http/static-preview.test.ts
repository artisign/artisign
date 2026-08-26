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
