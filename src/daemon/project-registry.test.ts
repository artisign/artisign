import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/init-project.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { ProjectRegistry } from "./project-registry.js";
import { readGlobalConfig } from "./global-config.js";
import { FsStore } from "../store/index.js";
import { ensureFontsCached, isMaterialSymbolsAvailable, __setFetchForTests, __resetFontMemoForTests } from "../model/fonts.js";

async function readIndex(root: string): Promise<{ screens: Record<string, { nodeCount: number }> }> {
  const raw = await readFile(join(root, ".artisign", "index.json"), "utf-8");
  return JSON.parse(raw) as { screens: Record<string, { nodeCount: number }> };
}

describe("ProjectRegistry", () => {
  let artisignHome: ArtisignHomeFixture;
  let registry: ProjectRegistry;
  const dirs: string[] = [];

  beforeEach(async () => {
    artisignHome = await setupArtisignHome();
    registry = new ProjectRegistry();
  });

  afterEach(async () => {
    await registry.closeAll();
    await artisignHome.cleanup();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** Waits until the watcher has dropped `dir` from the registry's listing. */
  async function waitUntilUnlisted(dir: string): Promise<void> {
    const start = Date.now();
    await new Promise<void>((resolveWait, reject) => {
      const interval = setInterval(() => {
        if (registry.get(dir) === undefined) {
          clearInterval(interval);
          resolveWait();
        } else if (Date.now() - start > 4000) {
          clearInterval(interval);
          reject(new Error("project was not evicted after artisign.json was deleted"));
        }
      }, 20);
    });
  }

  async function makeProject(screenHtml?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artisign-registry-"));
    dirs.push(dir);
    await initProject(dir);
    if (screenHtml !== undefined) {
      await writeFile(join(dir, "screens", "home.html"), screenHtml);
    }
    return dir;
  }

  it("open() builds .artisign/index.json for the project", async () => {
    const dir = await makeProject(`<div id="n1"></div>`);

    await registry.open(dir);

    const index = await readIndex(dir);
    expect(index.screens.home?.nodeCount).toBe(1);
  });

  it("open() is idempotent — re-opening an already-open root returns the same handle", async () => {
    const dir = await makeProject();

    const first = await registry.open(dir);
    const second = await registry.open(dir);

    expect(second).toBe(first);
    expect(second.store).toBe(first.store);
  });

  it("concurrent open() calls for the same not-yet-open root return the same handle, built once", async () => {
    const dir = await makeProject(`<div id="n1"></div>`);

    const [first, second, third] = await Promise.all([registry.open(dir), registry.open(dir), registry.open(dir)]);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(registry.list()).toHaveLength(1);
  });

  it("opens two projects in parallel with independent indices", async () => {
    const dirA = await makeProject(`<div id="a1"></div>`);
    const dirB = await makeProject(`<div id="b1"><span id="b2"></span></div>`);

    const [handleA, handleB] = await Promise.all([registry.open(dirA), registry.open(dirB)]);

    expect(handleA.root).toBe(dirA);
    expect(handleB.root).toBe(dirB);
    expect((await readIndex(dirA)).screens.home?.nodeCount).toBe(1);
    expect((await readIndex(dirB)).screens.home?.nodeCount).toBe(2);
  });

  it("an external edit to project A's screen updates only A's index, not B's", async () => {
    const dirA = await makeProject(`<div id="a1"></div>`);
    const dirB = await makeProject(`<div id="b1"></div>`);
    await Promise.all([registry.open(dirA), registry.open(dirB)]);

    // Let chokidar finish its initial scan before making the external edit
    // (same pattern as src/store/watcher.test.ts) — an edit racing ahead of
    // it is silently missed rather than queued.
    await new Promise((resolve) => setTimeout(resolve, 200));

    await writeFile(join(dirA, "screens", "home.html"), `<div id="a1"><span id="a2"></span></div>`);

    const start = Date.now();
    await new Promise<void>((resolve, reject) => {
      const interval = setInterval(async () => {
        const index = await readIndex(dirA).catch(() => ({ screens: {} as Record<string, { nodeCount: number }> }));
        if (index.screens.home?.nodeCount === 2) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 4000) {
          clearInterval(interval);
          reject(new Error("index A was not refreshed after external edit"));
        }
      }, 20);
    });

    expect((await readIndex(dirB)).screens.home?.nodeCount).toBe(1);
  }, 10000);

  it("close() stops the index watcher — a later external edit is no longer picked up", async () => {
    const dir = await makeProject(`<div id="n1"></div>`);
    await registry.open(dir);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await registry.close(dir);
    expect(registry.get(dir)).toBeUndefined();

    await writeFile(join(dir, "screens", "home.html"), `<div id="n1"></div><div id="n2"></div>`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect((await readIndex(dir)).screens.home?.nodeCount).toBe(1);
  });

  it("re-opening after deleting .artisign/ rebuilds an identical index (derived cache)", async () => {
    const dir = await makeProject(`<div id="n1"><span id="n2"></span></div>`);
    await registry.open(dir);
    const before = await readIndex(dir);
    await registry.close(dir);

    await rm(join(dir, ".artisign"), { recursive: true, force: true });

    await registry.open(dir);
    const after = await readIndex(dir);
    expect(after).toEqual(before);
  });

  it("rejects a directory without a readable artisign.json, naming the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artisign-registry-invalid-"));
    dirs.push(dir);

    await expect(registry.open(dir)).rejects.toThrow(dir);
  });

  it("rejects a directory whose artisign.json is not valid JSON, naming the path", async () => {
    const dir = await makeProject();
    await writeFile(join(dir, "artisign.json"), "not json");

    await expect(registry.open(dir)).rejects.toThrow(join(dir, "artisign.json"));
  });

  it("rejects a directory whose artisign.json is null, naming the path", async () => {
    const dir = await makeProject();
    await writeFile(join(dir, "artisign.json"), "null");

    await expect(registry.open(dir)).rejects.toThrow(join(dir, "artisign.json"));
    expect(registry.get(dir)).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("maintains recentProjects: front, dedupe, cap at 10", async () => {
    const dirA = await makeProject();
    const dirB = await makeProject();

    await registry.open(dirA);
    await registry.open(dirB);
    expect((await readGlobalConfig()).recentProjects).toEqual([dirB, dirA]);

    // Re-opening A (already open, idempotent) still bumps it to the front.
    await registry.open(dirA);
    expect((await readGlobalConfig()).recentProjects).toEqual([dirA, dirB]);

    const extraDirs = await Promise.all(Array.from({ length: 10 }, () => makeProject()));
    for (const dir of extraDirs) {
      await registry.open(dir);
    }
    const recentProjects = (await readGlobalConfig()).recentProjects ?? [];
    expect(recentProjects).toHaveLength(10);
    expect(recentProjects[0]).toBe(extraDirs[extraDirs.length - 1]);
    expect(recentProjects).not.toContain(dirA);
  });

  it("concurrent opens of two different roots both land in recentProjects (no lost update)", async () => {
    const dirA = await makeProject();
    const dirB = await makeProject();

    await Promise.all([registry.open(dirA), registry.open(dirB)]);

    const recentProjects = (await readGlobalConfig()).recentProjects ?? [];
    expect(recentProjects.sort()).toEqual([dirA, dirB].sort());
  });

  it("activeProject: unset until the first open(), unaffected by a second open()", async () => {
    expect(registry.activeProject).toBeUndefined();

    const dirA = await makeProject();
    await registry.open(dirA);
    expect(registry.activeProject).toBe(dirA);

    const dirB = await makeProject();
    await registry.open(dirB);
    expect(registry.activeProject).toBe(dirA);
  });

  it("activeProject setter validates the root is open", async () => {
    const dirA = await makeProject();
    const dirB = await makeProject();
    await registry.open(dirA);
    await registry.open(dirB);

    registry.activeProject = dirB;
    expect(registry.activeProject).toBe(dirB);

    expect(() => {
      registry.activeProject = join(tmpdir(), "never-opened");
    }).toThrow();
    expect(registry.activeProject).toBe(dirB);
  });

  it("closing the active project clears activeProject", async () => {
    const dir = await makeProject();
    await registry.open(dir);
    expect(registry.activeProject).toBe(dir);

    await registry.close(dir);
    expect(registry.activeProject).toBeUndefined();
  });

  it("list() returns every open project's handle", async () => {
    const dirA = await makeProject();
    const dirB = await makeProject();
    await registry.open(dirA);
    await registry.open(dirB);

    const roots = registry.list().map((h) => h.root);
    expect(roots.sort()).toEqual([dirA, dirB].sort());
  });

  it("open() sets handle.name from artisign.json", async () => {
    const dir = await makeProject();
    const store = new FsStore(dir);
    const config = await store.readArtisignConfig();
    config.name = "Custom Name";
    await store.writeArtisignConfig(config);

    const handle = await registry.open(dir);
    expect(handle.name).toBe("Custom Name");
  });

  it("editing artisign.json externally updates handle.name", async () => {
    const dir = await makeProject();
    const handle = await registry.open(dir);
    // Let chokidar finish its initial scan before the external edit — same
    // pattern as the "external edit" index test above.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const store = new FsStore(dir);
    const config = await store.readArtisignConfig();
    config.name = "Renamed";
    await store.writeArtisignConfig(config);

    const start = Date.now();
    await new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => {
        if (handle.name === "Renamed") {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 4000) {
          clearInterval(interval);
          reject(new Error("handle.name was not refreshed after external edit"));
        }
      }, 20);
    });
  }, 10000);

  it("an invalid artisign.json after open keeps the old name and does not throw", async () => {
    const dir = await makeProject();
    const handle = await registry.open(dir);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await writeFile(join(dir, "artisign.json"), "not json");
    // No good way to await "nothing happened" other than a fixed wait — the
    // debounce + failed re-read both complete well within this window.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(handle.name).not.toBe("");
    expect(registry.get(dir)).toBeDefined();
  });

  it("re-opening an already-open root does not rewrite the global config", async () => {
    const dir = await makeProject();
    await registry.open(dir);

    const configPath = join(artisignHome.home, "config.json");
    const before = await stat(configPath);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await registry.open(dir);

    const after = await stat(configPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("evicts a project whose root is deleted out from under the daemon", async () => {
    const dirA = await makeProject();
    const dirB = await makeProject();
    await registry.open(dirA);
    await registry.open(dirB);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(registry.activeProject).toBe(dirA);

    const events: { type: string; root: string }[] = [];
    const originalBroadcast = registry.lifecycle.broadcast.bind(registry.lifecycle);
    registry.lifecycle.broadcast = (event) => {
      events.push(event);
      originalBroadcast(event);
    };

    await rm(dirA, { recursive: true, force: true });

    const start = Date.now();
    await new Promise<void>((resolveWait, reject) => {
      const interval = setInterval(() => {
        if (registry.get(dirA) === undefined) {
          clearInterval(interval);
          resolveWait();
        } else if (Date.now() - start > 4000) {
          clearInterval(interval);
          reject(new Error("dirA was not evicted after its root was deleted"));
        }
      }, 20);
    });

    expect(registry.list().map((h) => h.root)).toEqual([dirB]);
    expect(registry.activeProject).toBe(dirB);
    expect(events).toContainEqual({ type: "project-closed", root: dirA });

    // A later close() on the already-evicted root is a no-op, not a crash.
    await expect(registry.close(dirA)).resolves.toBeUndefined();
  }, 10000);

  it("activeProject already names the surviving project at the moment project-closed is broadcast, and no separate project-switched follows", async () => {
    const dirA = await makeProject();
    const dirB = await makeProject();
    await registry.open(dirA);
    await registry.open(dirB);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(registry.activeProject).toBe(dirA);

    // A client reacting to "project-closed" with an immediate GET
    // /api/projects (as the frontend does) must see a consistent `active`
    // — never a root that's already gone. Snapshot activeProject as it was
    // at the exact moment of the broadcast, not at the end of the test
    // (where it's correct even without the fix).
    let activeAtProjectClosed: string | undefined;
    const events: { type: string; root: string }[] = [];
    const originalBroadcast = registry.lifecycle.broadcast.bind(registry.lifecycle);
    registry.lifecycle.broadcast = (event) => {
      events.push(event);
      if (event.type === "project-closed") activeAtProjectClosed = registry.activeProject;
      originalBroadcast(event);
    };

    await rm(dirA, { recursive: true, force: true });

    const start = Date.now();
    await new Promise<void>((resolveWait, reject) => {
      const interval = setInterval(() => {
        if (registry.get(dirA) === undefined) {
          clearInterval(interval);
          resolveWait();
        } else if (Date.now() - start > 4000) {
          clearInterval(interval);
          reject(new Error("dirA was not evicted after its root was deleted"));
        }
      }, 20);
    });

    expect(activeAtProjectClosed).toBe(dirB);
    // "project-closed" already carries the active-slot change; a second
    // "project-switched" for the same eviction would make every connected
    // client double its project-switch handling (see review finding 2).
    expect(events.some((e) => e.type === "project-switched")).toBe(false);
  }, 10000);

  it("evicts when only artisign.json is deleted, root directory still present", async () => {
    const dir = await makeProject();
    await registry.open(dir);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await rm(join(dir, "artisign.json"));

    await waitUntilUnlisted(dir);
    expect(registry.activeProject).toBeUndefined();
  }, 10000);

  it("settled() waits until an evicted project has stopped writing its index", async () => {
    const dir = await makeProject(`<div id="n1"></div>`);
    await registry.open(dir);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await rm(join(dir, "artisign.json"));
    await waitUntilUnlisted(dir);
    await registry.settled();

    // Dropping out of the registry only means "no longer listed" — the
    // watcher can still be flushing .artisign/index.json at that point.
    // After settled() it is gone, so nothing rebuilds the derived index.
    await rm(join(dir, ".artisign"), { recursive: true, force: true });
    await writeFile(join(dir, "screens", "home.html"), `<div id="n2"></div>`);
    await new Promise((resolve) => setTimeout(resolve, 500));

    await expect(stat(join(dir, ".artisign", "index.json"))).rejects.toThrow();
  }, 10000);

  it("does not evict when artisign.json is merely broken (hand-edited, not deleted)", async () => {
    const dir = await makeProject();
    await registry.open(dir);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await writeFile(join(dir, "artisign.json"), "not json");
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(registry.get(dir)).toBeDefined();
    expect(registry.activeProject).toBe(dir);
  });

  it("close() clears that project's font memo", async () => {
    __resetFontMemoForTests();
    const dir = await makeProject();
    const store = new FsStore(dir);
    __setFetchForTests((async () => new Response("not found", { status: 404 })) as typeof fetch);

    // The live fetch fails, but Material Symbols Rounded falls back to the
    // package's bundled woff2 (see src/model/fonts.ts), so it still memoizes
    // as available — the point of this test is that close() clears the
    // memoized status either way, not which status it was.
    await ensureFontsCached(store, []);
    expect(isMaterialSymbolsAvailable(dir)).toBe(true);

    await registry.open(dir);
    await registry.close(dir);

    expect(isMaterialSymbolsAvailable(dir)).toBeUndefined();
    __setFetchForTests(undefined);
  });
});
