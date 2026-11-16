import { watch as chokidarWatch } from "chokidar";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { CONFIG_FILENAME, CACHE_DIR } from "../init/artisign-config.js";
import type { ChangeCategory, ProjectChangeEvent } from "./types.js";

const DEBOUNCE_MS = 100;
// A directory that appears live is scanned once right away and once more after
// this settle delay (see `scanNewDir`).
const NEW_DIR_RESCAN_MS = 250;

function categorize(relativePath: string): ChangeCategory {
  const segments = relativePath.split(sep);
  if (segments[0] === "screens") return "screen";
  if (segments[0] === "mockups") return "mockup";
  if (segments[0] === "design-system" && segments[1] === "components") return "component";
  if (segments[0] === "design-system" && segments[1] === "patterns") return "pattern";
  if (segments[0] === "assets") return "asset";
  if (segments[0] === "tags") return "tag_meta";
  if (segments[0] === "usecases") return "usecases";
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
 * itself). Returns an unwatch function; its `ready` promise resolves once the
 * initial scan is done and the watcher is live.
 */
export function watchProject(
  projectDir: string,
  onChange: (event: ProjectChangeEvent) => void,
): (() => void) & { ready: Promise<void> } {
  const isIgnored = (path: string): boolean => {
    const rel = relative(projectDir, path);
    // Ignore the derived cache and .tmp files transiently created by atomicWrite
    // — otherwise every write would be observed twice (temp file + final rename).
    const top = rel.split(sep)[0];
    return top === CACHE_DIR || top === ".git" || path.endsWith(".tmp");
  };
  const watcher = chokidarWatch(projectDir, { ignored: isIgnored, ignoreInitial: true });
  const ready = new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
  let closed = false;

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

  // Files already reported, so the new-directory scan below never repeats one.
  const known = new Set<string>();

  // chokidar attaches its watch to a directory that appears live only after
  // it has emitted `addDir` and read the directory once. A file that lands in
  // that gap (atomicWrite's rename right after its `mkdir -p`, first write of
  // `usecases/personas.json`) is reported by neither the read nor the watch.
  // So scan a new directory ourselves: once now, and once after chokidar's
  // watch is certainly in place; whatever sits there by then is reported.
  const scanNewDir = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // vanished again
    }
    for (const entry of entries) {
      if (closed) return;
      const full = join(dir, entry.name);
      if (isIgnored(full)) continue;
      if (entry.isDirectory()) await scanNewDir(full);
      else if (entry.isFile() && !known.has(full)) {
        known.add(full);
        emit("add", full);
      }
    }
  };
  const rescans = new Set<NodeJS.Timeout>();
  const onNewDir = (dir: string): void => {
    void scanNewDir(dir);
    const timer = setTimeout(() => {
      rescans.delete(timer);
      void scanNewDir(dir);
    }, NEW_DIR_RESCAN_MS);
    rescans.add(timer);
  };

  watcher.on("add", (path) => {
    known.add(path);
    emit("add", path);
  });
  // Mockups are the only category with a live-created directory of
  // its own (`mockups/<name>/`) — every other category's directories are
  // scaffolded once at init and never appear afterwards. `write_mockup`
  // writes the variant HTML and `mockup.json` back-to-back right after
  // creating that directory; also emitting on `addDir` gives SSE clients (and
  // the SSE broadcaster, which resolves the mockup's own name from the
  // directory segment — see `sse.ts` `baseName`) a signal as soon as the
  // directory itself appears, rather than depending solely on chokidar's
  // live discovery of the file(s) written into it a moment later.
  watcher.on("addDir", (path) => {
    emit("add", path);
    onNewDir(path);
  });
  watcher.on("change", (path) => emit("change", path));
  watcher.on("unlink", (path) => {
    known.delete(path);
    emit("unlink", path);
  });
  // An EventEmitter "error" with no listener throws, outside any HTTP
  // request's catch — a chokidar error on a vanishing project root (e.g. the
  // whole directory being deleted) would otherwise kill the daemon process.
  watcher.on("error", (err) => {
    console.error(`watcher error (${projectDir}):`, err instanceof Error ? err.message : err);
  });

  const unwatch = (): void => {
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    for (const timer of rescans) clearTimeout(timer);
    timers.clear();
    rescans.clear();
    void watcher.close();
  };
  return Object.assign(unwatch, { ready });
}
