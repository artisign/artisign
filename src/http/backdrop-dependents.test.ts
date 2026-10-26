import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupProject, setupArtisignHome, type ProjectFixture, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";
import { createBackdropDependents } from "./backdrop-dependents.js";

const root = (backdrop?: string): string => `<div id="r"${backdrop ? ` data-backdrop="${backdrop}"` : ""}></div>`;

describe("createBackdropDependents", () => {
  let fx: ProjectFixture;
  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("walks the chain transitively, nearest first, each dependent once", async () => {
    await fx.store.writeScreen("c", root());
    await fx.store.writeScreen("b", root("c"));
    await fx.store.writeScreen("a", root("b"));
    await fx.store.writeScreen("b2", root("c"));
    const deps = createBackdropDependents(fx.store);
    expect(await deps.of("c")).toEqual(["b", "b2", "a"]);
    expect(await deps.of("b")).toEqual(["a"]);
    expect(await deps.of("a")).toEqual([]);
  });

  it("terminates on a cycle on disk and never lists the source", async () => {
    await fx.store.writeScreen("a", root("b"));
    await fx.store.writeScreen("b", root("a"));
    expect(await createBackdropDependents(fx.store).of("a")).toEqual(["b"]);
  });

  it("finds dependents of a target that no longer exists", async () => {
    await fx.store.writeScreen("b", root("gone"));
    expect(await createBackdropDependents(fx.store).of("gone")).toEqual(["b"]);
  });

  it("rebuilds from source after invalidate and persists nothing", async () => {
    await fx.store.writeScreen("c", root());
    const deps = createBackdropDependents(fx.store);
    expect(await deps.of("c")).toEqual([]);
    await fx.store.writeScreen("b", root("c"));
    expect(await deps.of("c")).toEqual([]); // still the cached index
    deps.invalidate();
    expect(await deps.of("c")).toEqual(["b"]);
    expect(await readdir(join(fx.dir, ".artisign")).catch(() => [])).not.toContain("backdrops.json");
  });
});

/** Collects every SSE `change` event of a daemon's project, in arrival order. */
async function collectChanges(port: number): Promise<{ names: () => string[]; stop: () => Promise<void> }> {
  const res = await fetch(`http://127.0.0.1:${port}/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];
  let buffer = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const line = buffer.slice(0, idx).split("\n").find((l) => l.startsWith("data: "));
        buffer = buffer.slice(idx + 2);
        if (!line) continue;
        const evt = JSON.parse(line.slice(6)) as { type: string; kind?: string; name?: string };
        if (evt.type === "change" && evt.kind === "screen") events.push(evt.name!);
      }
    }
  })();
  return { names: () => events, stop: () => reader.cancel().catch(() => {}) };
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("SSE fan-out to backdrop dependents", () => {
  let fx: ProjectFixture;
  let home: ArtisignHomeFixture;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    fx = await setupProject();
    home = await setupArtisignHome();
    await fx.store.writeScreen("c", root());
    await fx.store.writeScreen("b", root("c"));
    await fx.store.writeScreen("a", root("b"));
    daemon = await startDaemon({ port: 0, projects: [fx.dir] });
    await settle(400);
  });
  afterEach(async () => {
    await daemon.stop();
    await home.cleanup();
    await fx.cleanup();
  });

  it("a change to C reaches B and A, source first, once each", async () => {
    const sse = await collectChanges(daemon.port);
    await writeFile(join(fx.dir, "screens", "c.html"), `<div id="r"><p id="x">edited</p></div>`);
    await settle(800);
    await sse.stop();
    expect(sse.names()).toEqual(["c", "b", "a"]);
  });

  it("deleting C reloads B and A", async () => {
    const sse = await collectChanges(daemon.port);
    await rm(join(fx.dir, "screens", "c.html"));
    await settle(800);
    await sse.stop();
    expect(sse.names()).toEqual(["c", "b", "a"]);
  });

  it("a cycle on disk does not loop", async () => {
    await writeFile(join(fx.dir, "screens", "c.html"), root("a"));
    await settle(800);
    const sse = await collectChanges(daemon.port);
    await writeFile(join(fx.dir, "screens", "c.html"), `<div id="r" data-backdrop="a"><i id="y"></i></div>`);
    await settle(800);
    await sse.stop();
    expect(sse.names()).toEqual(["c", "b", "a"]);
  });

  it("a sidecar change does not fan out", async () => {
    const sse = await collectChanges(daemon.port);
    await fx.store.writeScreenMeta("c", { notes: "n", tags: [] });
    await settle(800);
    await sse.stop();
    expect(sse.names()).toEqual(["c"]);
  });
});
