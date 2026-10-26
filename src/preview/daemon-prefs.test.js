import { describe, it, expect, vi, afterEach } from "vitest";
import { createDaemonStorage, collectLocalPrefs, loadDaemonStorage } from "./daemon-prefs.js";
import { fakeSettings } from "./fake-settings.test-helper.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

function localStub(entries) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (k) => map.get(k) ?? null,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

describe("createDaemonStorage", () => {
  it("is seeded from the initial prefs and reads missing keys as null", () => {
    const storage = createDaemonStorage({ "artisign.zoom": "2" }, vi.fn());
    expect(storage.getItem("artisign.zoom")).toBe("2");
    expect(storage.getItem("artisign.view")).toBeNull();
  });

  it("applies writes at once and sends a burst of them as one save", async () => {
    const save = vi.fn(async () => {});
    const storage = createDaemonStorage({}, save);
    storage.setItem("artisign.zoom", "2");
    storage.setItem("artisign.zoom", "3");
    storage.setItem("artisign.view", "board");
    storage.removeItem("artisign.view");
    expect(storage.getItem("artisign.zoom")).toBe("3");
    expect(storage.getItem("artisign.view")).toBeNull();
    expect(save).not.toHaveBeenCalled();
    await tick();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ "artisign.zoom": "3", "artisign.view": null });
  });

  it("sends separate bursts as separate saves, in order", async () => {
    const order = [];
    const storage = createDaemonStorage({}, async (c) => void order.push(c));
    storage.setItem("a", "1");
    await tick();
    storage.setItem("a", "2");
    await tick();
    expect(order).toEqual([{ a: "1" }, { a: "2" }]);
  });

  it("tolerates a failing save and keeps serving values", async () => {
    const save = vi.fn(async () => {
      throw new Error("offline");
    });
    const storage = createDaemonStorage({}, save);
    storage.setItem("a", "1");
    await tick();
    storage.setItem("b", "2");
    await tick();
    expect(save).toHaveBeenCalledTimes(2);
    expect(storage.getItem("a")).toBe("1");
  });

  it("without a save function it is a plain in-memory store", async () => {
    const storage = createDaemonStorage({}, null);
    storage.setItem("a", "1");
    expect(storage.getItem("a")).toBe("1");
  });
});

describe("collectLocalPrefs", () => {
  it("takes artisign. and legacy uxd. keys, the new name winning, and ignores the rest", () => {
    const local = localStub({ "artisign.zoom": "2", "uxd.zoom": "9", "uxd.view": "board", other: "x" });
    expect(collectLocalPrefs(local)).toEqual({ "artisign.zoom": "2", "artisign.view": "board" });
  });

  it("is empty without a usable localStorage", () => {
    expect(collectLocalPrefs(null)).toEqual({});
    expect(collectLocalPrefs({ get length() { throw new Error("denied"); } })).toEqual({});
  });
});

describe("loadDaemonStorage", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(settings) {
    vi.stubGlobal("fetch", async (url, init) => settings.handle(String(url), init) ?? { ok: false, status: 404, json: async () => ({}) });
  }

  it("carries localStorage over once when the settings are not migrated yet", async () => {
    const settings = fakeSettings();
    stubFetch(settings);
    const storage = await loadDaemonStorage(localStub({ "artisign.zoom": "2" }));
    expect(settings.imports).toEqual([{ "artisign.zoom": "2" }]);
    expect(storage.getItem("artisign.zoom")).toBe("2");
  });

  it("does not import when the settings are migrated and serves the daemon's prefs", async () => {
    const settings = fakeSettings({ prefs: { "artisign.zoom": "3" }, migrated: true });
    stubFetch(settings);
    const storage = await loadDaemonStorage(localStub({ "artisign.zoom": "2" }));
    expect(settings.imports).toEqual([]);
    expect(storage.getItem("artisign.zoom")).toBe("3");
  });

  it("falls back to the collected values when the import response is unusable", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const storage = await loadDaemonStorage(localStub({ "artisign.zoom": "2" }));
    expect(storage.getItem("artisign.zoom")).toBe("2");
  });

  it("runs on defaults without persisting when the settings request fails", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("down");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const storage = await loadDaemonStorage(localStub({ "artisign.zoom": "2" }));
    expect(storage.getItem("artisign.zoom")).toBeNull();
    storage.setItem("artisign.zoom", "3");
    await tick();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("treats a malformed body like a failed request", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ prefs: [1] }) }));
    const storage = await loadDaemonStorage(localStub({ "artisign.zoom": "2" }));
    expect(storage.getItem("artisign.zoom")).toBeNull();
  });
});
