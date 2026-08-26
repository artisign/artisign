import type { Store } from "../store/index.js";
import { FsStore } from "../store/index.js";
import { loadRegistry, parseScreen, type DesignSystemRegistry, type ScreenDocument, type ValidationIssue } from "../model/index.js";
import { ToolError } from "./types.js";

export type ToolContext = { store: Store };

export function createToolContext(projectDir: string): ToolContext {
  return { store: new FsStore(projectDir) };
}

export type LoadedScreen = {
  html: string;
  doc: ScreenDocument;
  errors: ValidationIssue[];
  registry: DesignSystemRegistry;
};

/** Reads and parses a screen, translating a missing file into a not_found ToolError. */
export async function loadScreen(store: Store, screen: string): Promise<LoadedScreen> {
  let html: string;
  try {
    html = await store.readScreen(screen);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolError("not_found", `screen "${screen}" was not found`);
    }
    throw err;
  }
  const registry = await loadRegistry(store);
  const { doc, errors } = parseScreen(html, screen, registry);
  return { html, doc, errors, registry };
}
