import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";

describe("/api/settings", () => {
  let home: ArtisignHomeFixture;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    home = await setupArtisignHome();
    daemon = await startDaemon({ port: 0, projects: [] });
  });
  afterEach(async () => {
    await daemon.stop();
    await home.cleanup();
  });

  const url = (path: string) => `http://127.0.0.1:${daemon.port}${path}`;
  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(url(path), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
  async function get() {
    const res = await fetch(url("/api/settings"));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("returns empty settings with zero projects open", async () => {
    expect(await get()).toEqual({ status: 200, json: { prefs: {}, migrated: false } });
  });

  it("merges prefs, removes keys on null and persists", async () => {
    await post("/api/settings", { prefs: { a: "1", b: "2" } });
    const { status, json } = await post("/api/settings", { prefs: { b: null, c: "3" } });
    expect(status).toBe(200);
    expect(json).toEqual({ prefs: { a: "1", c: "3" }, migrated: false });
    expect((await get()).json).toEqual(json);
    const onDisk = JSON.parse(await readFile(join(home.home, "settings.json"), "utf-8"));
    expect(onDisk).toEqual(json);
  });

  it("lands two concurrent POSTs", async () => {
    await Promise.all([post("/api/settings", { prefs: { a: "1" } }), post("/api/settings", { prefs: { b: "2" } })]);
    expect((await get()).json.prefs).toEqual({ a: "1", b: "2" });
  });

  it.each([
    ["non-object body", "[]"],
    ["missing prefs", {}],
    ["prefs not an object", { prefs: "x" }],
    ["non-string value", { prefs: { a: 1 } }],
    ["empty key", { prefs: { "": "x" } }],
    ["long key", { prefs: { ["k".repeat(201)]: "x" } }],
    ["long value", { prefs: { a: "v".repeat(10_001) } }],
    ["invalid JSON", "{ nope"],
  ])("rejects %s with 400 validation_failed", async (_name, body) => {
    const { status, json } = await post("/api/settings", body);
    expect(status).toBe(400);
    expect(json.code).toBe("validation_failed");
  });

  it("rejects more than 500 keys and leaves state untouched", async () => {
    const prefs = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`k${i}`, "v"]));
    const { status, json } = await post("/api/settings", { prefs });
    expect(status).toBe(400);
    expect(json.code).toBe("validation_failed");
    expect((await get()).json.prefs).toEqual({});
  });

  it("rejects null values on import", async () => {
    expect((await post("/api/settings/import", { prefs: { a: null } })).status).toBe(400);
  });

  it("imports once, then leaves state unchanged", async () => {
    const first = await post("/api/settings/import", { prefs: { a: "1" } });
    expect(first.json).toEqual({ prefs: { a: "1" }, migrated: true, imported: true });
    const second = await post("/api/settings/import", { prefs: { a: "other", b: "2" } });
    expect(second.status).toBe(200);
    expect(second.json).toEqual({ prefs: { a: "1" }, migrated: true, imported: false });
  });

  it("returns 404 not_found for unknown methods and paths", async () => {
    const del = await fetch(url("/api/settings"), { method: "DELETE" });
    expect(del.status).toBe(404);
    const other = await post("/api/settings/nope", { prefs: {} });
    expect(other.status).toBe(404);
    expect(other.json.code).toBe("not_found");
  });

  it("rejects cross-origin requests", async () => {
    const res = await fetch(url("/api/settings"), { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    const { status } = await post("/api/settings", { prefs: { a: "1" } }, { origin: "https://evil.example" });
    expect(status).toBe(403);
    expect((await get()).json.prefs).toEqual({});
  });
});
