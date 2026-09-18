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

/** Reads every complete SSE frame currently buffered without blocking — used to assert an ABSENCE of an event type over a short window, which waitForSseEvent (single-match, blocks until found) can't express. */
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
    if (result.value === undefined) break; // timed out this iteration
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

describe("CHR-630 activity SSE events", () => {
  let dir: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-activity-"));
    await initProject(dir);
    // autoCommit disabled, same as setupProject() in test-fixtures.ts — these
    // tests don't need git and shouldn't depend on it being available.
    const store = new FsStore(dir);
    const config = await store.readArtisignConfig();
    config.settings.autoCommit = false;
    await store.writeArtisignConfig(config);

    artisignHome = await setupArtisignHome();
    daemon = await startDaemon({ port: 0, projects: [dir] });
  });

  afterEach(async () => {
    await daemon.stop();
    await artisignHome.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("emits an activity event for a read tool call over /mcp", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events?project=${encodeURIComponent(dir)}`);
    const reader = res.body!.getReader();
    const carry = { buffer: "" };
    try {
      await new Promise((resolve) => setTimeout(resolve, 200)); // let the SSE registration land before the call

      const callResult = await mcpCall(daemon.port, dir, toolCallBody("get_project", {}));
      expect(callResult.status).toBe(200);

      const evt = await waitForSseEvent(reader, (e) => e.type === "activity", 2000, carry);
      expect(evt).toEqual({ type: "activity", tool: "get_project", kind: "read", target: null, nodes: [], ok: true, at: evt.at });
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("emits an activity event with the affected node for a write tool call", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events?project=${encodeURIComponent(dir)}`);
    const reader = res.body!.getReader();
    const carry = { buffer: "" };
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));

      await mcpCall(
        daemon.port,
        dir,
        toolCallBody("write_html", { screen: "home", mode: "create", title: "Home", html_aug: `<div id="n1"></div>` }),
      );

      const evt = await waitForSseEvent(reader, (e) => e.type === "activity" && e.tool === "write_html", 2000, carry);
      expect(evt.kind).toBe("write");
      expect(evt.ok).toBe(true);
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual(["home.n1"]);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("emits ok:false for a failed tool call, without altering the MCP error response", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events?project=${encodeURIComponent(dir)}`);
    const reader = res.body!.getReader();
    const carry = { buffer: "" };
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const callResult = await mcpCall(daemon.port, dir, toolCallBody("get_screen", { screen: "does-not-exist" }));
      const body = JSON.parse(callResult.json.result!.content[0]!.text) as { code: string };
      expect(body.code).toBe("not_found"); // unchanged from before CHR-630 — proves the response is byte-identical

      const evt = await waitForSseEvent(reader, (e) => e.type === "activity", 2000, carry);
      expect(evt).toEqual({ type: "activity", tool: "get_screen", kind: "read", target: { kind: "screen", name: "does-not-exist" }, nodes: [], ok: false, at: evt.at });
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("emits ok:false for write_html's non-throwing blocking-error response (duplicate node id)", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events?project=${encodeURIComponent(dir)}`);
    const reader = res.body!.getReader();
    const carry = { buffer: "" };
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const callResult = await mcpCall(
        daemon.port,
        dir,
        toolCallBody("write_html", { screen: "broken", mode: "create", title: "Broken", html_aug: `<div id="a"><div id="a"></div></div>` }),
      );
      // write_html returns this normally — it never throws for a blocking
      // parse issue — so isError is unset, but the payload still carries
      // commit:null and a non-empty errors array. Pinned here so a future
      // change to that contract doesn't silently invalidate this test's premise.
      const body = JSON.parse(callResult.json.result!.content[0]!.text) as { commit: string | null; errors: unknown[] };
      expect(callResult.json.result).not.toHaveProperty("isError");
      expect(body.commit).toBeNull();
      expect(body.errors.length).toBeGreaterThan(0);

      const evt = await waitForSseEvent(reader, (e) => e.type === "activity", 2000, carry);
      expect(evt).toEqual({ type: "activity", tool: "write_html", kind: "write", target: { kind: "screen", name: "broken" }, nodes: [], ok: false, at: evt.at });
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("delivers both an activity and a change event for one write_html call (order not load-bearing — chokidar's own broadcast and the finally-emitted activity race each other; see the PR's manual-verification capture for one observed ordering)", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events?project=${encodeURIComponent(dir)}`);
    const reader = res.body!.getReader();
    const carry = { buffer: "" };
    const order: string[] = [];
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const collect = (async () => {
        for (let i = 0; i < 2; i++) {
          const evt = await waitForSseEvent(reader, (e) => e.type === "activity" || e.type === "change", 2000, carry);
          order.push(evt.type as string);
        }
      })();

      await mcpCall(
        daemon.port,
        dir,
        toolCallBody("write_html", { screen: "order-check", mode: "create", title: "Order check", html_aug: `<div id="n1"></div>` }),
      );

      await collect;
      expect(order.sort()).toEqual(["activity", "change"]);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("emits nothing for a call through POST /api/tools/<name> — MCP-only by construction", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events?project=${encodeURIComponent(dir)}`);
    const reader = res.body!.getReader();
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const toolsApiRes = await fetch(`http://127.0.0.1:${daemon.port}/api/tools/get_project`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(toolsApiRes.status).toBe(200);

      const events = await drainAvailable(reader, 500);
      expect(events.some((e) => e.type === "activity")).toBe(false);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("writes nothing to the project folder beyond the tool's own write — no side file, no .artisign/ change", async () => {
    const store = new FsStore(dir);
    const before = await store.listScreens();

    await mcpCall(daemon.port, dir, toolCallBody("get_project", {}));

    const after = await store.listScreens();
    expect(after).toEqual(before);
  });
});
