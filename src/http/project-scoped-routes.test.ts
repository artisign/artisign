import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/init-project.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";
import { FsStore } from "../store/index.js";

type JsonRpcResponse = {
  jsonrpc?: string;
  error?: { code: number; message: string };
  result?: { content: [{ type: string; text: string }] };
};

async function mcpCall(port: number, project: string | undefined, body: unknown): Promise<{ status: number; json: JsonRpcResponse }> {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  if (project !== undefined) url.searchParams.set("project", project);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get("content-type");
  const text = await res.text();
  let json: unknown;
  if (contentType?.includes("text/event-stream")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    json = dataLine ? JSON.parse(dataLine.slice("data: ".length)) : undefined;
  } else {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  }
  return { status: res.status, json: json as JsonRpcResponse };
}

function toolCallBody(name: string, args: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

async function waitForSseEvent(response: Response, predicate: (evt: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const readLoop = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream closed before a matching event arrived");
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const evt = JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
        if (predicate(evt)) return evt;
      }
    }
  };

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for a matching SSE event`)), timeoutMs);
  });

  try {
    return await Promise.race([readLoop(), timeout]);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

describe("project-scoped /mcp and UI routes", () => {
  let dirA: string;
  let dirB: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle | undefined;

  beforeEach(async () => {
    dirA = await mkdtemp(join(tmpdir(), "artisign-scope-a-"));
    dirB = await mkdtemp(join(tmpdir(), "artisign-scope-b-"));
    await initProject(dirA);
    await initProject(dirB);
    await new FsStore(dirA).writeScreen("home", `<div id="n1"></div>`);
    await new FsStore(dirB).writeScreen("dashboard", `<div id="n1"></div><div id="n2"></div>`);
    artisignHome = await setupArtisignHome();
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await artisignHome.cleanup();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it("/mcp?project=A and /mcp?project=B run in parallel with independent results", async () => {
    daemon = await startDaemon({ port: 0, projects: [dirA, dirB] });

    const [resA, resB] = await Promise.all([
      mcpCall(daemon.port, dirA, toolCallBody("get_project", { view: "tree" })),
      mcpCall(daemon.port, dirB, toolCallBody("get_project", { view: "tree" })),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const textA = JSON.parse(resA.json.result!.content[0]!.text) as { screens: Array<{ screen: string }> };
    const textB = JSON.parse(resB.json.result!.content[0]!.text) as { screens: Array<{ screen: string }> };
    const screensA = textA.screens.map((s) => s.screen);
    const screensB = textB.screens.map((s) => s.screen);
    expect(screensA).toEqual(["home"]);
    expect(screensB).toEqual(["dashboard"]);
  });

  it("/mcp?project=<invalid path> returns a JSON-RPC error naming the path, not a bare 500", async () => {
    daemon = await startDaemon({ port: 0, projects: [dirA] });
    const badPath = join(tmpdir(), "artisign-scope-not-a-project");

    const { status, json } = await mcpCall(daemon.port, badPath, toolCallBody("get_project"));

    expect(status).not.toBe(500);
    expect(json.jsonrpc).toBe("2.0");
    expect(json.error).toBeDefined();
    expect(json.error!.message).toContain(badPath);
  });

  it("/mcp without ?project= falls back to the active project", async () => {
    daemon = await startDaemon({ port: 0, projects: [dirA] });

    const { status, json } = await mcpCall(daemon.port, undefined, toolCallBody("get_project", { view: "tree" }));

    expect(status).toBe(200);
    const body = JSON.parse(json.result!.content[0]!.text) as { screens: Array<{ screen: string }> };
    expect(body.screens.map((s) => s.screen)).toEqual(["home"]);
  });

  it("?project= on a UI route (/api/screens) returns the right project's screens", async () => {
    daemon = await startDaemon({ port: 0, projects: [dirA, dirB] });

    const resA = await fetch(`http://127.0.0.1:${daemon.port}/api/screens?project=${encodeURIComponent(dirA)}`);
    const resB = await fetch(`http://127.0.0.1:${daemon.port}/api/screens?project=${encodeURIComponent(dirB)}`);

    expect(((await resA.json()) as Record<string, unknown>).screens).toEqual([{ name: "home", tags: [], notes: "" }]);
    expect(((await resB.json()) as Record<string, unknown>).screens).toEqual([{ name: "dashboard", tags: [], notes: "" }]);
  });

  it("?project=<unopened> on a UI route 404s with unknown_project (no auto-open)", async () => {
    daemon = await startDaemon({ port: 0, projects: [dirA] });

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/screens?project=${encodeURIComponent(dirB)}`);

    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("unknown_project");
  });

  it("a UI route without ?project= falls back to the active project", async () => {
    daemon = await startDaemon({ port: 0, projects: [dirA] });

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/screens`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).screens).toEqual([{ name: "home", tags: [], notes: "" }]);
  });

  it("init_project via /mcp with zero projects open succeeds and registers the project", async () => {
    daemon = await startDaemon({ port: 0 });
    const fresh = join(await mkdtemp(join(tmpdir(), "artisign-scope-bootstrap-")), "created-by-agent");

    const { status, json } = await mcpCall(
      daemon.port,
      undefined,
      toolCallBody("init_project", { dir: fresh, seed: { kind: "empty" } }),
    );

    expect(status).toBe(200);
    expect(json.error).toBeUndefined();
    const body = JSON.parse(json.result!.content[0]!.text) as { root: string };
    expect(body.root).toBe(fresh);

    // Registered without a restart — a second /mcp call scoped to it works.
    const secondRes = await mcpCall(daemon.port, fresh, toolCallBody("get_project", { view: "tree" }));
    expect(secondRes.status).toBe(200);
    expect(secondRes.json.error).toBeUndefined();

    await rm(fresh, { recursive: true, force: true });
  });

  it("any other tool via /mcp with zero projects open reports a clean error, not a bare 500", async () => {
    daemon = await startDaemon({ port: 0 });

    const { status, json } = await mcpCall(daemon.port, undefined, toolCallBody("get_project", {}));

    expect(status).not.toBe(500);
    // The MCP SDK reports a tool-level failure as a successful envelope
    // (isError: true) carrying the ToolError JSON as its text content, not
    // a JSON-RPC-level error — mirroring how every other ToolError already
    // surfaces through mcp/server.ts.
    const body = JSON.parse(json.result!.content[0]!.text) as { code: string; message: string };
    expect(body.code).toBe("invalid_state");
    expect(body.message).toContain("init_project");
  });

  it("POST /api/tools/init_project with zero projects open succeeds and registers the project", async () => {
    daemon = await startDaemon({ port: 0 });
    const fresh = join(await mkdtemp(join(tmpdir(), "artisign-scope-bootstrap-tools-api-")), "created-by-ui");

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/tools/init_project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: fresh, seed: { kind: "empty" } }),
    });

    expect(res.status).toBe(200);
    const projectsRes = await fetch(`http://127.0.0.1:${daemon.port}/api/projects`);
    const projects = (await projectsRes.json()) as { open: Array<{ root: string }> };
    expect(projects.open.map((p) => p.root)).toContain(fresh);

    await rm(fresh, { recursive: true, force: true });
  });

  it("any other tool via /api/tools/* with zero projects open 409s cleanly, not a bare 500", async () => {
    daemon = await startDaemon({ port: 0 });

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/tools/get_project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).not.toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_state");
  });

  it("?project= that is empty or whitespace is treated as absent on /mcp", async () => {
    daemon = await startDaemon({ port: 0, projects: [dirA] });

    const emptyRes = await mcpCall(daemon.port, "", toolCallBody("get_project", { view: "tree" }));
    const whitespaceRes = await mcpCall(daemon.port, "   ", toolCallBody("get_project", { view: "tree" }));

    for (const res of [emptyRes, whitespaceRes]) {
      expect(res.status).toBe(200);
      const body = JSON.parse(res.json.result!.content[0]!.text) as { screens: Array<{ screen: string }> };
      expect(body.screens.map((s) => s.screen)).toEqual(["home"]);
    }
  });

  it("?project= that is empty or whitespace is treated as absent on a UI route", async () => {
    daemon = await startDaemon({ port: 0, projects: [dirA] });

    const emptyRes = await fetch(`http://127.0.0.1:${daemon.port}/api/screens?project=`);
    const whitespaceRes = await fetch(`http://127.0.0.1:${daemon.port}/api/screens?project=${encodeURIComponent("   ")}`);

    for (const res of [emptyRes, whitespaceRes]) {
      expect(res.status).toBe(200);
      expect(((await res.json()) as Record<string, unknown>).screens).toEqual([{ name: "home", tags: [], notes: "" }]);
    }
  });

  it("serves the static preview page even with zero projects open", async () => {
    daemon = await startDaemon({ port: 0 });

    const res = await fetch(`http://127.0.0.1:${daemon.port}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Artisign");
  });

  it("a client connected to /events receives project-switched when another client activates a different project", async () => {
    daemon = await startDaemon({ port: 0, projects: [dirA, dirB] });

    const sseRes = await fetch(`http://127.0.0.1:${daemon.port}/events`);
    const waiter = waitForSseEvent(sseRes, (evt) => evt.type === "project-switched", 2000);

    const activateRes = await fetch(`http://127.0.0.1:${daemon.port}/api/projects/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dirB }),
    });
    expect(activateRes.status).toBe(200);

    const evt = await waiter;
    expect(evt).toEqual({ type: "project-switched", root: dirB });
  });

  it("a client connected to /events receives project-opened when a new project is opened", async () => {
    daemon = await startDaemon({ port: 0, projects: [dirA] });

    const sseRes = await fetch(`http://127.0.0.1:${daemon.port}/events`);
    const waiter = waitForSseEvent(sseRes, (evt) => evt.type === "project-opened", 2000);

    const openRes = await fetch(`http://127.0.0.1:${daemon.port}/api/projects/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: dirB }),
    });
    expect(openRes.status).toBe(200);

    const evt = await waiter;
    expect(evt).toEqual({ type: "project-opened", root: dirB });
  });

  it("/events accepts the connection with zero projects open, and delivers project-opened once one is opened", async () => {
    daemon = await startDaemon({ port: 0 });

    const sseRes = await fetch(`http://127.0.0.1:${daemon.port}/events`);
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
    const waiter = waitForSseEvent(sseRes, (evt) => evt.type === "project-opened", 2000);

    const openRes = await fetch(`http://127.0.0.1:${daemon.port}/api/projects/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: dirA }),
    });
    expect(openRes.status).toBe(200);

    const evt = await waiter;
    expect(evt).toEqual({ type: "project-opened", root: dirA });
  });

  it("an abruptly closed /events connection is pruned without crashing a later broadcast", async () => {
    daemon = await startDaemon({ port: 0, projects: [dirA, dirB] });

    const controller = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${daemon.port}/events`, { signal: controller.signal });
    expect(sseRes.status).toBe(200);
    // Simulates a preview tab closing (or losing the connection) without a
    // graceful stream end — the server only learns about it via the
    // response's own "close" event, exactly the race review fix 5 covers.
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // A lifecycle broadcast (activate) and a project-scoped broadcast
    // (writing a screen) must not throw trying to write to the now-closed
    // response — proven by the daemon staying healthy and able to answer
    // further requests, and by stop() not hanging on the dead connection.
    const activateRes = await fetch(`http://127.0.0.1:${daemon.port}/api/projects/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dirB }),
    });
    expect(activateRes.status).toBe(200);

    await new FsStore(dirB).writeScreen("dashboard", `<div id="n1"></div>`);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const health = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(health.status).toBe(200);
  });

  it("evicting the active project's root does not crash the daemon for a client still on /events", async () => {
    // Without a listener, an EventEmitter "error" (which is what a failed
    // res.write() on an already-ended response turns into) throws and
    // crashes the process — the exact bug this test regresses. Catching it
    // here instead of letting it escape lets the assertion below fail the
    // test cleanly rather than taking the whole vitest worker down with it.
    let uncaught: unknown;
    const onUncaught = (err: unknown): void => {
      uncaught = err;
    };
    process.on("uncaughtException", onUncaught);

    try {
      daemon = await startDaemon({ port: 0, projects: [dirA, dirB] });

      // Without ?project=, /events resolves to the active project (dirA) and
      // registers this one connection in BOTH dirA's own SseHub and the
      // daemon-wide LifecycleHub — the exact double-registration that made
      // evict()'s broadcast-then-close-then-broadcast sequence crash the
      // process (project-closed via the still-open SseHub, then close()
      // ending the response, then project-switched racing the
      // LifecycleHub's own pruning of that now-ended response). The reader
      // is kept open (not cancelled) through both broadcasts — cancelling
      // it early closes the connection from the client side and prunes it
      // from the LifecycleHub's client set before the race can happen,
      // hiding the bug.
      const sseRes = await fetch(`http://127.0.0.1:${daemon.port}/events`);
      expect(sseRes.status).toBe(200);
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const sawEvent = (type: string, timeoutMs: number): Promise<void> =>
        Promise.race([
          (async () => {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) throw new Error("SSE stream closed before a matching event arrived");
              buffer += decoder.decode(value, { stream: true });
              if (buffer.includes(`"type":"${type}"`)) return;
            }
          })(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs)),
        ]);

      await rm(dirA, { recursive: true, force: true });
      await sawEvent("project-closed", 4000);

      // The crash this regresses happens synchronously inside evict(), right
      // after the "project-closed" broadcast above — if the daemon survived
      // that, both requests below prove it's still alive and correct rather
      // than having died with an unhandled "error" event on the response.
      const health = await fetch(`http://127.0.0.1:${daemon.port}/health`);
      expect(health.status).toBe(200);

      const projectsRes = await fetch(`http://127.0.0.1:${daemon.port}/api/projects`);
      expect(projectsRes.status).toBe(200);
      const projectsJson = (await projectsRes.json()) as { active: string | null; open: Array<{ root: string }> };
      expect(projectsJson.active).toBe(dirB);
      expect(projectsJson.open.map((p) => p.root)).toEqual([dirB]);

      await reader.cancel().catch(() => {});
      expect(uncaught).toBeUndefined();
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
