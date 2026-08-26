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

/**
 * The headline acceptance criterion for `set_tokens`: "One set_tokens call
 * changes the primary colour across >= 3 screens, visible live in the
 * browser, with no screen file rewritten." Verifies the full chain: tool call -> tokens.json
 * write -> SSE kind:"tokens" -> /api/render reflects the new value on every
 * ref-carrying screen -> the screen files themselves are untouched.
 */
describe("set_tokens propagation", () => {
  let dir: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;
  let store: FsStore;
  const screenNames = ["home", "checkout", "settings"];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-set-tokens-propagation-"));
    await initProject(dir);
    store = new FsStore(dir);

    const tokens = await store.readTokens();
    tokens.color = { primary: "#3366ff" };
    await store.writeTokens(tokens);

    for (const name of screenNames) {
      await store.writeScreen(name, `<div id="n1" style="color: $color.primary">${name}</div>`);
    }

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

  it("propagates a token change to every ref-carrying screen live, without rewriting any screen file", async () => {
    const before = new Map<string, string>();
    for (const name of screenNames) before.set(name, await store.readScreen(name));

    const sse = await fetch(`http://127.0.0.1:${daemon.port}/events`);
    await new Promise((resolve) => setTimeout(resolve, 200)); // let chokidar finish its initial scan

    const { status, json: setResult } = await post("/api/tools/set_tokens", {
      tokens: { "color.primary": "#ff0000" },
      mode: "patch",
    });
    expect(status).toBe(200);
    expect(setResult.propagated_node_count).toBe(3);
    expect((setResult.affected_screens as string[]).sort()).toEqual(["checkout", "home", "settings"]);

    const evt = await waitForSseEvent(sse, (e) => e.kind === "tokens", 1000);
    expect(evt).toEqual({ type: "change", kind: "tokens", name: "tokens" });

    for (const name of screenNames) {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/render/${name}`);
      const html = await res.text();
      expect(html).toContain("#ff0000");
      expect(html).not.toContain("$color");
    }

    // No screen file was rewritten — the propagation is purely at render time.
    for (const name of screenNames) {
      expect(await store.readScreen(name)).toBe(before.get(name));
    }
  });
});
