import { writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { CACHE_DIR } from "../init/artisign-config.js";

/** Error codes Windows reports while another process briefly holds the target open. */
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Backoff between rename attempts (ms); the sum bounds the total wait to about a second. */
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 400];

export type RenameFn = (from: string, to: string) => Promise<void>;

export type AtomicWriteOptions = {
  /** New file's permissions (a replaced file otherwise falls back to the default, not the old mode). */
  mode?: number;
  /** Injected for tests. */
  rename?: RenameFn;
  /** Injected for tests; default is the bounded backoff above. */
  retryDelaysMs?: readonly number[];
};

/**
 * Writes `content` to `path` atomically: write to a temp file in the same
 * directory, then rename over the target. `rename` within one filesystem is
 * atomic, so readers never observe a partial write. The temp name includes a
 * random suffix so concurrent writes to the same path (e.g. two debounced
 * index rebuilds firing close together) never collide on the same temp file.
 * `mode` sets the new file's permissions (a replaced file otherwise falls back to the default, not the old mode).
 *
 * On Windows the rename fails with EPERM/EBUSY/EACCES while the watcher, an
 * antivirus scanner or an editor holds the target open. Those errors are
 * retried with a short, bounded backoff (the `graceful-fs` pattern); the first
 * attempt is immediate, so POSIX pays no delay. If the lock outlasts the
 * bound, the temp file is removed, the target keeps its old content and the
 * error names the file.
 * Shared by every rename-over-existing path, including the font cache.
 */
export async function atomicWrite(
  path: string,
  content: string | Buffer,
  modeOrOptions?: number | AtomicWriteOptions,
): Promise<void> {
  const options: AtomicWriteOptions = typeof modeOrOptions === "number" ? { mode: modeOrOptions } : (modeOrOptions ?? {});
  const doRename = options.rename ?? rename;
  const delays = options.retryDelaysMs ?? RENAME_RETRY_DELAYS_MS;
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, content, { mode: options.mode });
    for (let attempt = 0; ; attempt++) {
      try {
        await doRename(tempPath, path);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === undefined || !RETRYABLE_RENAME_CODES.has(code)) throw err;
        if (attempt >= delays.length) {
          throw new Error(`Could not write ${path}: file is locked by another process (${code})`, { cause: err });
        }
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

/**
 * Writes `.artisign/.gitignore` (`*`, ignoring everything under it) for
 * `projectDir` — makes the derived cache self-ignoring regardless of what a
 * project's own top-level `.gitignore` says (an older, differently-scaffolded
 * `.gitignore` may not name the cache directory at all), so `.artisign/index.json`
 * and the cached font woff2s never get swept into `git add -A` by autoCommit.
 * Called from every writer that touches `.artisign/` (init scaffolding, cache
 * index writes, font caching) rather than relying on `.artisign/` having been
 * created with it already — idempotent, and cheap enough to call
 * unconditionally on each write.
 */
export async function ensureCacheGitignore(projectDir: string): Promise<void> {
  await atomicWrite(join(projectDir, CACHE_DIR, ".gitignore"), "*\n");
}
