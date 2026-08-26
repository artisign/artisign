import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/init-project.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";

describe("unknown /api/* routes", () => {
  let dir: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-api-404-"));
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

  it("404s promptly for an unmatched GET /api/* path", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ code: "not_found", message: "unknown API route" });
  });

  it("404s promptly for an unmatched GET /api/screens/whatever path", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/screens/whatever`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ code: "not_found", message: "unknown API route" });
  });

  it("404s promptly for a POST to an unmatched /api/* path", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/nope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ code: "not_found", message: "unknown API route" });
  });

  it("404s promptly for a DELETE to /api/comments (recognized path, unsupported method)", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/comments`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
