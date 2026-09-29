import { describe, it, expect } from "vitest";
import { createBoardStateStore } from "./board-state.js";

describe("BoardStateStore", () => {
  it("starts at {filter: null, pinned: []}", () => {
    const store = createBoardStateStore();
    expect(store.get()).toEqual({ filter: null, pinned: [], expanded: [] });
  });

  it("sets the filter, reports changed:true", () => {
    const store = createBoardStateStore();
    const { state, changed } = store.set({ filter: "checkout" });
    expect(state).toEqual({ filter: "checkout", pinned: [], expanded: [] });
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
    expect(state).toEqual({ filter: "cart", pinned: ["home"], expanded: [] });
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
  describe("expanded (CHR-729)", () => {
    it("add, remove, set and clear, each reporting changed:true", () => {
      const store = createBoardStateStore();
      expect(store.set({ expanded: { op: "add", screens: ["home", "checkout"] } })).toMatchObject({ state: { expanded: ["home", "checkout"] }, changed: true });
      expect(store.set({ expanded: { op: "remove", screens: ["home"] } })).toMatchObject({ state: { expanded: ["checkout"] }, changed: true });
      expect(store.set({ expanded: { op: "set", screens: ["cart"] } })).toMatchObject({ state: { expanded: ["cart"] }, changed: true });
      expect(store.set({ expanded: { op: "clear" } })).toMatchObject({ state: { expanded: [] }, changed: true });
    });

    it("dedupes, and a patch that doesn't move the list is changed:false", () => {
      const store = createBoardStateStore();
      store.set({ expanded: { op: "add", screens: ["home", "home"] } });
      expect(store.get().expanded).toEqual(["home"]);
      expect(store.set({ expanded: { op: "add", screens: ["home"] } }).changed).toBe(false);
      expect(store.set({ expanded: { op: "set", screens: ["home", "home"] } }).changed).toBe(false);
    });

    it("is independent of pinned", () => {
      const store = createBoardStateStore();
      store.set({ pins: { op: "add", screens: ["home"] }, expanded: { op: "add", screens: ["checkout"] } });
      expect(store.get()).toEqual({ filter: null, pinned: ["home"], expanded: ["checkout"] });
    });

    it("pruneScreen drops an expanded screen (changed:true) and is a no-op for a name in neither list", () => {
      const store = createBoardStateStore();
      store.set({ expanded: { op: "add", screens: ["home", "checkout"] } });
      const pruned = store.pruneScreen("checkout");
      expect(pruned).toEqual({ state: { filter: null, pinned: [], expanded: ["home"] }, changed: true });
      expect(store.pruneScreen("ghost").changed).toBe(false);
    });

    it("pruneScreen drops a name from pinned and expanded in one change", () => {
      const store = createBoardStateStore();
      store.set({ pins: { op: "add", screens: ["home"] }, expanded: { op: "add", screens: ["home"] } });
      expect(store.pruneScreen("home")).toEqual({ state: { filter: null, pinned: [], expanded: [] }, changed: true });
    });
  });
});
