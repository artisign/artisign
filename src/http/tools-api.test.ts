import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/init-project.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";

describe("internal tools API (/api/tools/*)", () => {
  let dir: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-tools-api-"));
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

  async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("runs a read tool and returns its response as JSON", async () => {
    const { status, json } = await post("/api/tools/get_project", {});
    expect(status).toBe(200);
    expect(json).toMatchObject({ screen_count: 0 });
  });

  it("runs a write tool through the same route", async () => {
    const { status, json } = await post("/api/tools/write_html", {
      screen: "home",
      mode: "create",
      title: "Home",
      html_aug: `<div id="n1">Hi</div>`,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ screen: "home" });
  });

  it("maps a not_found ToolError to HTTP 404", async () => {
    const { status, json } = await post("/api/tools/get_screen", { screen: "nope" });
    expect(status).toBe(404);
    expect(json.code).toBe("not_found");
  });

  it("maps a schema-invalid request to HTTP 400", async () => {
    const { status, json } = await post("/api/tools/write_html", { screen: "home" });
    expect(status).toBe(400);
    expect(json.code).toBe("validation_failed");
  });

  it("returns 404 for an unknown tool name", async () => {
    const { status } = await post("/api/tools/not_a_real_tool", {});
    expect(status).toBe(404);
  });

  it("serves the MCP streamable-HTTP endpoint at /mcp", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0.1.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("serves a second /mcp request after the first — stateless mode reuses no dead transport", async () => {
    const initBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.1.0" } },
    };
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

    const first = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, { method: "POST", headers, body: JSON.stringify(initBody) });
    expect(first.status).toBe(200);

    const second = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, { method: "POST", headers, body: JSON.stringify(initBody) });
    expect(second.status).toBe(200);

    const third = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(third.status).toBe(200);
  });

  it("rejects a cross-origin request to /api/tools/*", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/tools/write_html`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ screen: "pwned", mode: "create", title: "x", html_aug: `<div id="n1"></div>` }),
    });
    expect(res.status).toBe(403);
    expect(await (await fetch(`http://127.0.0.1:${daemon.port}/api/tools/get_project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).json()).toMatchObject({ screen_count: 0 });
  });

  it("rejects a cross-origin request to /mcp", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0.1.0" } } }),
    });
    expect(res.status).toBe(403);
  });

  it("allows a same-origin (matching host + port) browser request", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/tools/get_project`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${daemon.port}` },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("rejects a non-JSON content-type on /api/tools/* (the text/plain CORS-simple-request bypass)", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/tools/write_html`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ screen: "pwned2", mode: "create", title: "x", html_aug: `<div id="n1"></div>` }),
    });
    expect(res.status).toBe(403);
    expect(await listScreenNames(daemon.port)).not.toContain("pwned2");
  });
});

async function listScreenNames(port: number): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/tools/get_project`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ view: "tree" }),
  });
  const body = (await res.json()) as { screens?: Array<{ screen: string }> };
  return (body.screens ?? []).map((s) => s.screen);
}
