import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsStore } from "../store/fs-store.js";
import type { Store, TokensDocument, FlowRecord, ProjectChangeEvent, ScreenMeta, MockupMeta, DesignSystemMeta, CommitResult, HeadCommitResult } from "../store/index.js";
import { initProject } from "../init/init-project.js";
import { watchAndReindex } from "./live-index.js";
import type { ProjectIndex } from "./index-builder.js";

/** Minimal in-memory Store double giving tests full control over read timing/failure. */
class FakeStore implements Store {
  readonly projectDir = "/fake";
  private screens = new Map<string, string>();
  private tokens: TokensDocument = { color: {} };
  private watchers: Array<() => void> = [];
  private cache: unknown;
  readDelayMs = 0;
  failTokensRead = false;

  async readArtisignConfig() {
    return { name: "fake", version: "0.1.0", settings: { autoCommit: false, port: 4711 } };
  }
  async writeArtisignConfig() {}
  async listScreens(): Promise<string[]> {
    return [...this.screens.keys()];
  }
  async readScreen(name: string): Promise<string> {
    if (this.readDelayMs > 0) await new Promise((r) => setTimeout(r, this.readDelayMs));
    const html = this.screens.get(name);
    if (html === undefined) throw Object.assign(new Error(`ENOENT: ${name}`), { code: "ENOENT" });
    return html;
  }
  async writeScreen(name: string, html: string): Promise<void> {
    this.screens.set(name, html);
  }
  async deleteScreen(name: string): Promise<void> {
    this.screens.delete(name);
  }
  async readScreenMeta(): Promise<ScreenMeta> {
    return { notes: "", tags: [] };
  }
  async writeScreenMeta() {}
  async listMockups(): Promise<string[]> {
    return [];
  }
  async readMockupMeta(): Promise<MockupMeta> {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }
  async writeMockupMeta() {}
  async readMockupVariant(): Promise<string> {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }
  async writeMockupVariant() {}
  async deleteMockupVariant() {}
  async deleteMockup() {}
  async readDesignSystemMeta(): Promise<DesignSystemMeta> {
    return { idea: "", decisions: [], component_usage: {}, pattern_usage: {} };
  }
  async writeDesignSystemMeta() {}
  async listComponents(): Promise<string[]> {
    return [];
  }
  async readComponent(): Promise<string> {
    throw new Error("not implemented");
  }
  async writeComponent() {}
  async deleteComponent() {}
  async listPatterns(): Promise<string[]> {
    return [];
  }
  async readPattern(): Promise<string> {
    throw new Error("not implemented");
  }
  async writePattern() {}
  async deletePattern() {}
  async readTokens(): Promise<TokensDocument> {
    if (this.failTokensRead) throw new Error("simulated read failure");
    return this.tokens;
  }
  async writeTokens(tokens: TokensDocument) {
    this.tokens = tokens;
  }
  async readFlows(): Promise<FlowRecord[]> {
    return [];
  }
  async writeFlows() {}
  async readComments(): Promise<string[]> {
    return [];
  }
  async appendComment() {}
  async readAsset(): Promise<Buffer> {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }
  async readCacheIndex(): Promise<unknown> {
    return this.cache;
  }
  async writeCacheIndex(index: unknown) {
    this.cache = index;
  }
  watch(onChange: (event: ProjectChangeEvent) => void): () => void {
    const handler = (): void => onChange({ type: "change", path: "screens/home.html", category: "screen" });
    this.watchers.push(handler);
    return () => {
      this.watchers = this.watchers.filter((h) => h !== handler);
    };
  }
  async commit(): Promise<CommitResult> {
    return { sha: null, skipped_reason: "disabled" };
  }
  async headCommit(): Promise<HeadCommitResult> {
    return { sha: null, head_reason: "no_repo" };
  }

  /** Simulates the watcher firing a debounced change event. */
  trigger(): void {
    for (const handler of this.watchers) handler();
  }
}

describe("watchAndReindex", () => {
  let dir: string;
  let store: FsStore;
  let handle: { ready: Promise<void>; stop: () => Promise<void> } | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-live-index-"));
    await initProject(dir);
    store = new FsStore(dir);
    await store.writeScreen("home", `<div id="n1"></div>`);
  });

  afterEach(async () => {
    await handle?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("picks up an external screen edit and refreshes the in-memory + persisted index within ~200ms", async () => {
    const updates: ProjectIndex[] = [];
    handle = watchAndReindex(store, (index) => updates.push(index));
    await handle.ready;

    // Let chokidar finish its initial scan before making the external edit.
    await new Promise((resolve) => setTimeout(resolve, 150));

    await writeFile(join(dir, "screens", "home.html"), `<div id="n1"><span id="n2"></span></div>`);

    const start = Date.now();
    await new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => {
        if (updates.some((u) => u.screens.home?.nodeCount === 2)) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 500) {
          clearInterval(interval);
          reject(new Error("index was not refreshed in time"));
        }
      }, 5);
    });

    const persisted = (await store.readCacheIndex()) as ProjectIndex;
    expect(persisted.screens.home?.nodeCount).toBe(2);
  });

  it("passes each watcher event through to the optional onChange callback", async () => {
    const events: ProjectChangeEvent[] = [];
    handle = watchAndReindex(store, undefined, undefined, (event) => events.push(event));
    await handle.ready;

    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(join(dir, "screens", "home.html"), `<div id="n1"><span id="n2"></span></div>`);

    const start = Date.now();
    await new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => {
        if (events.some((e) => e.category === "screen")) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 500) {
          clearInterval(interval);
          reject(new Error("onChange was not called in time"));
        }
      }, 5);
    });
  });
});

describe("watchAndReindex — error handling and ordering", () => {
  it("never lets a failed rebuild escape as an unhandled promise rejection", async () => {
    const fake = new FakeStore();
    await fake.writeScreen("home", `<div id="n1"></div>`);
    fake.failTokensRead = true;

    const errors: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      // failTokensRead is already true, so the initial build (fired inside
      // watchAndReindex) fails too — one error from that, one from trigger().
      const handle = watchAndReindex(fake, undefined, (err) => errors.push(err));
      fake.trigger();

      // Give the rejected promise a chance to surface as unhandled, and the
      // error handler a chance to run.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(errors).toHaveLength(2);
      expect(unhandled).toEqual([]);
      await handle.stop();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("serializes concurrent rebuilds so a slower, earlier trigger never overwrites a later result", async () => {
    const fake = new FakeStore();
    await fake.writeScreen("home", `<div id="n1"></div>`);

    const updates: ProjectIndex[] = [];
    const handle = watchAndReindex(fake, (index) => updates.push(index));
    await handle.ready;

    // First trigger reads slowly (simulating a large screen)...
    fake.readDelayMs = 60;
    fake.trigger();

    // ...then, before it resolves, the screen changes again and a second,
    // faster trigger fires. If rebuilds ran concurrently and completed out
    // of order, the first (stale) rebuild could overwrite the index after
    // the second (fresh) one already persisted.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fake.writeScreen("home", `<div id="n1"><span id="n2"></span></div>`);
    fake.readDelayMs = 0;
    fake.trigger();

    await new Promise((resolve) => setTimeout(resolve, 150));

    const persisted = (await fake.readCacheIndex()) as ProjectIndex;
    expect(persisted.screens.home?.nodeCount).toBe(2);
    expect(updates.at(-1)?.screens.home?.nodeCount).toBe(2);

    await handle.stop();
  });
});
