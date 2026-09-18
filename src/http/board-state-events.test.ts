import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initProject } from "../init/init-project.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";
import { FsStore } from "../store/index.js";

const execFileAsync = promisify(execFile);

type JsonRpcResponse = {
  jsonrpc?: string;
  error?: { code: number; message: string };
  result?: { content: [{ type: string; text: string }] };
};

async function mcpCall(port: number, project: string, body: unknown): Promise<{ status: number; json: JsonRpcResponse }> {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  url.searchParams.set("project", project);
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

async function postToolsApi(port: number, name: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Reads every complete SSE frame currently buffered without blocking — used to assert an ABSENCE of an event type over a short window. */
async function drainAvailable(reader: ReadableStreamDefaultReader<Uint8Array>, waitMs: number): Promise<Record<string, unknown>[]> {
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Record<string, unknown>[] = [];
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: false }>((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), remaining)),
    ]);
    if (result.done) break;
    if (result.value === undefined) break;
    buffer += decoder.decode(result.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      events.push(JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>);
    }
  }
  return events;
}

async function waitForSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (evt: Record<string, unknown>) => boolean,
  timeoutMs: number,
  carry: { buffer: string },
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();

  const readLoop = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream closed before a matching event arrived");
      carry.buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = carry.buffer.indexOf("\n\n")) !== -1) {
        const chunk = carry.buffer.slice(0, idx);
        carry.buffer = carry.buffer.slice(idx + 2);
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

  return Promise.race([readLoop(), timeout]);
}

