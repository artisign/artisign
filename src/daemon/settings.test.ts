import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { readSettings, updateSettings } from "./settings.js";

describe("settings store", () => {
  let home: ArtisignHomeFixture;

  beforeEach(async () => {
    home = await setupArtisignHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it("reads a missing file as empty", async () => {
    expect(await readSettings()).toEqual({ prefs: {}, migrated: false });
  });

  it("reads a malformed file as empty", async () => {
    await writeFile(join(home.home, "settings.json"), "{ nope");
    expect(await readSettings()).toEqual({ prefs: {}, migrated: false });
  });

  it("drops non-string prefs when reading", async () => {
    await writeFile(
      join(home.home, "settings.json"),
      JSON.stringify({ prefs: { a: "x", b: 1, c: null }, migrated: true }),
    );
    expect(await readSettings()).toEqual({ prefs: { a: "x" }, migrated: true });
  });

  it("persists pretty JSON with a trailing newline", async () => {
    await updateSettings((s) => ({ ...s, prefs: { a: "1" } }));
    const raw = await readFile(join(home.home, "settings.json"), "utf-8");
    expect(raw).toBe(`${JSON.stringify({ prefs: { a: "1" }, migrated: false }, null, 2)}\n`);
  });

  it("serializes concurrent updates without losing any", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        updateSettings((s) => ({ ...s, prefs: { ...s.prefs, [`k${i}`]: String(i) } })),
      ),
    );
    expect(Object.keys((await readSettings()).prefs)).toHaveLength(20);
    const onDisk = JSON.parse(await readFile(join(home.home, "settings.json"), "utf-8"));
    expect(Object.keys(onDisk.prefs)).toHaveLength(20);
  });
});
