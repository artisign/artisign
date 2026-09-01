import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "./init-project.js";

describe("initProject", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-init-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("scaffolds artisign.json with default settings", async () => {
    await initProject(dir);

    const config = JSON.parse(await readFile(join(dir, "artisign.json"), "utf-8"));
    expect(config.settings.autoCommit).toBe(true);
    // The daemon's port is no longer sourced from artisign.json (see
    // src/daemon/global-config.ts) — a new project no longer writes one.
    expect(config.settings.port).toBeUndefined();
    expect(typeof config.name).toBe("string");
  });

  it("scaffolds the design system, screens, flows and comments files", async () => {
    await initProject(dir);

    const tokens = JSON.parse(
      await readFile(join(dir, "design-system", "tokens.json"), "utf-8"),
    );
    expect(tokens).toEqual({
      color: {},
      spacing: {},
      typography: {},
      radius: {},
      shadow: {},
      motion: {},
    });

    expect((await stat(join(dir, "design-system", "components"))).isDirectory()).toBe(true);
    expect((await stat(join(dir, "design-system", "patterns"))).isDirectory()).toBe(true);
    expect((await stat(join(dir, "screens"))).isDirectory()).toBe(true);
    expect((await stat(join(dir, "mockups"))).isDirectory()).toBe(true);
    expect((await stat(join(dir, "assets"))).isDirectory()).toBe(true);

    const flows = JSON.parse(await readFile(join(dir, "flows.json"), "utf-8"));
    expect(flows).toEqual([]);

    const comments = await readFile(join(dir, "comments.jsonl"), "utf-8");
    expect(comments).toBe("");
  });

  it("scaffolds a gitignored .artisign/ directory", async () => {
    await initProject(dir);

    expect((await stat(join(dir, ".artisign"))).isDirectory()).toBe(true);
    const gitignore = await readFile(join(dir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".artisign/");
  });

  it("makes .artisign/ self-ignoring, independent of the project's own .gitignore", async () => {
    await initProject(dir);

    const cacheGitignore = await readFile(join(dir, ".artisign", ".gitignore"), "utf-8");
    expect(cacheGitignore).toBe("*\n");
  });
});
