import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/init-project.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";
import { isAllowedHost } from "./origin-guard.js";

/** Raw request so the Host header can be set (fetch forbids overriding it). Resolves on the response head, so SSE does not hang. */
function rawGet(port: number, path: string, host: string | null, method = "GET"): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (host !== null) headers.host = host;
    const req = request({ host: "127.0.0.1", port, path, method, headers, setHost: false }, (res) => {
      res.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Host header guard (DNS rebinding)", () => {
  let dir: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-host-guard-"));
    await initProject(dir);
    artisignHome = await setupArtisignHome();
    daemon = await startDaemon({ port: 0, projects: [dir] });
  });

  afterEach(async () => {
    await daemon.stop();
    await artisignHome.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  const routes: Array<[string, string]> = [
    ["GET", "/api/projects"],
    ["GET", "/api/fs/dirs"],
    ["GET", "/events"],
    ["POST", "/mcp"],
    ["GET", "/"],
    ["GET", "/health"],
  ];

  for (const [method, path] of routes) {
    it(`rejects a rebinding Host without Origin on ${method} ${path}`, async () => {
      expect(await rawGet(daemon.port, path, `attacker.example:${daemon.port}`, method)).toBe(403);
    });
  }

  it("rejects a loopback hostname on the wrong port", async () => {
    expect(await rawGet(daemon.port, "/api/projects", `127.0.0.1:${daemon.port + 1}`)).toBe(403);
  });

  it("rejects a missing Host header (Node's own HTTP/1.1 check answers 400 before the handler runs)", async () => {
    expect(await rawGet(daemon.port, "/api/projects", null)).toBe(400);
  });

  it("rejects a Host without a port", async () => {
    expect(await rawGet(daemon.port, "/api/projects", "127.0.0.1")).toBe(403);
  });

  it("answers with the host-specific JSON message", async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: daemon.port, path: "/api/projects", headers: { host: "attacker.example:1" }, setHost: false },
        (res: IncomingMessage) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(JSON.parse(body)).toEqual({ code: "validation_failed", message: "forbidden: host not allowed" });
  });

  for (const hostname of ["127.0.0.1", "localhost", "[::1]", "LOCALHOST"]) {
    it(`allows ${hostname}:<port>`, async () => {
      expect(await rawGet(daemon.port, "/api/projects", `${hostname}:${daemon.port}`)).toBe(200);
    });
  }

  it("allows /health and /api/projects with the plain fetch host", async () => {
    expect((await fetch(`http://127.0.0.1:${daemon.port}/health`)).status).toBe(200);
    expect((await fetch(`http://localhost:${daemon.port}/api/projects`)).status).toBe(200);
  });
});

describe("isAllowedHost", () => {
  const fake = (host: string | undefined, localPort: number | undefined) =>
    ({ headers: host === undefined ? {} : { host }, socket: { localPort } }) as unknown as IncomingMessage;

  it("accepts loopback hosts on the socket's port", () => {
    expect(isAllowedHost(fake("127.0.0.1:4711", 4711))).toBe(true);
    expect(isAllowedHost(fake("localhost:4711", 4711))).toBe(true);
    expect(isAllowedHost(fake("[::1]:4711", 4711))).toBe(true);
    expect(isAllowedHost(fake("LocalHost:4711", 4711))).toBe(true);
  });

  it("rejects other hostnames, including look-alikes", () => {
    for (const h of [
      "attacker.example:4711",
      "localhost.attacker.example:4711",
      "127.0.0.1.attacker.example:4711",
      "0.0.0.0:4711",
      "127.0.0.2:4711",
      "[::2]:4711",
    ]) {
      expect(isAllowedHost(fake(h, 4711))).toBe(false);
    }
  });

  it("rejects a wrong, missing or malformed port", () => {
    expect(isAllowedHost(fake("127.0.0.1:4712", 4711))).toBe(false);
    expect(isAllowedHost(fake("127.0.0.1", 4711))).toBe(false);
    expect(isAllowedHost(fake("127.0.0.1:", 4711))).toBe(false);
    expect(isAllowedHost(fake("127.0.0.1:47x1", 4711))).toBe(false);
    expect(isAllowedHost(fake("::1:4711", 4711))).toBe(false);
  });

  it("rejects a missing, empty or malformed Host and an unknown socket port", () => {
    expect(isAllowedHost(fake(undefined, 4711))).toBe(false);
    expect(isAllowedHost(fake("", 4711))).toBe(false);
    expect(isAllowedHost(fake("127.0.0.1:4711, attacker.example:4711", 4711))).toBe(false);
    expect(isAllowedHost(fake("user@127.0.0.1:4711", 4711))).toBe(false);
    expect(isAllowedHost(fake("127.0.0.1:4711", undefined))).toBe(false);
  });
});
