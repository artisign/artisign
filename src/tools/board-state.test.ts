import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { setBoardState } from "./board-state.js";
import { createBoardStateStore } from "../daemon/board-state.js";
import { ToolError, type ToolHandlerContext, type BoardStatePatch } from "./types.js";

/**
 * A real `BoardStateStore` wired into a `ViewState` the same shape
 * `src/http/server.ts`'s `buildViewState` composes — minus the SSE
 * broadcast, which is that function's own concern (covered instead by the
 * daemon-level integration tests in `src/http/board-state-events.test.ts`).
 * `broadcasts` records every state a `changed:true` patch produced, so a
 * test can assert "no broadcast on a pure read / a no-op patch" without a
 * real SseHub.
 */
function fakeViewState(): { ctx: ToolHandlerContext; broadcasts: unknown[] } {
  const store = createBoardStateStore();
  const broadcasts: unknown[] = [];
  const ctx: ToolHandlerContext = {
    viewState: {
      getBoardState: () => store.get(),
      setBoardState: (patch: BoardStatePatch) => {
        const { state, changed } = store.set(patch);
        if (changed) broadcasts.push(state);
        return state;
      },
      pruneScreen: (name: string) => {
        const { state, changed } = store.pruneScreen(name);
        if (changed) broadcasts.push(state);
      },
    },
  };
  return { ctx, broadcasts };
}

