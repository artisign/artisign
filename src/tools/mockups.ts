// The mockup workflow — write/read variants and promote a chosen
// one into a design-system-bound screen. Mockups are raw HTML, outside the
// canonical ref model (ADR-003): no refs, no drift, no node ids to address.

import { parse, serializeOuter, defaultTreeAdapter, html as p5html } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { Store, MockupMeta } from "../store/index.js";
import { writeHtml } from "./writes.js";
import { ToolError, commitFields, type Warning } from "./types.js";

const NAME_RE = /^[\w-]+$/;

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Missing mockup.json (e.g. a mockup dir whose sidecar hasn't landed yet, or was hand-deleted) yields `{variants: []}` rather than throwing — the same per-entry tolerance `GET /api/mockups` and `get_project`'s mockups list need. */
export async function readMockupMetaOrDefault(store: Store, mockup: string): Promise<MockupMeta> {
  try {
    return await store.readMockupMeta(mockup);
  } catch (err) {
    if (isEnoent(err)) return { variants: [] };
    throw err;
  }
}

/** True if the variant's html file exists on disk, independent of whether mockup.json's variants array knows about it. */
async function variantFileExists(store: Store, mockup: string, variant: string): Promise<boolean> {
  try {
    await store.readMockupVariant(mockup, variant);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

async function readMockupMetaOrNotFound(store: Store, mockup: string): Promise<MockupMeta> {
  try {
    return await store.readMockupMeta(mockup);
  } catch (err) {
    if (isEnoent(err)) throw new ToolError("not_found", `mockup "${mockup}" was not found`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// write_mockup
// ---------------------------------------------------------------------------

export type WriteMockupInput = {
  mockup: string;
  variant: string;
  mode: "create" | "replace";
  title?: string;
  description?: string;
  html?: string;
};

export async function writeMockup(store: Store, input: WriteMockupInput): Promise<Record<string, unknown>> {
  if (!NAME_RE.test(input.mockup)) {
    throw new ToolError("validation_failed", `mockup name "${input.mockup}" must match ^[\\w-]+$`);
  }
  if (!NAME_RE.test(input.variant)) {
    throw new ToolError("validation_failed", `variant id "${input.variant}" must match ^[\\w-]+$`);
  }

  const meta = await readMockupMetaOrDefault(store, input.mockup);
  const existingIndex = meta.variants.findIndex((v) => v.id === input.variant);
  const exists = existingIndex !== -1;

  if (input.mode === "create") {
    // meta.variants can lose track of a variant whose html file still exists
    // on disk (mockup.json hand-deleted/edited, or a prior write that landed
    // the file but not yet the sidecar) — checking the file too, not just
    // the meta, is what stops "create" from silently overwriting it.
    if (exists || (await variantFileExists(store, input.mockup, input.variant))) {
      throw new ToolError("conflict", `mockup "${input.mockup}" variant "${input.variant}" already exists`);
    }
    if (input.html === undefined) {
      throw new ToolError("validation_failed", "html is required when mode is \"create\"");
    }
    meta.variants.push({
      id: input.variant,
      title: input.title ?? input.variant,
      description: input.description ?? "",
    });
  } else {
    if (!exists) {
      throw new ToolError("not_found", `mockup "${input.mockup}" variant "${input.variant}" was not found`);
    }
    const current = meta.variants[existingIndex]!;
    meta.variants[existingIndex] = {
      id: input.variant,
      title: input.title ?? current.title,
      description: input.description ?? current.description,
    };
  }

  // Meta first — creates the mockup directory (atomicWrite mkdirs) even for
  // a brand-new mockup whose first variant html hasn't landed yet.
  await store.writeMockupMeta(input.mockup, meta);
  if (input.html !== undefined) {
    await store.writeMockupVariant(input.mockup, input.variant, input.html);
  }
  const commitResult = await store.commit(`write_mockup: ${input.mockup}/${input.variant}`);

  return {
    mockup: input.mockup,
    variant: input.variant,
    path: `mockups/${input.mockup}/${input.variant}.html`,
    variant_count: meta.variants.length,
    ...commitFields(commitResult),
  };
}

// ---------------------------------------------------------------------------
// get_mockup
// ---------------------------------------------------------------------------

export type GetMockupInput = {
  mockup: string;
  view?: "summary" | "full";
  variant?: string;
};

export async function getMockup(store: Store, input: GetMockupInput): Promise<Record<string, unknown>> {
  const view = input.view ?? "summary";
  const meta = await readMockupMetaOrNotFound(store, input.mockup);

  let variants = meta.variants;
  if (input.variant !== undefined) {
    const match = meta.variants.find((v) => v.id === input.variant);
    if (!match) {
      throw new ToolError("not_found", `mockup "${input.mockup}" variant "${input.variant}" was not found`);
    }
    variants = [match];
  }

  const base: Record<string, unknown> = {
    mockup: input.mockup,
    path: `mockups/${input.mockup}/mockup.json`,
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    tags: meta.tags ?? [],
    variant_count: meta.variants.length,
  };

  if (view === "summary") {
    return { ...base, variants: variants.map(({ id, title, description }) => ({ id, title, description })) };
  }

  const variantsWithHtml = await Promise.all(
    variants.map(async (v) => ({ ...v, html: await store.readMockupVariant(input.mockup, v.id) })),
  );
  return { ...base, variants: variantsWithHtml };
}

// ---------------------------------------------------------------------------
// promote_mockup
// ---------------------------------------------------------------------------

type P5Node = DefaultTreeAdapterTypes.ChildNode;

// Head-only elements and scripts have no place in a screen.
const DROPPED_TAGS = new Set(["script", "meta", "title", "link", "base"]);

/**
 * A screen has exactly one root element, and mockups are raw HTML that is
 * often a full document. Moves every top-level `<style>` (head and body) into
 * the root as leading children, wraps several top-level nodes in a `<div>`,
 * and drops what a screen can't carry. `<body>` `style`/`class` are carried
 * onto the wrapping `<div>`; other `<body>`/`<html>` attributes are dropped.
 * Single-root, style-free input is returned untouched.
 */
function normalizeMockupHtml(html: string): { html: string; warnings: Warning[] } {
  const document = parse(html);
  const htmlEl = document.childNodes.find(defaultTreeAdapter.isElementNode);
  const headAndBody = (htmlEl?.childNodes ?? []).filter(defaultTreeAdapter.isElementNode);
  const body = headAndBody.find((el) => el.tagName === "body");
  const topLevel = headAndBody.flatMap((el) => el.childNodes);
  const styles: P5Node[] = [];
  const content: P5Node[] = [];
  const dropped = new Set<string>();
  for (const node of topLevel) {
    if (defaultTreeAdapter.isElementNode(node)) {
      if (node.tagName === "style") styles.push(node);
      else if (DROPPED_TAGS.has(node.tagName)) dropped.add(node.tagName);
      else content.push(node);
    } else if (defaultTreeAdapter.isTextNode(node) && node.value.trim() !== "") {
      content.push(node);
    }
  }

  const bodyLook = (body?.attrs ?? []).filter((a) => a.name === "style" || a.name === "class");
  for (const a of body?.attrs ?? []) if (!bodyLook.includes(a)) dropped.add(`body ${a.name}`);
  for (const a of htmlEl?.attrs ?? []) dropped.add(`html ${a.name}`);

  const singleRoot = bodyLook.length === 0 && content.length === 1 && content[0] !== undefined && defaultTreeAdapter.isElementNode(content[0]);
  if (styles.length === 0 && dropped.size === 0 && bodyLook.length === 0 && singleRoot) return { html, warnings: [] };
  if (styles.length === 0 && dropped.size === 0 && bodyLook.length === 0 && content.length === 0) return { html, warnings: [] };

  let root: DefaultTreeAdapterTypes.Element;
  if (singleRoot) {
    root = content[0] as DefaultTreeAdapterTypes.Element;
  } else {
    root = defaultTreeAdapter.createElement("div", p5html.NS.HTML, bodyLook);
    for (const node of content) defaultTreeAdapter.appendChild(root, node);
  }
  root.childNodes.unshift(...styles);
  for (const style of styles) style.parentNode = root;

  const warnings: Warning[] = [];
  const changes = [
    styles.length > 0 ? `${styles.length} <style> element(s) moved into the root` : undefined,
    singleRoot ? undefined : "top-level nodes wrapped in one <div>",
    dropped.size > 0 ? `dropped: ${[...dropped].map((t) => `<${t}>`).join(", ")}` : undefined,
  ].filter((c) => c !== undefined);
  warnings.push({
    kind: "mockup_normalized",
    message: `the screen differs structurally from the mockup file (${changes.join("; ")})`,
  });
  return { html: serializeOuter(root), warnings };
}

export type PromoteMockupInput = {
  mockup: string;
  variant: string;
  screen: string;
  title?: string;
};

export async function promoteMockup(store: Store, input: PromoteMockupInput): Promise<Record<string, unknown>> {
  const meta = await readMockupMetaOrNotFound(store, input.mockup);
  const variant = meta.variants.find((v) => v.id === input.variant);
  if (!variant) {
    throw new ToolError("not_found", `mockup "${input.mockup}" variant "${input.variant}" was not found`);
  }

  const normalized = normalizeMockupHtml(await store.readMockupVariant(input.mockup, input.variant));
  const result = await writeHtml(store, {
    screen: input.screen,
    mode: "create",
    title: input.title ?? variant.title,
    html_aug: normalized.html,
  });
  const warnings = [...normalized.warnings, ...((result.warnings as Warning[] | undefined) ?? [])];

  return { ...result, warnings, mockup: input.mockup, variant: input.variant };
}

// ---------------------------------------------------------------------------
// delete_entity (kind: "mockup")
// ---------------------------------------------------------------------------

export async function deleteMockupEntity(store: Store, name: string, variant?: string): Promise<Record<string, unknown>> {
  if (variant === undefined) {
    // Existence via the directory listing, not the meta — an orphan mockup
    // dir (a variant html written but mockup.json missing/hand-deleted)
    // still needs a way to be deleted; readMockupMetaOrNotFound would
    // refuse it with not_found even though it's plainly there.
    if (!(await store.listMockups()).includes(name)) {
      throw new ToolError("not_found", `mockup "${name}" was not found`);
    }
    await store.deleteMockup(name);
    const commitResult = await store.commit(`delete_entity: mockup:${name}`);
    return { kind: "mockup", name, path: `mockups/${name}/`, ...commitFields(commitResult), warnings: [] };
  }

  const meta = await readMockupMetaOrNotFound(store, name);
  const index = meta.variants.findIndex((v) => v.id === variant);
  if (index === -1) {
    throw new ToolError("not_found", `mockup "${name}" variant "${variant}" was not found`);
  }
  meta.variants.splice(index, 1);
  await store.writeMockupMeta(name, meta);
  await store.deleteMockupVariant(name, variant);
  const commitResult = await store.commit(`delete_entity: mockup:${name}/${variant}`);

  return {
    kind: "mockup",
    name,
    variant,
    path: `mockups/${name}/${variant}.html`,
    remaining_variant_count: meta.variants.length,
    ...commitFields(commitResult),
    warnings: [],
  };
}
