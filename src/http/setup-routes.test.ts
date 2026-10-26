import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultClientEnv } from "../setup/clients.js";
import { handleAboutApi } from "./about-routes.js";
import { handleSetupApi } from "./setup-routes.js";
import { STARTED_VERSION } from "./server.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";

describe("handleSetupApi / handleAboutApi (injected env)", () => {
  let root: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "artisign-setup-routes-"));
    await mkdir(join(root, "home", ".cursor"), { recursive: true });
    await writeFile(join(root, "home", ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { artisign: { command: "x" } } }));
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "npx"), "#!/bin/sh\n");
    await chmod(join(root, "bin", "npx"), 0o755);
    const env = { ...defaultClientEnv(), home: join(root, "home"), platform: "darwin" as const, pathEnv: join(root, "bin"), vars: {} };
    server = createServer((req, res) => {
      void (async () => {
        const handled = (await handleSetupApi(req, res, "7.1.0", env)) || (await handleAboutApi(req, res, "7.1.0"));
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  it("GET /api/about returns the given version", async () => {
    expect(await (await fetch(`${base}/api/about`)).json()).toEqual({ version: "7.1.0" });
  });

  it("GET /api/setup reports found/connected and a ~-shortened, pinned manual per client", async () => {
    const body = (await (await fetch(`${base}/api/setup`)).json()) as {
      command: string;
      clients: { name: string; found: boolean; connected: boolean; manual: { kind: string; path?: string; text: string } }[];
    };
    expect(body.command).toBe("artisign setup");
    expect(body.clients.map((c) => c.name)).toEqual(["Claude Code", "Claude Desktop", "Cursor", "Codex CLI", "VS Code", "opencode"]);
    const cursor = body.clients.find((c) => c.name === "Cursor");
    expect(cursor).toMatchObject({ found: true, connected: true, manual: { kind: "config", path: "~/.cursor/mcp.json" } });
    expect(cursor?.manual.text).toContain("artisign@7.1.0");
    expect(body.clients.find((c) => c.name === "Claude Desktop")).toMatchObject({ found: false, connected: false });
    expect(body.clients.find((c) => c.name === "Codex CLI")?.manual.path).toBe("~/.codex/config.toml");
  });

  it("does not write any client config", async () => {
    await fetch(`${base}/api/setup`);
    expect(await readdir(join(root, "home", ".cursor"))).toEqual(["mcp.json"]);
    expect(await readdir(join(root, "home"))).toEqual([".cursor"]);
  });

  it("leaves other methods and paths unhandled", async () => {
    expect((await fetch(`${base}/api/setup`, { method: "POST" })).status).toBe(404);
  });
});

describe("daemon routes /api/about and /api/setup", () => {
  let home: ArtisignHomeFixture;
  let daemon: DaemonHandle;
  let fakeHome: string;
  let oldHome: string | undefined;
  let oldPath: string | undefined;

  beforeEach(async () => {
    home = await setupArtisignHome();
    fakeHome = await mkdtemp(join(tmpdir(), "artisign-fake-home-"));
    oldHome = process.env.HOME;
    oldPath = process.env.PATH;
    process.env.HOME = fakeHome;
    process.env.PATH = join(fakeHome, "empty-bin");
    daemon = await startDaemon({ port: 0, projects: [] });
  });
  afterEach(async () => {
    await daemon.stop();
    process.env.HOME = oldHome;
    process.env.PATH = oldPath;
    await home.cleanup();
    await rm(fakeHome, { recursive: true, force: true });
  });

  const url = (path: string) => `http://127.0.0.1:${daemon.port}${path}`;

  it("serves the started version with zero projects open", async () => {
    const res = await fetch(url("/api/about"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: STARTED_VERSION });
  });

  it("serves the setup status with zero projects open", async () => {
    const res = await fetch(url("/api/setup"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: string; clients: { found: boolean }[] };
    expect(body.command).toBe("artisign setup");
    expect(body.clients).toHaveLength(6);
    expect(body.clients.every((c) => !c.found)).toBe(true);
  });

  it("rejects cross-origin requests and unknown methods", async () => {
    for (const path of ["/api/about", "/api/setup"]) {
      expect((await fetch(url(path), { headers: { origin: "https://evil.example" } })).status).toBe(403);
    }
    const post = await fetch(url("/api/about"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(post.status).toBe(404);
  });
});