async function connectSse(port: number, dir: string): Promise<{ res: Response; reader: ReadableStreamDefaultReader<Uint8Array>; carry: { buffer: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/events?project=${encodeURIComponent(dir)}`);
  const reader = res.body!.getReader();
  await new Promise((resolve) => setTimeout(resolve, 200)); // let the SSE registration land before the next call
  return { res, reader, carry: { buffer: "" } };
}

describe("CHR-624 board_state SSE + routes", () => {
  let dirA: string;
  let dirB: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    dirA = await mkdtemp(join(tmpdir(), "artisign-board-a-"));
    dirB = await mkdtemp(join(tmpdir(), "artisign-board-b-"));
    await initProject(dirA);
    await initProject(dirB);
    const storeA = new FsStore(dirA);
    const configA = await storeA.readArtisignConfig();
    configA.settings.autoCommit = false;
    await storeA.writeArtisignConfig(configA);
    const storeB = new FsStore(dirB);
    const configB = await storeB.readArtisignConfig();
    configB.settings.autoCommit = false;
    await storeB.writeArtisignConfig(configB);
    await storeA.writeScreen("home", `<div id="n1"></div>`);
    await storeA.writeScreen("checkout", `<div id="n1"></div>`);

    artisignHome = await setupArtisignHome();
    daemon = await startDaemon({ port: 0, projects: [dirA, dirB] });
  });

  afterEach(async () => {
    await daemon.stop();
    await artisignHome.cleanup();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it("GET /api/board-state returns the default state for a project nothing has touched yet", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/board-state?project=${encodeURIComponent(dirA)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ filter: null, pinned: [] });
  });

  it("POST /api/tools/set_board_state (browser) sets the filter and broadcasts board_state with source:human", async () => {
    const { reader, carry } = await connectSse(daemon.port, dirA);
    try {
      const { status, json } = await postToolsApi(daemon.port, "set_board_state", { filter: "checkout" });
      expect(status).toBe(200);
      expect(json).toMatchObject({ filter: "checkout", shown_screens: ["checkout"] });

      const evt = await waitForSseEvent(reader, (e) => e.type === "board_state", 2000, carry);
      expect(evt).toEqual({ type: "board_state", filter: "checkout", pinned: [], source: "human" });

      const mirrored = await fetch(`http://127.0.0.1:${daemon.port}/api/board-state?project=${encodeURIComponent(dirA)}`);
      expect(await mirrored.json()).toEqual({ filter: "checkout", pinned: [] });
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("set_board_state over /mcp pins a screen and broadcasts board_state with source:agent", async () => {
    const { reader, carry } = await connectSse(daemon.port, dirA);
    try {
      const callResult = await mcpCall(daemon.port, dirA, toolCallBody("set_board_state", { pins: { op: "add", screens: ["home"] } }));
      expect(callResult.status).toBe(200);
      const body = JSON.parse(callResult.json.result!.content[0]!.text) as { pinned: string[] };
      expect(body.pinned).toEqual(["home"]);

      const evt = await waitForSseEvent(reader, (e) => e.type === "board_state", 2000, carry);
      expect(evt).toEqual({ type: "board_state", filter: null, pinned: ["home"], source: "agent" });
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("no broadcast on a pure read (every field omitted)", async () => {
    await postToolsApi(daemon.port, "set_board_state", { filter: "checkout" });
    const { reader } = await connectSse(daemon.port, dirA);
    try {
      const { status, json } = await postToolsApi(daemon.port, "set_board_state", {});
      expect(status).toBe(200);
      expect(json).toMatchObject({ filter: "checkout" }); // still reports current state

      const events = await drainAvailable(reader, 500);
      expect(events.some((e) => e.type === "board_state")).toBe(false);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("no broadcast when a patch doesn't actually change anything (same filter twice)", async () => {
    await postToolsApi(daemon.port, "set_board_state", { filter: "checkout" });
    const { reader } = await connectSse(daemon.port, dirA);
    try {
      const { status } = await postToolsApi(daemon.port, "set_board_state", { filter: "checkout" });
      expect(status).toBe(200);

      const events = await drainAvailable(reader, 500);
      expect(events.some((e) => e.type === "board_state")).toBe(false);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("an unknown screen name in pins never enters pinned — it warns, and the known names in the same call still apply", async () => {
    const { status, json } = await postToolsApi(daemon.port, "set_board_state", { pins: { op: "add", screens: ["home", "ghost"] } });
    expect(status).toBe(200);
    expect(json.pinned).toEqual(["home"]);
    expect(json.warnings).toEqual([{ kind: "unknown_ref", message: 'screen "ghost" was not found' }]);
  });

  it("deleting a pinned screen prunes it and broadcasts the resulting board_state", async () => {
    await postToolsApi(daemon.port, "set_board_state", { pins: { op: "add", screens: ["home", "checkout"] } });
    const { reader, carry } = await connectSse(daemon.port, dirA);
    try {
      const callResult = await mcpCall(daemon.port, dirA, toolCallBody("delete_entity", { kind: "screen", name: "home" }));
      expect(callResult.status).toBe(200);

      const evt = await waitForSseEvent(reader, (e) => e.type === "board_state", 2000, carry);
      expect(evt).toEqual({ type: "board_state", filter: null, pinned: ["checkout"], source: "agent" });

      const mirrored = await fetch(`http://127.0.0.1:${daemon.port}/api/board-state?project=${encodeURIComponent(dirA)}`);
      expect(await mirrored.json()).toEqual({ filter: null, pinned: ["checkout"] });
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("two SSE clients on the same project both receive board_state", async () => {
    const client1 = await connectSse(daemon.port, dirA);
    const client2 = await connectSse(daemon.port, dirA);
    try {
      await postToolsApi(daemon.port, "set_board_state", { filter: "checkout" });

      const evt1 = await waitForSseEvent(client1.reader, (e) => e.type === "board_state", 2000, client1.carry);
      const evt2 = await waitForSseEvent(client2.reader, (e) => e.type === "board_state", 2000, client2.carry);
      expect(evt1).toEqual({ type: "board_state", filter: "checkout", pinned: [], source: "human" });
      expect(evt2).toEqual(evt1);
    } finally {
      await client1.reader.cancel().catch(() => {});
      await client2.reader.cancel().catch(() => {});
    }
  });

  it("state is per-project — setting it on A never reaches B, and B's own GET/events show its own (empty) state", async () => {
    const { reader: reader1 } = await connectSse(daemon.port, dirA);
    const { reader: reader2 } = await connectSse(daemon.port, dirB);
    try {
      await postToolsApi(daemon.port, "set_board_state", { filter: "checkout" });

      const resA = await fetch(`http://127.0.0.1:${daemon.port}/api/board-state?project=${encodeURIComponent(dirA)}`);
      expect(await resA.json()).toEqual({ filter: "checkout", pinned: [] });
      const resB = await fetch(`http://127.0.0.1:${daemon.port}/api/board-state?project=${encodeURIComponent(dirB)}`);
      expect(await resB.json()).toEqual({ filter: null, pinned: [] });

      // B's own /events connection stays silent — proves the broadcast never
      // crossed projects, not just that B's on-disk state is untouched.
      const eventsOnB = await drainAvailable(reader2, 500);
      expect(eventsOnB.some((e) => e.type === "board_state")).toBe(false);
    } finally {
      await reader1.cancel().catch(() => {});
      await reader2.cancel().catch(() => {});
    }
  });

  it("nothing is written to the project folder or committed — a filter/pin change with autoCommit on creates no commit", async () => {
    const store = new FsStore(dirA);
    const config = await store.readArtisignConfig();
    config.settings.autoCommit = true;
    await store.writeArtisignConfig(config);
    await execFileAsync("git", ["init"], { cwd: dirA });
    await execFileAsync("git", ["add", "-A"], { cwd: dirA });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dirA });
    const before = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dirA });

    await postToolsApi(daemon.port, "set_board_state", { filter: "checkout", pins: { op: "add", screens: ["home"] } });

    const after = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dirA });
    expect(after.stdout).toBe(before.stdout); // no new commit
    const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: dirA });
    expect(status.stdout.trim()).toBe(""); // no untracked/modified file either
  });

  it("after a daemon restart, a project's board state is empty again", async () => {
    await postToolsApi(daemon.port, "set_board_state", { filter: "checkout", pins: { op: "add", screens: ["home"] } });
    const before = await fetch(`http://127.0.0.1:${daemon.port}/api/board-state?project=${encodeURIComponent(dirA)}`);
    expect(await before.json()).toEqual({ filter: "checkout", pinned: ["home"] });

    await daemon.stop();
    daemon = await startDaemon({ port: 0, projects: [dirA, dirB] });

    const after = await fetch(`http://127.0.0.1:${daemon.port}/api/board-state?project=${encodeURIComponent(dirA)}`);
    expect(await after.json()).toEqual({ filter: null, pinned: [] });
  });
});
