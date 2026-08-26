import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { artisignHome, readGlobalConfig, writeGlobalConfig } from "./global-config.js";

describe("global-config", () => {
  let fixture: ArtisignHomeFixture;
  let home: string;

  beforeEach(async () => {
    fixture = await setupArtisignHome();
    home = fixture.home;
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("resolves ARTISIGN_HOME from the environment", () => {
    expect(artisignHome()).toBe(home);
  });

  it("returns an empty config when config.json is missing", async () => {
    await expect(readGlobalConfig()).resolves.toEqual({});
  });

  it("returns an empty config when config.json is invalid JSON", async () => {
    await writeFile(join(home, "config.json"), "not json");

    await expect(readGlobalConfig()).resolves.toEqual({});
  });

  it("returns an empty config when config.json does not contain an object", async () => {
    await writeFile(join(home, "config.json"), "42");

    await expect(readGlobalConfig()).resolves.toEqual({});
  });

  it("round-trips a written config", async () => {
    await writeGlobalConfig({ port: 5001, recentProjects: ["/a", "/b"] });

    await expect(readGlobalConfig()).resolves.toEqual({ port: 5001, recentProjects: ["/a", "/b"] });
  });

  it("writes atomically, leaving no temp file behind", async () => {
    await writeGlobalConfig({ port: 5002 });

    const raw = await readFile(join(home, "config.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({ port: 5002 });
    await expect(readdir(home)).resolves.toEqual(["config.json"]);
  });

  it("falls back to ~/.artisign when ARTISIGN_HOME is unset", () => {
    const previous = process.env.ARTISIGN_HOME;
    delete process.env.ARTISIGN_HOME;

    expect(artisignHome()).toBe(join(homedir(), ".artisign"));

    process.env.ARTISIGN_HOME = previous;
  });
});
