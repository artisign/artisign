import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, writeFile } from "node:fs/promises";
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
    expect(await deps.update("c")).toEqual(["b", "b2", "a"]);
    expect(await deps.update("b")).toEqual(["a"]);
    expect(await deps.update("a")).toEqual([]);
  });

  it("terminates on a cycle on disk and never lists the source", async () => {
    await fx.store.writeScreen("a", root("b"));
    await fx.store.writeScreen("b", root("a"));
    expect(await createBackdropDependents(fx.store).update("a")).toEqual(["b"]);
  });

  it("finds dependents of a target that no longer exists", async () => {
    await fx.store.writeScreen("b", root("gone"));
    expect(await createBackdropDependents(fx.store).update("gone")).toEqual(["b"]);
  });

  it("updates one screen at a time: a new edge, a changed edge, a removed edge, a deleted file", async () => {
    await fx.store.writeScreen("c", root());
    await fx.store.writeScreen("d", root());
    const deps = createBackdropDependents(fx.store);
    expect(await deps.update("c")).toEqual([]);

    await fx.store.writeScreen("b", root("c"));
    expect(await deps.update("b")).toEqual([]);
    expect(await deps.update("c")).toEqual(["b"]);

    await fx.store.writeScreen("b", root("d"));
    await deps.update("b");
    expect(await deps.update("c")).toEqual([]);
    expect(await deps.update("d")).toEqual(["b"]);

    await fx.store.writeScreen("b", root());
    await deps.update("b");
    expect(await deps.update("d")).toEqual([]);

    await fx.store.writeScreen("b", root("d"));
    await deps.update("b");
    await fx.store.deleteScreen("b");
    await deps.update("b");
    expect(await deps.update("d")).toEqual([]);
  });

  it("re-reads only the changed screen: other edits stay unseen until reset", async () => {
    await fx.store.writeScreen("c", root());
    const deps = createBackdropDependents(fx.store);
    await deps.update("c");
    await fx.store.writeScreen("b", root("c"));
    expect(await deps.update("c")).toEqual([]);
    deps.reset();
    expect(await deps.update("c")).toEqual(["b"]);
  });

  it("is independent of tokens.json and components", async () => {
    await fx.store.writeScreen("c", root());
    await fx.store.writeScreen("b", root("c"));
    await writeFile(join(fx.dir, "design-system", "tokens.json"), "{ not json");
    expect(await createBackdropDependents(fx.store).update("c")).toEqual(["b"]);
  });

  it("answers a burst in call order", async () => {
    await fx.store.writeScreen("c", root());
    await fx.store.writeScreen("b", root());
    const deps = createBackdropDependents(fx.store);
    await deps.update("c");
    await fx.store.writeScreen("b", root("c"));
    const first = deps.update("b");
    const second = deps.update("c");
    expect(await first).toEqual([]);
    expect(await second).toEqual(["b"]);
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

  it("keeps fanning out with a broken tokens.json", async () => {
    await writeFile(join(fx.dir, "design-system", "tokens.json"), "{ not json");
    const sse = await collectChanges(daemon.port);
    await writeFile(join(fx.dir, "screens", "c.html"), `<div id="r"><p id="x">edited</p></div>`);
    await settle(800);
    await sse.stop();
    expect(sse.names()).toEqual(["c", "b", "a"]);
  });

  it("catches up after edits made while nobody was listening", async () => {
    const first = await collectChanges(daemon.port);
    await writeFile(join(fx.dir, "screens", "c.html"), `<div id="r"><i id="y"></i></div>`);
    await settle(600);
    await first.stop();
    await settle(200);
    // no client: this edge is not seen by any index
    await writeFile(join(fx.dir, "screens", "d.html"), `<div id="r" data-backdrop="c"></div>`);
    await settle(600);
    const sse = await collectChanges(daemon.port);
    await writeFile(join(fx.dir, "screens", "c.html"), `<div id="r"><b id="z"></b></div>`);
    await settle(800);
    await sse.stop();
    expect(sse.names()).toEqual(["c", "b", "d", "a"]);
  });

  it("a sidecar change does not fan out", async () => {
    const sse = await collectChanges(daemon.port);
    await fx.store.writeScreenMeta("c", { notes: "n", tags: [] });
    await settle(800);
    await sse.stop();
    expect(sse.names()).toEqual(["c"]);
  });
});
