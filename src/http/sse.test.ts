import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("GET /events (SSE)", () => {
  let dir: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-sse-"));
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

  it("responds with a text/event-stream connection", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  it("broadcasts a change event within ~200ms of a Store write", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events`);
    const store = new FsStore(dir);
    // Let chokidar finish its initial scan before the timed write (same
    // pattern as the external-file-edit case below) — without it, this
    // measures connection/watcher warm-up time under load, not propagation
    // latency, and intermittently blows the tight budget on a busy machine.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const start = Date.now();
    await store.writeScreen("home", `<div id="n1"></div>`);
    const evt = await waitForSseEvent(res, (e) => e.kind === "screen" && e.name === "home", 1000);

    expect(Date.now() - start).toBeLessThan(1000);
    expect(evt).toEqual({ type: "change", kind: "screen", name: "home" });
  });

  it("broadcasts a change event within ~200ms of an external file edit", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events`);
    // Let chokidar finish its initial scan before making the external edit
    // (same pattern used throughout the watcher test suite).
    await new Promise((resolve) => setTimeout(resolve, 200));

    await writeFile(join(dir, "screens", "about.html"), `<div id="n1"></div>`);
    const evt = await waitForSseEvent(res, (e) => e.kind === "screen" && e.name === "about", 2000);
    expect(evt).toEqual({ type: "change", kind: "screen", name: "about" });
  });

  it("categorizes non-screen changes correctly", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events`);
    const store = new FsStore(dir);

    const tokens = await store.readTokens();
    tokens.color = { primary: "#000" };
    await store.writeTokens(tokens);

    const evt = await waitForSseEvent(res, (e) => e.kind === "tokens", 500);
    expect(evt).toEqual({ type: "change", kind: "tokens", name: "tokens" });
  });

  it("broadcasts a screen meta change under the screen's own name", async () => {
    const store = new FsStore(dir);
    // Write the screen itself first so its own "screen"/"home" change event
    // doesn't race with (and satisfy) the meta-write predicate below.
    await store.writeScreen("home", `<div id="n1"></div>`);

    const res = await fetch(`http://127.0.0.1:${daemon.port}/events`);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await store.writeScreenMeta("home", { notes: "wip", tags: ["a"] });
    const evt = await waitForSseEvent(res, (e) => e.kind === "screen" && e.name === "home", 1000);
    expect(evt).toEqual({ type: "change", kind: "screen", name: "home" });
  });

  it("broadcasts a mockup variant write under the mockup's directory name, not the variant id", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events`);
    const store = new FsStore(dir);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await store.writeMockupVariant("assign-caregiver", "a", "<div></div>");
    const evt = await waitForSseEvent(res, (e) => e.kind === "mockup", 1000);
    expect(evt).toEqual({ type: "change", kind: "mockup", name: "assign-caregiver" });
  });

  it("broadcasts a mockup meta write under the mockup's directory name", async () => {
    const store = new FsStore(dir);
    // Let chokidar finish its initial recursive scan of the fresh project dir
    // (same pattern as every other test in this file) before creating the
    // mockup's brand-new subdirectory — without this wait, the subdir's
    // creation can race chokidar's own initial scan discovering it, which
    // (with ignoreInitial: true) silently swallows the add rather than
    // reporting it live.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await store.writeMockupVariant("assign-caregiver", "a", "<div></div>");

    const res = await fetch(`http://127.0.0.1:${daemon.port}/events`);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await store.writeMockupMeta("assign-caregiver", { variants: [{ id: "a", title: "a", description: "" }] });
    const evt = await waitForSseEvent(res, (e) => e.kind === "mockup" && e.name === "assign-caregiver", 1000);
    expect(evt).toEqual({ type: "change", kind: "mockup", name: "assign-caregiver" });
  });

  it("passes through the design_system_meta kind for design-system/meta.json", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events`);
    const store = new FsStore(dir);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await store.writeDesignSystemMeta({ idea: "x", decisions: [], component_usage: {}, pattern_usage: {} });
    const evt = await waitForSseEvent(res, (e) => e.kind === "design_system_meta", 1000);
    expect(evt.kind).toBe("design_system_meta");
  });

  it("rejects a cross-origin /events connection", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("stops promptly even with an open SSE connection, e.g. a preview tab left open", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/events`);
    expect(res.status).toBe(200);
    // Deliberately don't cancel/consume the body — this is exactly what an
    // open preview tab's EventSource connection looks like from the server.

    const stopped = daemon.stop();
    const timedOut = Symbol("timed out");
    const result = await Promise.race([stopped, new Promise((resolve) => setTimeout(() => resolve(timedOut), 2000))]);
    expect(result).not.toBe(timedOut);

    await stopped; // afterEach also calls daemon.stop(); it's idempotent, so this just confirms it already settled.
  }, 5000);
});
