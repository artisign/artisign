import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initProject } from "../init/init-project.js";
import { FsStore } from "../store/index.js";
import { createBoardStateStore } from "../daemon/board-state.js";
import { deleteEntity } from "./lifecycle.js";
import type { ToolHandlerContext, Warning } from "./types.js";

const execFileAsync = promisify(execFile);
const git = async (dir: string, ...args: string[]) => (await execFileAsync("git", args, { cwd: dir })).stdout.trim();

describe("delete_entity — variant subtrees (ADR-006)", () => {
  let dir: string;
  let store: FsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-delete-variants-"));
    await initProject(dir); // autoCommit stays on, so commits are real
    store = new FsStore(dir);
    for (const n of ["root", "a", "a1", "a1x", "b", "other", "orphan", "lonely"]) await store.writeScreen(n, `<div id="n1"></div>`);
    const link = (screen: string, of: string, kind: "state" | "overlay" | "step" = "state") =>
      store.writeScreenMeta(screen, { notes: "", tags: [], variant_of: of, variant_kind: kind });
    await link("a", "root");
    await link("a1", "a", "overlay");
    await link("a1x", "a1", "step");
    await link("b", "root");
    await link("orphan", "gone"); // dangling parent: a main screen
    await store.commit("fixture");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("refuses a parent without cascade: has_variants with size and examples, nothing changes", async () => {
    await store.writeFlows([{ from: "root.n1", event: "tap", to: "other", to_kind: "screen" }]);
    await store.commit("flows");
    const head = await git(dir, "rev-parse", "HEAD");
    const screens = await store.listScreens();

    await expect(deleteEntity(store, { kind: "screen", name: "root" })).rejects.toMatchObject({
      code: "has_variants",
      message: expect.stringMatching(/4 variant screen\(s\).*a, b, a1, a1x/),
    });
    expect(await store.listScreens()).toEqual(screens);
    expect(await store.readFlows()).toHaveLength(1);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(await git(dir, "status", "--porcelain")).toBe("");
  });

  it("truncates the example list after five names", async () => {
    for (const n of ["c1", "c2", "c3", "c4", "c5", "c6"]) {
      await store.writeScreen(n, `<div id="n1"></div>`);
      await store.writeScreenMeta(n, { notes: "", tags: [], variant_of: "lonely", variant_kind: "state" });
    }
    await expect(deleteEntity(store, { kind: "screen", name: "lonely" })).rejects.toMatchObject({ message: expect.stringContaining("+1 more") });
  });

  it("cascade deletes the depth-3 subtree, sidecars and outgoing flows in exactly one commit", async () => {
    await store.writeFlows([
      { from: "a1x.n1", event: "tap", to: "other", to_kind: "screen" },
      { from: "a.n1", event: "tap", to: "a1", to_kind: "screen" }, // inside edge
      { from: "other.n1", event: "tap", to: "root", to_kind: "screen" }, // outside -> subtree
      { from: "other.n1", event: "hover", to: "a1x.n1", to_kind: "node" }, // outside -> subtree node
      { from: "other.n1", event: "tap", to: "b2", to_kind: "screen" },
    ]);
    await store.commit("flows");
    const before = Number(await git(dir, "rev-list", "--count", "HEAD"));

    const res = await deleteEntity(store, { kind: "screen", name: "a", cascade: true });

    expect(res.deleted_screens).toEqual(["a", "a1", "a1x"]);
    expect(res.removed_flow_count).toBe(2);
    expect(await store.listScreens()).toEqual(["b", "lonely", "orphan", "other", "root"]);
    expect((await store.readFlows()).map((f) => f.to)).toEqual(["root", "a1x.n1", "b2"]);
    expect(Number(await git(dir, "rev-list", "--count", "HEAD"))).toBe(before + 1);
    expect(res.commit).toBe(await git(dir, "rev-parse", "HEAD"));
    for (const n of ["a", "a1", "a1x"]) expect(await git(dir, "ls-files", `screens/${n}.*`)).toBe("");
  });

  it("warns dangling_flow for outside -> subtree edges only, one per edge", async () => {
    await store.writeFlows([
      { from: "a.n1", event: "tap", to: "a1", to_kind: "screen" },
      { from: "other.n1", event: "tap", to: "a", to_kind: "screen" },
      { from: "other.n2", event: "tap", to: "a1x.n1", to_kind: "node" },
    ]);
    const res = await deleteEntity(store, { kind: "screen", name: "a", cascade: true });
    const warnings = res.warnings as Warning[];
    expect(warnings.map((w) => [w.kind, w.target])).toEqual([
      ["dangling_flow", "other.n1"],
      ["dangling_flow", "other.n2"],
    ]);
  });

  it("prunes every deleted name from pinned and expanded", async () => {
    const board = createBoardStateStore();
    board.set({ pins: { op: "add", screens: ["a", "a1x", "b"] }, expanded: { op: "add", screens: ["a", "a1", "root"] } });
    const ctx: ToolHandlerContext = {
      viewState: {
        getBoardState: () => board.get(),
        setBoardState: (patch) => board.set(patch).state,
        pruneScreen: (name) => {
          board.pruneScreen(name);
        },
      },
    };
    await deleteEntity(store, { kind: "screen", name: "a", cascade: true }, ctx);
    expect(board.get().pinned).toEqual(["b"]);
    expect(board.get().expanded).toEqual(["root"]);
  });

  it("a child pointing at a different, missing parent does not block the delete", async () => {
    const res = await deleteEntity(store, { kind: "screen", name: "orphan" });
    expect(res).not.toHaveProperty("deleted_screens");
    expect(await store.listScreens()).not.toContain("orphan");
  });

  it("a leaf variant and a screen without variants delete exactly as before, cascade or not", async () => {
    const plain = await deleteEntity(store, { kind: "screen", name: "lonely" });
    const cascaded = await deleteEntity(store, { kind: "screen", name: "a1x", cascade: true });
    for (const res of [plain, cascaded]) {
      expect(Object.keys(res).sort()).toEqual(["commit", "kind", "name", "path", "removed_flow_count", "warnings"].sort());
    }
    expect(plain).toMatchObject({ kind: "screen", name: "lonely", path: "screens/lonely.html", removed_flow_count: 0, warnings: [] });
  });

  it("survives a hand-edited cycle in the sidecars", async () => {
    await store.writeScreenMeta("a", { notes: "", tags: [], variant_of: "a1x", variant_kind: "state" });
    const res = await deleteEntity(store, { kind: "screen", name: "a", cascade: true });
    expect((res.deleted_screens as string[]).sort()).toEqual(["a", "a1", "a1x"]);
  });

  it("rejects cascade: true on other kinds, but cascade: false is a no-op", async () => {
    await expect(deleteEntity(store, { kind: "component", name: "x", cascade: true })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(deleteEntity(store, { kind: "component", name: "x", cascade: false })).rejects.toMatchObject({ code: "not_found" });
  });

  it("with autoCommit off, commit is null and deleted_screens is still reported", async () => {
    const config = await store.readArtisignConfig();
    config.settings.autoCommit = false;
    await store.writeArtisignConfig(config);
    const res = await deleteEntity(store, { kind: "screen", name: "a", cascade: true });
    expect(res.commit).toBeNull();
    expect(res.deleted_screens).toEqual(["a", "a1", "a1x"]);
  });

  it("names the deleted subtree screen a flow targeted, not the requested root", async () => {
    await store.writeFlows([{ from: "other.n1", event: "tap", to: "a1x.n1", to_kind: "node" }]);
    const res = await deleteEntity(store, { kind: "screen", name: "a", cascade: true });
    expect((res.warnings as Warning[])[0]!.message).toBe('flow from "other.n1" still targets deleted screen "a1x"');
  });

  it("a delete failing on the 2nd of 3 screens propagates, prunes and commits what was deleted, and keeps the survivors' flows", async () => {
    await store.writeFlows([
      { from: "a.n1", event: "tap", to: "other", to_kind: "screen" },
      { from: "a1.n1", event: "tap", to: "other", to_kind: "screen" },
      { from: "a1x.n1", event: "tap", to: "other", to_kind: "screen" },
    ]);
    await store.commit("flows");
    const board = createBoardStateStore();
    board.set({ pins: { op: "add", screens: ["a", "a1", "a1x"] } });
    const ctx: ToolHandlerContext = {
      viewState: {
        getBoardState: () => board.get(),
        setBoardState: (patch) => board.set(patch).state,
        pruneScreen: (n) => {
          board.pruneScreen(n);
        },
      },
    };
    const real = store.deleteScreen.bind(store);
    let calls = 0;
    vi.spyOn(store, "deleteScreen").mockImplementation(async (n: string) => {
      if (++calls === 2) throw new Error("disk on fire");
      return real(n);
    });

    await expect(deleteEntity(store, { kind: "screen", name: "a", cascade: true }, ctx)).rejects.toThrow("disk on fire");

    expect(await store.listScreens()).not.toContain("a");
    expect(await store.listScreens()).toEqual(expect.arrayContaining(["a1", "a1x"]));
    expect(board.get().pinned).toEqual(["a1", "a1x"]);
    expect((await store.readFlows()).map((f) => f.from)).toEqual(["a1.n1", "a1x.n1"]);
    expect(await git(dir, "log", "-1", "--format=%s")).toBe("delete_entity: screen:a (+2 variants)");
  });
});
