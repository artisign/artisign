import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/init-project.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";
import { FsStore } from "../store/index.js";

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

describe("/api/comments", () => {
  let dir: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;
  let store: FsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-comments-routes-"));
    await initProject(dir);
    store = new FsStore(dir);
    await store.writeScreen("home", `<div id="n1"><button id="n2"></button></div>`);

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

  async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  describe("POST", () => {
    it("creates a comment anchored to a node and returns the full record", async () => {
      const { status, json } = await post("/api/comments", { screen: "home", node_id: "n2", text: "make this bigger" });
      expect(status).toBe(201);
      expect(json).toMatchObject({
        screen: "home",
        node_id: "home.n2",
        author: "human",
        text: "make this bigger",
        parent_id: null,
        resolved: false,
      });
      expect(json.id).toMatch(/^cmt_[0-9a-f]{16}$/);
      expect(typeof json.ts).toBe("string");
    });

    it("allows a screen-level comment (no node_id)", async () => {
      const { status, json } = await post("/api/comments", { screen: "home", text: "overall looks off" });
      expect(status).toBe(201);
      expect(json.node_id).toBeNull();
    });

    it("allows a human reply via parent_id, inheriting the thread's screen/node", async () => {
      const { json: root } = await post("/api/comments", { screen: "home", node_id: "n2", text: "make this bigger" });
      const { status, json: reply } = await post("/api/comments", { parent_id: root.id, text: "still waiting", resolved: true });

      expect(status).toBe(201);
      expect(reply.parent_id).toBe(root.id);
      expect(reply.screen).toBe("home");
      expect(reply.node_id).toBe("home.n2");
      expect(reply.resolved).toBe(true);
    });

    it("rejects a reply to an unknown parent_id", async () => {
      const { status, json } = await post("/api/comments", { parent_id: "cmt_missing", text: "x" });
      expect(status).toBe(404);
      expect(json.code).toBe("not_found");
    });

    it("rejects a request missing screen (for a new root comment)", async () => {
      const { status, json } = await post("/api/comments", { text: "x" });
      expect(status).toBe(400);
      expect(json.code).toBe("validation_failed");
    });

    it("rejects a request missing text", async () => {
      const { status, json } = await post("/api/comments", { screen: "home" });
      expect(status).toBe(400);
      expect(json.code).toBe("validation_failed");
    });

    it("rejects a comment on a screen that doesn't exist, so an orphaned record never sits in the log forever", async () => {
      const { status, json } = await post("/api/comments", { screen: "does-not-exist", text: "x" });
      expect(status).toBe(404);
      expect(json.code).toBe("not_found");
    });

    it("rejects a comment on a node that doesn't exist on the given screen", async () => {
      const { status, json } = await post("/api/comments", { screen: "home", node_id: "does-not-exist", text: "x" });
      expect(status).toBe(404);
      expect(json.code).toBe("not_found");
    });

    it("rejects a cross-origin request", async () => {
      const { status } = await post("/api/comments", { screen: "home", text: "x" }, { origin: "https://evil.example" });
      expect(status).toBe(403);
    });

    it("rejects an oversized body with 413", async () => {
      const { status, json } = await post("/api/comments", { screen: "home", text: "a".repeat(300 * 1024) });
      expect(status).toBe(413);
      expect(json.code).toBe("validation_failed");
    });

    it("rejects a non-JSON content-type", async () => {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/comments`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ screen: "home", text: "x" }),
      });
      expect(res.status).toBe(403);
    });

    it("appends a valid, human-readable JSONL line via the Store (atomic — no .tmp files left behind)", async () => {
      await post("/api/comments", { screen: "home", node_id: "n2", text: "make this bigger" });
      const lines = await store.readComments();
      expect(lines).toHaveLength(1);
      expect(() => JSON.parse(lines[0]!)).not.toThrow();
    });

    it("fires an SSE kind:\"comments\" event when a comment is appended", async () => {
      const sse = await fetch(`http://127.0.0.1:${daemon.port}/events`);
      await new Promise((resolve) => setTimeout(resolve, 200)); // let chokidar finish its initial scan

      const start = Date.now();
      await post("/api/comments", { screen: "home", node_id: "n2", text: "make this bigger" });
      const evt = await waitForSseEvent(sse, (e) => e.kind === "comments", 1000);

      expect(Date.now() - start).toBeLessThan(1000);
      expect(evt.type).toBe("change");
    });
  });

  describe("GET", () => {
    it("returns the screen's comments flat, with resolved and parent_id", async () => {
      const { json: root } = await post("/api/comments", { screen: "home", node_id: "n2", text: "make this bigger" });
      await post("/api/comments", { parent_id: root.id, text: "on it" });

      const { status, json } = await get("/api/comments?screen=home");
      expect(status).toBe(200);
      const comments = json.comments as Array<{ id: string; screen: string; node_id: string | null; text: string; parent_id: string | null; resolved: boolean }>;
      expect(comments).toHaveLength(2);
      expect(comments[0]).toMatchObject({ screen: "home", node_id: "home.n2", text: "make this bigger", parent_id: null, resolved: false });
      expect(comments[1]).toMatchObject({ parent_id: root.id, text: "on it" });
    });

    it("scopes to the given screen only", async () => {
      await store.writeScreen("about", `<div id="n1"></div>`);
      await post("/api/comments", { screen: "home", text: "a" });
      await post("/api/comments", { screen: "about", text: "b" });

      const { json } = await get("/api/comments?screen=home");
      expect((json.comments as unknown[]).length).toBe(1);
    });

    it("requires a screen query parameter", async () => {
      const { status, json } = await get("/api/comments");
      expect(status).toBe(400);
      expect(json.code).toBe("validation_failed");
    });

    it("rejects a cross-origin request", async () => {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/comments?screen=home`, {
        headers: { origin: "https://evil.example" },
      });
      expect(res.status).toBe(403);
    });

    it("skips a malformed comments.jsonl line instead of 500ing", async () => {
      await post("/api/comments", { screen: "home", text: "fine" });
      await store.appendComment("not valid json");

      const { status, json } = await get("/api/comments?screen=home");
      expect(status).toBe(200);
      expect((json.comments as unknown[]).length).toBe(1);
      expect(json.skipped_malformed_lines).toBe(1);
    });
  });

  it("is readable via the generic list_comments tool route right after creation (full acceptance flow)", async () => {
    // node_id here is "n2" — a bare element id, exactly what the browser sends
    // (el.id has no dots). list_comments/find_nodes match against the full
    // "<screen>.<node-id>" ref, so this only passes if createComment
    // normalizes on the way in.
    const { json: created } = await post("/api/comments", { screen: "home", node_id: "n2", text: "make this bigger" });

    const listRes = await post("/api/tools/list_comments", { node: "home.n2" });
    expect(listRes.status).toBe(200);
    expect((listRes.json.comments as Array<{ id: string }>).map((c) => c.id)).toEqual([created.id]);

    const replyRes = await post("/api/tools/reply_comment", { comment_id: created.id, body: "on it", resolve: true });
    expect(replyRes.status).toBe(200);
    expect(replyRes.json.status).toBe("resolved");

    const afterReply = await post("/api/tools/list_comments", { node: "home.n2", status: "any", include_replies: true });
    const bodies = (afterReply.json.comments as Array<{ body: string }>).map((c) => c.body);
    expect(bodies).toEqual(["make this bigger", "on it"]);
  });
});
