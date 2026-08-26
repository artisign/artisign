import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { autoCommit, getHeadCommit } from "./git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("autoCommit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-git-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("commits changes in a standalone project directory", async () => {
    await writeFile(join(dir, "screens.html"), "<div id=\"n1\"></div>");
    const result = await autoCommit(dir, "feat: add screen");
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.skipped_reason).toBeUndefined();
  });

  it("does not stage or commit an outer repo when the project dir is nested inside one", async () => {
    // Outer repo with its own tracked file.
    await git(dir, ["init"]);
    await writeFile(join(dir, "outer.txt"), "outer content");
    await git(dir, ["add", "outer.txt"]);
    await git(dir, ["commit", "-m", "outer: initial"]);

    // An Artisign project living in a subdirectory of that outer repo,
    // simulating an agent running Artisign inside an existing user repo.
    const projectDir = join(dir, "nested-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "screens.html"), "<div id=\"n1\"></div>");
    // Also dirty the outer repo with an unrelated untracked file, to prove
    // it never gets staged by the nested project's auto-commit.
    await writeFile(join(dir, "untracked-outer.txt"), "should stay untracked");

    const result = await autoCommit(projectDir, "feat: add nested screen");
    expect(result.sha).toBeNull();
    expect(result.skipped_reason).toBe("nested_repo");

    const status = await git(dir, ["status", "--porcelain"]);
    expect(status).toContain("untracked-outer.txt");
    expect(status).toContain("nested-project/");
    // Nothing should have been staged (no "A " / "M " index entries).
    expect(status.split("\n").every((line) => line === "" || line.startsWith("??"))).toBe(true);
  });

  it("reports nothing_to_commit when there is nothing to stage", async () => {
    await writeFile(join(dir, "screens.html"), "<div id=\"n1\"></div>");
    const first = await autoCommit(dir, "feat: add screen");
    expect(first.sha).not.toBeNull();

    const second = await autoCommit(dir, "feat: add screen again");
    expect(second.sha).toBeNull();
    expect(second.skipped_reason).toBe("nothing_to_commit");
  });

  it("reports a first-line git_error instead of swallowing a broken git config", async () => {
    // Break git by making .git a plain file instead of a directory, so a
    // real git init/commit inside it errors out.
    await writeFile(join(dir, ".git"), "not a git dir");
    const result = await autoCommit(dir, "feat: add screen");
    expect(result.sha).toBeNull();
    expect(result.skipped_reason).toMatch(/^git_error: /);
  });
});

describe("getHeadCommit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-git-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports no_repo when there is no git repo yet", async () => {
    const result = await getHeadCommit(dir);
    expect(result).toEqual({ sha: null, head_reason: "no_repo" });
  });

  it("reports no_commits when the repo exists but is empty", async () => {
    await git(dir, ["init"]);
    const result = await getHeadCommit(dir);
    expect(result).toEqual({ sha: null, head_reason: "no_commits" });
  });

  it("reports the real sha once there is a commit", async () => {
    await writeFile(join(dir, "screens.html"), "<div id=\"n1\"></div>");
    await autoCommit(dir, "feat: add screen");
    const result = await getHeadCommit(dir);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.head_reason).toBeUndefined();
  });

  it("reports git_error instead of no_repo when .git is broken", async () => {
    await writeFile(join(dir, ".git"), "not a git dir");
    const result = await getHeadCommit(dir);
    expect(result).toEqual({ sha: null, head_reason: "git_error" });
  });
});
