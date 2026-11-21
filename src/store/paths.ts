import path from "node:path";

/** The `node:path` flavour to use; tests pass `path.win32` to exercise Windows semantics on any OS. */
type PathFlavour = Pick<typeof path, "relative" | "sep" | "isAbsolute">;

/**
 * The one place that turns an OS path into a project-relative path. The result
 * always uses `/`, whatever the host OS, so screen ids, SSE events, asset URLs
 * and index keys are identical on Windows and macOS/Linux.
 */
export function toProjectRelative(projectDir: string, absPath: string, flavour: PathFlavour = path): string {
  const rel = flavour.relative(projectDir, absPath);
  return flavour.sep === "/" ? rel : rel.split(flavour.sep).join("/");
}

/**
 * Whether `full` is `root` or lies below it. Compares resolved paths through
 * `relative`, so it is case-insensitive on Windows and honours drive letters.
 */
export function isWithin(root: string, full: string, flavour: PathFlavour = path): boolean {
  const rel = flavour.relative(root, full);
  if (rel === "") return true;
  if (flavour.isAbsolute(rel)) return false; // another drive on Windows
  return rel !== ".." && !rel.startsWith(".." + flavour.sep);
}

/** Map key for a project root: Windows paths are case-insensitive, so `C:\Work\proj` and `c:\work\proj` must share one key. */
export function pathIdentity(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? p.toLowerCase() : p;
}