describe("set_board_state", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    await fx.store.writeScreen("checkout", `<div id="n1"></div>`);
    await fx.store.writeScreenMeta("checkout", { notes: "", tags: ["payments"] });
  });
  afterEach(() => fx.cleanup());

  it("throws invalid_state when ctx.viewState is absent (stdio-equivalent)", async () => {
    await expect(setBoardState(fx.store, {})).rejects.toMatchObject({ code: "invalid_state" });
    await expect(setBoardState(fx.store, {}, {})).rejects.toBeInstanceOf(ToolError);
  });

  it("a write drops a pin whose screen vanished outside delete_entity; a pure read leaves the state alone", async () => {
    const { ctx, broadcasts } = fakeViewState();
    await setBoardState(fx.store, { pins: { op: "set", screens: ["home", "checkout"] } }, ctx);
    await fx.store.deleteScreen("home"); // e.g. a branch switch — no delete_entity, so no prune hook ran
    broadcasts.length = 0;

    const read = await setBoardState(fx.store, {}, ctx);
    expect(read.pinned).toEqual(["home", "checkout"]);
    expect(read.shown_screens).toEqual(["checkout"]);
    expect(broadcasts).toEqual([]);

    const write = await setBoardState(fx.store, { filter: "pay" }, ctx);
    expect(write.pinned).toEqual(["checkout"]);
    expect(broadcasts.at(-1)).toEqual({ filter: "pay", pinned: ["checkout"] });
  });

  it("op:set naming only unknown screens leaves the existing pins alone instead of clearing them", async () => {
    const { ctx, broadcasts } = fakeViewState();
    await setBoardState(fx.store, { pins: { op: "set", screens: ["home"] } }, ctx);
    broadcasts.length = 0;

    const res = await setBoardState(fx.store, { pins: { op: "set", screens: ["chekout"] } }, ctx);
    expect(res.pinned).toEqual(["home"]);
    expect(res.warnings).toEqual([{ kind: "unknown_ref", message: 'screen "chekout" was not found' }]);
    expect(broadcasts).toEqual([]);

    const cleared = await setBoardState(fx.store, { pins: { op: "set", screens: [] } }, ctx);
    expect(cleared.pinned).toEqual([]);
  });

  it("a call with every field omitted is a pure read — filter/pinned reflect current state, no broadcast", async () => {
    const { ctx, broadcasts } = fakeViewState();
    await setBoardState(fx.store, { filter: "checkout" }, ctx);
    broadcasts.length = 0;

    const res = await setBoardState(fx.store, {}, ctx);
    expect(res).toMatchObject({ filter: "checkout", pinned: [] });
    expect(broadcasts).toEqual([]);
  });

  it("sets the filter and returns shown_screens matching name or tag, case-insensitively", async () => {
    const { ctx } = fakeViewState();
    const res = await setBoardState(fx.store, { filter: "PAYMENTS" }, ctx);
    expect(res.filter).toBe("PAYMENTS");
    expect(res.shown_screens).toEqual(["checkout"]); // matches the tag, not the name
  });

  it("clearing the filter (null) shows every screen again", async () => {
    const { ctx } = fakeViewState();
    await setBoardState(fx.store, { filter: "checkout" }, ctx);
    const res = await setBoardState(fx.store, { filter: null }, ctx);
    expect(res.filter).toBeNull();
    // shown_screens follows store.listScreens()'s own order (alphabetical
    // on FsStore), not write order.
    expect((res.shown_screens as string[]).sort()).toEqual(["checkout", "home"]);
  });

  it("shown_screens is filter matches UNION pinned — a pinned screen shows even when it doesn't match the filter", async () => {
    const { ctx } = fakeViewState();
    await setBoardState(fx.store, { pins: { op: "add", screens: ["home"] } }, ctx);
    const res = await setBoardState(fx.store, { filter: "checkout" }, ctx);
    expect((res.shown_screens as string[]).sort()).toEqual(["checkout", "home"]);
  });

  it("op:add — an unknown screen name warns but never enters pinned; the known names in the same call still apply", async () => {
    const { ctx } = fakeViewState();
    const res = await setBoardState(fx.store, { pins: { op: "add", screens: ["home", "does-not-exist"] } }, ctx);
    expect(res.pinned).toEqual(["home"]);
    expect(res.warnings).toEqual([{ kind: "unknown_ref", message: 'screen "does-not-exist" was not found' }]);
  });

  it("op:set — an unknown screen name warns but never enters pinned; the known names in the same call still apply", async () => {
    const { ctx } = fakeViewState();
    const res = await setBoardState(fx.store, { pins: { op: "set", screens: ["home", "does-not-exist", "checkout"] } }, ctx);
    expect(res.pinned).toEqual(["home", "checkout"]);
    expect(res.warnings).toEqual([{ kind: "unknown_ref", message: 'screen "does-not-exist" was not found' }]);
  });

  it("op:add with ONLY unknown names is a no-op — no state change, no broadcast, warnings still returned", async () => {
    const { ctx, broadcasts } = fakeViewState();
    await setBoardState(fx.store, { pins: { op: "add", screens: ["home"] } }, ctx);
    broadcasts.length = 0;

    const res = await setBoardState(fx.store, { pins: { op: "add", screens: ["ghost-1", "ghost-2"] } }, ctx);
    expect(res.pinned).toEqual(["home"]); // unchanged
    expect(res.warnings).toEqual([
      { kind: "unknown_ref", message: 'screen "ghost-1" was not found' },
      { kind: "unknown_ref", message: 'screen "ghost-2" was not found' },
    ]);
    expect(broadcasts).toEqual([]);
  });

  it("pins:clear needs no screens field and produces no unknown-name warning", async () => {
    const { ctx } = fakeViewState();
    await setBoardState(fx.store, { pins: { op: "add", screens: ["home"] } }, ctx);
    const res = await setBoardState(fx.store, { pins: { op: "clear" } }, ctx);
    expect(res.pinned).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it("broadcasts (via ctx.viewState) exactly once per call that actually changes state", async () => {
    const { ctx, broadcasts } = fakeViewState();
    await setBoardState(fx.store, { filter: "checkout" }, ctx);
    expect(broadcasts).toHaveLength(1);

    // Same filter again — BoardStateStore reports changed:false, no broadcast.
    await setBoardState(fx.store, { filter: "checkout" }, ctx);
    expect(broadcasts).toHaveLength(1);
  });

  it("an empty pinned array stays [] in the response, not omitted", async () => {
    const { ctx } = fakeViewState();
    const res = await setBoardState(fx.store, { filter: "home" }, ctx);
    expect(res.pinned).toEqual([]);
  });

  it("an empty or whitespace-only filter on an already-null filter is a no-op — no change, no broadcast", async () => {
    const { ctx, broadcasts } = fakeViewState();
    const empty = await setBoardState(fx.store, { filter: "" }, ctx);
    expect(empty.filter).toBeNull();
    const whitespace = await setBoardState(fx.store, { filter: "   " }, ctx);
    expect(whitespace.filter).toBeNull();
    expect(broadcasts).toEqual([]);
  });

  it("an empty or whitespace-only filter clears an already-set filter, with exactly one broadcast", async () => {
    const { ctx, broadcasts } = fakeViewState();
    await setBoardState(fx.store, { filter: "checkout" }, ctx);
    broadcasts.length = 0;

    const res = await setBoardState(fx.store, { filter: "   " }, ctx);
    expect(res.filter).toBeNull();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ filter: null });
  });

  it("a non-empty filter is stored exactly as given, not trimmed", async () => {
    const { ctx } = fakeViewState();
    const res = await setBoardState(fx.store, { filter: "  checkout  " }, ctx);
    expect(res.filter).toBe("  checkout  ");
    // Matching itself still trims/lowercases, so the untrimmed stored value
    // still matches correctly.
    expect(res.shown_screens).toEqual(["checkout"]);
  });
});
