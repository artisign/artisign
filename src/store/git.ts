import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import type { CommitResult, HeadCommitResult } from "./types.js";

const execFileAsync = promisify(execFile);

// `git commit` spawns `git maintenance run --auto --detach` — a *detached*
// child that keeps writing into `.git/objects/` after the command that
// started it has returned. Artisign commits once per tool write, so it
// triggers that far more often than ordinary use, and the tool would be
// answering while git work it started is still running in the user's
// repository. Whether a repo gets maintained is its owner's call. Passed
// per invocation, so the user's own config is untouched; git < 2.36 does
// not know the key and ignores it.
async function git(projectDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "maintenance.auto=false", ...args], { cwd: projectDir });
  return stdout.trim();
}

async function isGitRepo(projectDir: string): Promise<boolean> {
  try {
    await git(projectDir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/** The first line of a git failure, for a compact `skipped_reason`/`head_reason`. */
function errorFirstLine(err: unknown): string {
  const text = (err as { stderr?: string })?.stderr || (err instanceof Error ? err.message : String(err));
  return text.trim().split("\n")[0] ?? "unknown error";
}

/** `rev-parse HEAD` fails identically for "no commits yet" and other errors; only the message tells them apart. */
function isEmptyRepoError(err: unknown): boolean {
  return errorFirstLine(err).includes("unknown revision");
}

/** `rev-parse --git-dir` also fails on a genuinely missing repo *and* a corrupted `.git`; only the message tells them apart. */
function isNoRepoError(err: unknown): boolean {
  return errorFirstLine(err).includes("not a git repository");
}

/** The current HEAD commit sha, or `null` (with a reason) if there is no repo yet, no commits yet, or a git error. */
export async function getHeadCommit(projectDir: string): Promise<HeadCommitResult> {
  try {
    await git(projectDir, ["rev-parse", "--git-dir"]);
  } catch (err) {
    return { sha: null, head_reason: isNoRepoError(err) ? "no_repo" : "git_error" };
  }
  try {
    return { sha: await git(projectDir, ["rev-parse", "HEAD"]) };
  } catch (err) {
    return { sha: null, head_reason: isEmptyRepoError(err) ? "no_commits" : "git_error" };
  }
}

/** Resolves symlinks so it compares on equal footing with `git rev-parse --show-toplevel`. */
async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Commits all current changes in `projectDir` with `message`, initializing a
 * git repo on first use. `sha` is `null` (with `skipped_reason`) if there
 * was nothing to commit, the commit could not be made, or the project dir
 * lives inside an outer repo — a failing auto-commit must never break the
 * write it follows.
 *
 * If `projectDir` turns out to live inside a git repo whose root is some
 * *other* directory (an agent running Artisign inside an existing user
 * repo), auto-commit is skipped entirely rather than staging that whole
 * outer repo with `git add -A`.
 */
export async function autoCommit(projectDir: string, message: string): Promise<CommitResult> {
  try {
    if (!(await isGitRepo(projectDir))) {
      await git(projectDir, ["init"]);
    }

    const [toplevel, real] = await Promise.all([
      git(projectDir, ["rev-parse", "--show-toplevel"]),
      realOrSelf(projectDir),
    ]);
    if (toplevel !== real) {
      return { sha: null, skipped_reason: "nested_repo" };
    }

    await git(projectDir, ["add", "-A", "--", "."]);
    const status = await git(projectDir, ["status", "--porcelain"]);
    if (status === "") {
      return { sha: null, skipped_reason: "nothing_to_commit" };
    }
    await git(projectDir, ["commit", "-m", message]);
    return { sha: await git(projectDir, ["rev-parse", "HEAD"]) };
  } catch (err) {
    return { sha: null, skipped_reason: `git_error: ${errorFirstLine(err)}` };
  }
}
