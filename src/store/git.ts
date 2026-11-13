import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import type { CommitResult, HeadCommitResult } from "./types.js";

const execFileAsync = promisify(execFile);

// `git commit` spawns `git maintenance run --auto --detach` — a *detached*
// child that keeps writing into `.git/objects/` after the command that
// started it has returned. Artisign commits once per tool write, so a write
// would answer while git work it started is still running in the user's
// repository, and a caller acting on the directory (a cleanup, a move) races
// it. `--no-detach` keeps the maintenance — an agent-driven repo needs it
// more than most, not less, since nobody else ever writes to it — and only
// makes it finish before the commit call does. `gc.autoDetach` is the older
// spelling that gits without `maintenance.autoDetach` honour; both are set so
// this holds across versions. Disabling maintenance instead would leave a
// long-lived project accumulating loose objects nothing ever packs.
// Passed per invocation, so the user's own config is untouched.
const NO_DETACHED_MAINTENANCE = ["-c", "gc.autoDetach=false", "-c", "maintenance.autoDetach=false"];

/**
 * The identity Artisign's own commits carry when git has none to offer. Git
 * refuses to commit without `user.name`/`user.email` and, on a fresh machine,
 * tries to derive them from the login and hostname — which fails on most VMs
 * and containers ("unable to auto-detect email address"). The audit log is
 * the product claim, so a project must not end up with design state and no
 * history just because nobody ran `git config --global user.email` yet.
 * Passed per invocation (`-c`), never written to any config, and only reached
 * after git itself refused for want of an identity: one configured anywhere —
 * global or repo config, `GIT_AUTHOR_*`/`GIT_COMMITTER_*` — made the first
 * attempt succeed and is never replaced. Only the half git lacks is filled
 * in, so a configured `user.email` without a `user.name` keeps that email.
 */
export const FALLBACK_IDENTITY = { name: "artisign", email: "noreply@artisign.dev" } as const;

async function git(projectDir: string, args: string[]): Promise<string> {
  // Git translates its messages on gettext builds (most Linux distributions,
  // Homebrew), and the checks below recognise failures by their English text.
  const { stdout } = await execFileAsync("git", [...NO_DETACHED_MAINTENANCE, ...args], {
    cwd: projectDir,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

/** `-c` flags for the parts of `FALLBACK_IDENTITY` git has no value for; a configured one is kept. */
async function fallbackIdentityFlags(projectDir: string): Promise<string[]> {
  const flags: string[] = [];
  for (const key of ["name", "email"] as const) {
    const configured = await git(projectDir, ["config", `user.${key}`]).catch(() => "");
    if (configured === "") flags.push("-c", `user.${key}=${FALLBACK_IDENTITY[key]}`);
  }
  return flags;
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

/** Every "who are you" refusal — missing config, failed auto-detection, `user.useConfigOnly` — opens with this line. */
function isIdentityUnknownError(err: unknown): boolean {
  const text = (err as { stderr?: string })?.stderr ?? "";
  return /^(Author|Committer) identity unknown$/m.test(text);
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
 * write it follows. A commit git refuses only for want of an identity is
 * retried once as `FALLBACK_IDENTITY`.
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
    try {
      await git(projectDir, ["commit", "-m", message]);
    } catch (err) {
      if (!isIdentityUnknownError(err)) throw err;
      await git(projectDir, [...(await fallbackIdentityFlags(projectDir)), "commit", "-m", message]);
    }
    return { sha: await git(projectDir, ["rev-parse", "HEAD"]) };
  } catch (err) {
    return { sha: null, skipped_reason: `git_error: ${errorFirstLine(err)}` };
  }
}
