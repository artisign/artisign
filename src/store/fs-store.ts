import { readFile, readdir, appendFile, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve, basename, extname, sep } from "node:path";
import type { ArtisignConfig } from "../init/artisign-config.js";
import { CONFIG_FILENAME, CACHE_DIR } from "../init/artisign-config.js";
import { atomicWrite, ensureCacheGitignore } from "./atomic-write.js";
import { autoCommit, getHeadCommit } from "./git.js";
import { watchProject } from "./watcher.js";
import type { Store, TokensDocument, FlowRecord, ProjectChangeEvent, ScreenMeta, DesignSystemMeta, DesignDecision, CommitResult, HeadCommitResult, MockupMeta, MockupVariantMeta } from "./types.js";

function emptyScreenMeta(): ScreenMeta {
  return { notes: "", tags: [] };
}

function emptyMockupMeta(): MockupMeta {
  return { variants: [] };
}

function emptyDesignSystemMeta(): DesignSystemMeta {
  return { idea: "", decisions: [], component_usage: {}, pattern_usage: {} };
}

/** Narrows an arbitrary parsed JSON value to a plain object, or `{}` if it isn't one (e.g. hand-edited to `null` or a bare string). */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Unlike the sidecar `sanitize*Meta` helpers below (lenient — coerce a bad
 * shape away rather than fail), `artisign.json` is the file that decides
 * whether a directory is a project at all: `ProjectRegistry.open()`
 * reads it to validate a candidate root, and a project whose config silently
 * "coerced" to defaults would open successfully with the wrong name/settings
 * instead of refusing with a clear reason. So this throws, naming `path`, on
 * anything short of `{name: string, settings: object, ...}` — invalid JSON,
 * `null`, an array, a bare string/number, or a missing/mistyped `name` or
 * `settings` field.
 */
function parseArtisignConfig(raw: string, path: string): ArtisignConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid ${CONFIG_FILENAME} at ${path}: not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid ${CONFIG_FILENAME} at ${path}: expected a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== "string") {
    throw new Error(`invalid ${CONFIG_FILENAME} at ${path}: "name" must be a string`);
  }
  if (typeof obj.settings !== "object" || obj.settings === null || Array.isArray(obj.settings)) {
    throw new Error(`invalid ${CONFIG_FILENAME} at ${path}: "settings" must be an object`);
  }
  return parsed as ArtisignConfig;
}

function isDesignDecision(value: unknown): value is DesignDecision {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.date === "string" &&
    typeof v.title === "string" &&
    typeof v.body === "string" &&
    (v.status === "active" || v.status === "superseded")
  );
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, v] of Object.entries(asRecord(value))) {
    if (typeof v === "string") result[key] = v;
  }
  return result;
}

/**
 * Sidecar files are human-editable — a hand edit can leave malformed JSON
 * (caught by the caller) or valid JSON with the wrong shape (e.g. `"tags":
 * "checkout"` instead of an array), which the original lenient
 * spread-merge let straight through and crashed the frontend on
 * (`screen.tags.some is not a function`). This coerces every field to its
 * expected type, dropping anything that doesn't fit rather than throwing.
 */
function sanitizeScreenMeta(value: unknown): ScreenMeta {
  const v = asRecord(value);
  return {
    notes: typeof v.notes === "string" ? v.notes : "",
    tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === "string") : [],
  };
}

function sanitizeMockupVariant(value: unknown): MockupVariantMeta | undefined {
  const v = asRecord(value);
  if (typeof v.id !== "string") return undefined;
  return {
    id: v.id,
    title: typeof v.title === "string" ? v.title : "",
    description: typeof v.description === "string" ? v.description : "",
  };
}

/** Same leniency as `sanitizeScreenMeta`: coerce a bad shape to defaults rather than throw. */
function sanitizeMockupMeta(value: unknown): MockupMeta {
  const v = asRecord(value);
  const meta: MockupMeta = {
    variants: Array.isArray(v.variants) ? v.variants.map(sanitizeMockupVariant).filter((m): m is MockupVariantMeta => m !== undefined) : [],
  };
  if (typeof v.title === "string") meta.title = v.title;
  if (typeof v.description === "string") meta.description = v.description;
  if (Array.isArray(v.tags)) meta.tags = v.tags.filter((t): t is string => typeof t === "string");
  return meta;
}

