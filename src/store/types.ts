import type { ArtisignConfig } from "../init/artisign-config.js";

export type TokensDocument = Record<string, Record<string, unknown>>;

export type FlowRecord = {
  from: string; // "screen.node-id"
  event: string;
  to: string;
  // Absent on older records means "screen", the original default shape.
  to_kind?: "screen" | "node";
};

export type ScreenMeta = { notes: string; tags: string[] };

export type MockupVariantMeta = { id: string; title: string; description: string };

export type MockupMeta = { title?: string; description?: string; tags?: string[]; variants: MockupVariantMeta[] };

export type DesignDecision = {
  id: string;
  date: string;
  title: string;
  body: string;
  status: "active" | "superseded";
};

export type DesignSystemMeta = {
  idea: string;
  decisions: DesignDecision[];
  component_usage: Record<string, string>;
  pattern_usage: Record<string, string>;
};

export type ChangeCategory =
  | "screen"
  | "component"
  | "pattern"
  | "tokens"
  | "flows"
  | "comments"
  | "config"
  | "design_system_meta"
  | "mockup"
  | "asset"
  | "other";

export type ProjectChangeEvent = {
  type: "add" | "change" | "unlink";
  /** Path relative to the project root. */
  path: string;
  category: ChangeCategory;
};

/** Why `commit()` returned a `null` sha — never thrown, always reported. */
export type CommitSkippedReason =
  | "disabled"
  | "nested_repo"
  | "nothing_to_commit"
  | `git_error: ${string}`;

export type CommitResult = {
  sha: string | null;
  skipped_reason?: CommitSkippedReason;
};

/** Why `headCommit()` returned a `null` sha. */
export type HeadReason = "no_repo" | "no_commits" | "git_error";

export type HeadCommitResult = {
  sha: string | null;
  head_reason?: HeadReason;
};

/**
 * The single boundary for all filesystem access. Every part of the codebase
 * that needs to read or write project state goes through this interface —
 * no direct `fs` calls anywhere else (see CLAUDE.md / ADR-001).
 */
export interface Store {
  readonly projectDir: string;

  readArtisignConfig(): Promise<ArtisignConfig>;
  writeArtisignConfig(config: ArtisignConfig): Promise<void>;

  listScreens(): Promise<string[]>;
  readScreen(name: string): Promise<string>;
  writeScreen(name: string, html: string): Promise<void>;
  deleteScreen(name: string): Promise<void>;

  /** Missing sidecar file yields `{ notes: "", tags: [] }`, never an error. */
  readScreenMeta(name: string): Promise<ScreenMeta>;
  writeScreenMeta(name: string, meta: ScreenMeta): Promise<void>;

  listComponents(): Promise<string[]>;
  readComponent(name: string): Promise<string>;
  writeComponent(name: string, html: string): Promise<void>;
  deleteComponent(name: string): Promise<void>;

  listPatterns(): Promise<string[]>;
  readPattern(name: string): Promise<string>;
  writePattern(name: string, html: string): Promise<void>;
  deletePattern(name: string): Promise<void>;

  listMockups(): Promise<string[]>;

  /**
   * Unlike `readScreenMeta`, a missing `mockup.json` here propagates its
   * `ENOENT` rather than yielding empty defaults — deliberate: it lets
   * callers tell "this mockup doesn't exist" apart from "this mockup exists
   * but has no variants yet". Malformed JSON (unparsable, or the wrong
   * shape) still yields `{ variants: [] }` via a lenient sanitizer, same as
   * the screen sidecar. Do not "fix" this to match `readScreenMeta`.
   */
  readMockupMeta(name: string): Promise<MockupMeta>;
  writeMockupMeta(name: string, meta: MockupMeta): Promise<void>;

  /** Missing variant file propagates its `ENOENT`. */
  readMockupVariant(name: string, variantId: string): Promise<string>;
  writeMockupVariant(name: string, variantId: string, html: string): Promise<void>;
  /** No-op if the variant file doesn't exist. */
  deleteMockupVariant(name: string, variantId: string): Promise<void>;
  /** Removes the whole mockup directory, meta and all variants. */
  deleteMockup(name: string): Promise<void>;

  readTokens(): Promise<TokensDocument>;
  writeTokens(tokens: TokensDocument): Promise<void>;

  /** Missing sidecar file yields empty defaults, never an error. */
  readDesignSystemMeta(): Promise<DesignSystemMeta>;
  writeDesignSystemMeta(meta: DesignSystemMeta): Promise<void>;

  readFlows(): Promise<FlowRecord[]>;
  writeFlows(flows: FlowRecord[]): Promise<void>;

  readComments(): Promise<string[]>;
  appendComment(line: string): Promise<void>;

  /**
   * Reads a project asset (e.g. an image referenced from a screen or
   * component as `assets/hero.png`) by its path relative to `assets/`
   * (i.e. `"hero.png"`, not `"assets/hero.png"`). Rejects a path that
   * would escape the `assets/` directory. Propagates its `ENOENT` — a
   * missing asset is the caller's problem to render visibly, not this
   * method's to paper over.
   */
  readAsset(relPath: string): Promise<Buffer>;

  /** Derived cache under `.artisign/`. `undefined` when no cache exists yet. */
  readCacheIndex(): Promise<unknown | undefined>;
  writeCacheIndex(index: unknown): Promise<void>;

  /**
   * Watches the project folder for external changes, debounced, ignoring
   * `.artisign/`. Returns an unwatch function.
   */
  watch(onChange: (event: ProjectChangeEvent) => void): () => void;

  /**
   * Commits all current changes when `autoCommit` is enabled in `artisign.json`.
   * `sha` is `null` when auto-commit is disabled, there is nothing to
   * commit, the project dir is nested inside an outer repo, or the commit
   * failed — `skipped_reason` says which (failures never break the write).
   */
  commit(message: string): Promise<CommitResult>;

  /** Current HEAD commit sha, or `null` (with `head_reason`) when there is no repo, no commits yet, or a git error. */
  headCommit(): Promise<HeadCommitResult>;
}
