import { describe, it, expect } from "vitest";
import { createBoardStateStore } from "./board-state.js";

describe("BoardStateStore", () => {
  it("starts at {filter: null, pinned: []}", () => {
    const store = createBoardStateStore();
    expect(store.get()).toEqual({ filter: null, pinned: [] });
  });

  it("sets the filter, reports changed:true", () => {
    const store = createBoardStateStore();
    const { state, changed } = store.set({ filter: "checkout" });
    expect(state).toEqual({ filter: "checkout", pinned: [] });
    expect(changed).toBe(true);
  });

  it("clears the filter with null, distinct from an omitted (unchanged) filter", () => {
    const store = createBoardStateStore();
    store.set({ filter: "checkout" });
    const { state } = store.set({});
    expect(state.filter).toBe("checkout"); // omitted — unchanged

    const { state: cleared, changed } = store.set({ filter: null });
    expect(cleared.filter).toBeNull();
    expect(changed).toBe(true);
  });

  it("reports changed:false when a patch doesn't actually move the state", () => {
    const store = createBoardStateStore();
    store.set({ filter: "checkout" });
    const { changed } = store.set({ filter: "checkout" });
    expect(changed).toBe(false);
  });

  it("pins add, dedupes, and preserves insertion order", () => {
    const store = createBoardStateStore();
    store.set({ pins: { op: "add", screens: ["home", "checkout"] } });
    const { state, changed } = store.set({ pins: { op: "add", screens: ["checkout", "cart"] } });
    expect(state.pinned).toEqual(["home", "checkout", "cart"]);
    expect(changed).toBe(true);
  });

  it("pins add is a no-op (changed:false) when every screen is already pinned", () => {
    const store = createBoardStateStore();
    store.set({ pins: { op: "add", screens: ["home"] } });
    const { changed } = store.set({ pins: { op: "add", screens: ["home"] } });
    expect(changed).toBe(false);
  });

  it("pins remove drops only the named screens", () => {
    const store = createBoardStateStore();
    store.set({ pins: { op: "add", screens: ["home", "checkout", "cart"] } });
    const { state } = store.set({ pins: { op: "remove", screens: ["checkout"] } });
    expect(state.pinned).toEqual(["home", "cart"]);
  });

  it("pins set replaces the pinned set exactly, deduped", () => {
    const store = createBoardStateStore();
    store.set({ pins: { op: "add", screens: ["home"] } });
    const { state } = store.set({ pins: { op: "set", screens: ["checkout", "checkout", "cart"] } });
    expect(state.pinned).toEqual(["checkout", "cart"]);
  });

  it("pins clear empties the pinned set", () => {
    const store = createBoardStateStore();
    store.set({ pins: { op: "add", screens: ["home", "checkout"] } });
    const { state, changed } = store.set({ pins: { op: "clear" } });
    expect(state.pinned).toEqual([]);
    expect(changed).toBe(true);
  });

  it("a filter and a pins patch in the same call both apply", () => {
    const store = createBoardStateStore();
    const { state } = store.set({ filter: "cart", pins: { op: "add", screens: ["home"] } });
    expect(state).toEqual({ filter: "cart", pinned: ["home"] });
  });

  it("pruneScreen drops a pinned screen and reports changed:true", () => {
    const store = createBoardStateStore();
    store.set({ pins: { op: "add", screens: ["home", "checkout"] } });
    const { state, changed } = store.pruneScreen("checkout");
    expect(state.pinned).toEqual(["home"]);
    expect(changed).toBe(true);
  });

  it("pruneScreen on a screen that isn't pinned is a no-op (changed:false)", () => {
    const store = createBoardStateStore();
    store.set({ pins: { op: "add", screens: ["home"] } });
    const { state, changed } = store.pruneScreen("checkout");
    expect(state.pinned).toEqual(["home"]);
    expect(changed).toBe(false);
  });

  it("get() returns a snapshot — mutating the returned array doesn't affect internal state", () => {
    const store = createBoardStateStore();
    store.set({ pins: { op: "add", screens: ["home"] } });
    const snapshot = store.get();
    snapshot.pinned.push("checkout");
    expect(store.get().pinned).toEqual(["home"]);
  });
});