function sanitizeDesignSystemMeta(value: unknown): DesignSystemMeta {
  const v = asRecord(value);
  return {
    idea: typeof v.idea === "string" ? v.idea : "",
    decisions: Array.isArray(v.decisions) ? v.decisions.filter(isDesignDecision) : [],
    component_usage: sanitizeStringRecord(v.component_usage),
    pattern_usage: sanitizeStringRecord(v.pattern_usage),
  };
}

/** Lists `dir`'s entries filtered/named by `pick`, sorted; `[]` when `dir` doesn't exist. */
async function listEntries(dir: string, pick: (entry: Dirent) => string | undefined): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      const name = pick(entry);
      if (name !== undefined) names.push(name);
    }
    return names.sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function listHtmlFiles(dir: string): Promise<string[]> {
  return listEntries(dir, (entry) => (extname(entry.name) === ".html" ? basename(entry.name, ".html") : undefined));
}

function listDirs(dir: string): Promise<string[]> {
  return listEntries(dir, (entry) => (entry.isDirectory() ? entry.name : undefined));
}

export class FsStore implements Store {
  readonly projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = resolve(projectDir);
  }

  /**
   * Joins `segments` onto the project directory and rejects the result if
   * it would escape it (e.g. a tool caller passing `name: "../../pwned"`).
   * This is the only place path segments derived from caller-supplied names
   * (screen/component/pattern names) are turned into filesystem paths.
   */
  private path(...segments: string[]): string {
    const full = resolve(this.projectDir, ...segments);
    if (full !== this.projectDir && !full.startsWith(this.projectDir + sep)) {
      throw new Error(`refusing to access path outside the project directory: ${segments.join("/")}`);
    }
    return full;
  }

  async readArtisignConfig(): Promise<ArtisignConfig> {
    const path = this.path(CONFIG_FILENAME);
    const raw = await readFile(path, "utf-8");
    return parseArtisignConfig(raw, path);
  }

  async writeArtisignConfig(config: ArtisignConfig): Promise<void> {
    await atomicWrite(this.path(CONFIG_FILENAME), `${JSON.stringify(config, null, 2)}\n`);
  }

  async listScreens(): Promise<string[]> {
    return listHtmlFiles(this.path("screens"));
  }

  async readScreen(name: string): Promise<string> {
    return readFile(this.path("screens", `${name}.html`), "utf-8");
  }

  async writeScreen(name: string, html: string): Promise<void> {
    await atomicWrite(this.path("screens", `${name}.html`), html);
  }

  async deleteScreen(name: string): Promise<void> {
    await rm(this.path("screens", `${name}.html`), { force: true });
    await rm(this.path("screens", `${name}.meta.json`), { force: true });
  }

  async readScreenMeta(name: string): Promise<ScreenMeta> {
    try {
      const raw = await readFile(this.path("screens", `${name}.meta.json`), "utf-8");
      return sanitizeScreenMeta(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyScreenMeta();
      if (err instanceof SyntaxError) return emptyScreenMeta();
      throw err;
    }
  }

  async writeScreenMeta(name: string, meta: ScreenMeta): Promise<void> {
    await atomicWrite(this.path("screens", `${name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  }

  async listMockups(): Promise<string[]> {
    return listDirs(this.path("mockups"));
  }

  async readMockupMeta(name: string): Promise<MockupMeta> {
    const raw = await readFile(this.path("mockups", name, "mockup.json"), "utf-8");
    try {
      return sanitizeMockupMeta(JSON.parse(raw));
    } catch (err) {
      if (err instanceof SyntaxError) return emptyMockupMeta();
      throw err;
    }
  }

  async writeMockupMeta(name: string, meta: MockupMeta): Promise<void> {
    await atomicWrite(this.path("mockups", name, "mockup.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }

  async readMockupVariant(name: string, variantId: string): Promise<string> {
    return readFile(this.path("mockups", name, `${variantId}.html`), "utf-8");
  }

  async writeMockupVariant(name: string, variantId: string, html: string): Promise<void> {
    await atomicWrite(this.path("mockups", name, `${variantId}.html`), html);
  }

  async deleteMockupVariant(name: string, variantId: string): Promise<void> {
    await rm(this.path("mockups", name, `${variantId}.html`), { force: true });
  }

  async deleteMockup(name: string): Promise<void> {
    await rm(this.path("mockups", name), { recursive: true, force: true });
  }

  async listComponents(): Promise<string[]> {
    return listHtmlFiles(this.path("design-system", "components"));
  }

  async readComponent(name: string): Promise<string> {
    return readFile(this.path("design-system", "components", `${name}.html`), "utf-8");
  }

  async writeComponent(name: string, html: string): Promise<void> {
    await atomicWrite(this.path("design-system", "components", `${name}.html`), html);
  }

  async deleteComponent(name: string): Promise<void> {
    await rm(this.path("design-system", "components", `${name}.html`), { force: true });
  }

  async listPatterns(): Promise<string[]> {
    return listHtmlFiles(this.path("design-system", "patterns"));
  }

  async readPattern(name: string): Promise<string> {
    return readFile(this.path("design-system", "patterns", `${name}.html`), "utf-8");
  }

  async writePattern(name: string, html: string): Promise<void> {
    await atomicWrite(this.path("design-system", "patterns", `${name}.html`), html);
  }

  async deletePattern(name: string): Promise<void> {
    await rm(this.path("design-system", "patterns", `${name}.html`), { force: true });
  }

  async readTokens(): Promise<TokensDocument> {
    const raw = await readFile(this.path("design-system", "tokens.json"), "utf-8");
    return JSON.parse(raw) as TokensDocument;
  }

  async writeTokens(tokens: TokensDocument): Promise<void> {
    await atomicWrite(this.path("design-system", "tokens.json"), `${JSON.stringify(tokens, null, 2)}\n`);
  }

  async readDesignSystemMeta(): Promise<DesignSystemMeta> {
    try {
      const raw = await readFile(this.path("design-system", "meta.json"), "utf-8");
      return sanitizeDesignSystemMeta(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyDesignSystemMeta();
      if (err instanceof SyntaxError) return emptyDesignSystemMeta();
      throw err;
    }
  }

  async writeDesignSystemMeta(meta: DesignSystemMeta): Promise<void> {
    await atomicWrite(this.path("design-system", "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }

  async readFlows(): Promise<FlowRecord[]> {
    const raw = await readFile(this.path("flows.json"), "utf-8");
    return JSON.parse(raw) as FlowRecord[];
  }

  async writeFlows(flows: FlowRecord[]): Promise<void> {
    await atomicWrite(this.path("flows.json"), `${JSON.stringify(flows, null, 2)}\n`);
  }

  async readComments(): Promise<string[]> {
    const raw = await readFile(this.path("comments.jsonl"), "utf-8");
    return raw.split("\n").filter((line) => line.length > 0);
  }

  async appendComment(line: string): Promise<void> {
    await appendFile(this.path("comments.jsonl"), `${line}\n`);
  }

  /**
   * Unlike `path()`, this confines `relPath` to the `assets/` subtree
   * specifically, not just the project directory — an asset reference is
   * always `assets/<something>`, so a caller-supplied `relPath` that
   * resolves anywhere else (via `..` or an absolute path) is rejected the
   * same way `path()` rejects escaping the project root.
   */
  private assetPath(relPath: string): string {
    const assetsRoot = resolve(this.projectDir, "assets");
    const full = resolve(assetsRoot, relPath);
    if (full !== assetsRoot && !full.startsWith(assetsRoot + sep)) {
      throw new Error(`refusing to access path outside assets/: ${relPath}`);
    }
    return full;
  }

  async readAsset(relPath: string): Promise<Buffer> {
    return readFile(this.assetPath(relPath));
  }

  async readCacheIndex(): Promise<unknown | undefined> {
    try {
      const raw = await readFile(this.path(CACHE_DIR, "index.json"), "utf-8");
      return JSON.parse(raw) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async writeCacheIndex(index: unknown): Promise<void> {
    await atomicWrite(this.path(CACHE_DIR, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    await ensureCacheGitignore(this.projectDir);
  }

  watch(onChange: (event: ProjectChangeEvent) => void): () => void {
    return watchProject(this.projectDir, onChange);
  }

  async commit(message: string): Promise<CommitResult> {
    const config = await this.readArtisignConfig();
    if (!config.settings.autoCommit) return { sha: null, skipped_reason: "disabled" };
    return autoCommit(this.projectDir, message);
  }

  async headCommit(): Promise<HeadCommitResult> {
    return getHeadCommit(this.projectDir);
  }
}
