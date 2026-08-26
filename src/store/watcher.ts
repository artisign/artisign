import { watch as chokidarWatch } from "chokidar";
import { relative, sep } from "node:path";
import { CONFIG_FILENAME, CACHE_DIR } from "../init/artisign-config.js";
import type { ChangeCategory, ProjectChangeEvent } from "./types.js";

const DEBOUNCE_MS = 100;

function categorize(relativePath: string): ChangeCategory {
  const segments = relativePath.split(sep);
  if (segments[0] === "screens") return "screen";
  if (segments[0] === "mockups") return "mockup";
  if (segments[0] === "design-system" && segments[1] === "components") return "component";
  if (segments[0] === "design-system" && segments[1] === "patterns") return "pattern";
  if (relativePath === "design-system/tokens.json") return "tokens";
  if (relativePath === "design-system/meta.json") return "design_system_meta";
  if (relativePath === "flows.json") return "flows";
  if (relativePath === "comments.jsonl") return "comments";
  if (relativePath === CONFIG_FILENAME) return "config";
  return "other";
}

/**
 * Watches `projectDir` for external changes, debounced per-path and
 * ignoring `.artisign/` (the derived cache would otherwise re-trigger
 * itself). Returns an unwatch function.
 */
export function watchProject(
  projectDir: string,
  onChange: (event: ProjectChangeEvent) => void,
): () => void {
  const watcher = chokidarWatch(projectDir, {
    ignored: (path: string) => {
      const rel = relative(projectDir, path);
      // Ignore the derived cache and .tmp files transiently created by atomicWrite
      // — otherwise every write would be observed twice (temp file + final rename).
      const top = rel.split(sep)[0];
      return top === CACHE_DIR || top === ".git" || path.endsWith(".tmp");
    },
    ignoreInitial: true,
  });

  const timers = new Map<string, NodeJS.Timeout>();
  const emit = (type: ProjectChangeEvent["type"], path: string): void => {
    const relPath = relative(projectDir, path);
    const existing = timers.get(relPath);
    if (existing) clearTimeout(existing);
    timers.set(
      relPath,
      setTimeout(() => {
        timers.delete(relPath);
        onChange({ type, path: relPath, category: categorize(relPath) });
      }, DEBOUNCE_MS),
    );
  };

  watcher.on("add", (path) => emit("add", path));
  // Mockups are the only category with a live-created directory of
  // its own (`mockups/<name>/`) — every other category's directories are
  // scaffolded once at init and never appear afterwards. `write_mockup`
  // writes the variant HTML and `mockup.json` back-to-back right after
  // creating that directory; also emitting on `addDir` gives SSE clients (and
  // the SSE broadcaster, which resolves the mockup's own name from the
  // directory segment — see `sse.ts` `baseName`) a signal as soon as the
  // directory itself appears, rather than depending solely on chokidar's
  // live discovery of the file(s) written into it a moment later.
  watcher.on("addDir", (path) => emit("add", path));
  watcher.on("change", (path) => emit("change", path));
  watcher.on("unlink", (path) => emit("unlink", path));
  // An EventEmitter "error" with no listener throws, outside any HTTP
  // request's catch — a chokidar error on a vanishing project root (e.g. the
  // whole directory being deleted) would otherwise kill the daemon process.
  watcher.on("error", (err) => {
    console.error(`watcher error (${projectDir}):`, err instanceof Error ? err.message : err);
  });

  return () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    void watcher.close();
  };
}
