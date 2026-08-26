import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { CACHE_DIR } from "../init/artisign-config.js";

/**
 * Writes `content` to `path` atomically: write to a temp file in the same
 * directory, then rename over the target. `rename` within one filesystem is
 * atomic, so readers never observe a partial write. The temp name includes a
 * random suffix so concurrent writes to the same path (e.g. two debounced
 * index rebuilds firing close together) never collide on the same temp file.
 */
export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, content);
  await rename(tempPath, path);
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
