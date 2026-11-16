// Use cases: the tool layer over `usecases/` — one
// implementation for MCP and /api/tools. Reads never create anything; writes
// validate the whole call before touching a file; reference problems are
// warnings, only a malformed shape blocks.

import type { ZodError } from "zod";
import type { Store } from "../store/index.js";
import {
  ScreenLookup,
  SORT_KEYS,
  buildGeneratedPersona,
  buildPools,
  compareUseCases,
  describeIssues,
  expandCombinations,
  pairSpace,
  facetCounts,
  InvalidFileError,
  isValidId,
  ownValue,
  matchesFilter,
  personasOf,
  personaSchema,
  dataObjectSchema,
  dimensionSchema,
  resolveUseCase,
  suggestVariantGaps,
  summarize,
  useCaseSchema,
  validateDataObject,
  validatePersona,
  validateUseCase,
  type DataObject,
  type UseCaseStep,
  type Dimension,
  type Persona,
  type SortKey,
  type Strategy,
  type UseCase,
  type UseCaseFilter,
  type ValidationPools,
} from "../usecases/index.js";
import { isGeneratedId } from "../model/node-id.js";
import type { CommitResult } from "../store/index.js";
import { ToolError, commitFields, type ToolHandlerContext, type Warning } from "./types.js";

const WARNING_CAP = 50;
/** Most personas a generate_personas dry run lists; would_create keeps the full count. */
const DRY_RUN_PERSONA_CAP = 50;

/** De-duplicated and capped: a bulk write over thousands of cases must not answer with thousands of lines. */
function reportWarnings(warnings: Warning[]): { warnings: Warning[]; warning_count?: number } {
  const seen = new Set<string>();
  const unique = warnings.filter((w) => {
    const key = `${w.kind}|${w.target ?? ""}|${w.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length > WARNING_CAP ? { warnings: unique.slice(0, WARNING_CAP), warning_count: unique.length } : { warnings: unique };
}

async function loadPools(store: Store): Promise<{ pools: ValidationPools; dimensions: Dimension[]; personas: Persona[]; objects: DataObject[] }> {
  const [pool, objects] = await Promise.all([store.readPersonaPool(), store.readDataObjects()]);
  return { pools: buildPools(pool.dimensions, pool.personas, objects), dimensions: pool.dimensions, personas: pool.personas, objects };
}

/**
 * One write at a time per store: set_use_cases, generate_personas and the
 * use-case delete kinds all read, change and rewrite the same pool files, so
 * two parallel calls would lose one of the updates. A plain promise chain per
 * store object, in-process only (the daemon holds one store per project).
 */
const writeChains = new WeakMap<Store, Promise<unknown>>();

function serialized<T>(store: Store, run: () => Promise<T>): Promise<T> {
  const next = (writeChains.get(store) ?? Promise.resolve()).then(run, run);
  writeChains.set(store, next.catch(() => undefined));
  return next;
}

/** A use-case file that no longer validates is a state problem, not an I/O failure — and the one case where usecases/ may be repaired by hand. */
function invalidFileAsToolError(err: unknown): never {
  if (!(err instanceof InvalidFileError)) throw err;
  const caseId = /^usecases\/cases\/(.+)\.json$/.exec(err.file)?.[1];
  const remedy =
    caseId !== undefined && isValidId(caseId)
      ? `repair the file by hand (the one case where usecases/ may be edited directly) or remove the use case with delete_entity {kind: "use_case", name: "${caseId}"}`
      : "repair or remove the file by hand (the one case where usecases/ may be edited directly)";
  throw new ToolError("invalid_state", `${err.message} — ${remedy}`);
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    return invalidFileAsToolError(err);
  }
}

/**
 * The commit of a use-case write. An agent's write follows the usual rules
 * (`autoCommit`, the whole project). A write that came through the preview
 * (`ctx.source === "human"`, set by the server route, never by the client)
 * commits only the files this very call wrote or deleted and says so in the
 * message, so a `(preview)` commit holds exactly what that call changed.
 */
function commitUseCaseWrite(store: Store, ctx: ToolHandlerContext | undefined, tool: string, summary: string, files: string[]): Promise<CommitResult> {
  if (ctx?.source === "human") return store.commitPaths(`${tool} (preview): ${summary}`, files);
  return store.commit(`${tool}: ${summary}`);
}

const POOL_FILE = "usecases/personas.json";
const OBJECTS_FILE = "usecases/data-objects.json";
const caseFile = (id: string): string => `usecases/cases/${id}.json`;

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function loadUseCase(store: Store, id: string): Promise<UseCase> {
  if (!isValidId(id)) throw new ToolError("not_found", `use case "${id}" was not found`);
  try {
    return await store.readUseCase(id);
  } catch (err) {
    if (isEnoent(err)) throw new ToolError("not_found", `use case "${id}" was not found`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// list_use_cases
// ---------------------------------------------------------------------------

export type ListUseCasesInput = UseCaseFilter & {
  sort?: SortKey;
  cursor?: string;
  limit?: number;
  include?: ("personas" | "dimensions" | "data_objects")[];
};

async function listUseCasesInner(store: Store, input: ListUseCasesInput): Promise<Record<string, unknown>> {
  const limit = input.limit ?? 50;
  let offset = 0;
  if (input.cursor !== undefined) {
    offset = /^\d+$/.test(input.cursor) ? Number.parseInt(input.cursor, 10) : -1;
    if (offset < 0) throw new ToolError("validation_failed", `invalid cursor "${input.cursor}"`);
  }
  const sort = input.sort ?? "group";
  if (!SORT_KEYS.includes(sort)) throw new ToolError("validation_failed", `sort must be one of ${SORT_KEYS.join(", ")}`);

  const { useCases, invalid } = await store.readUseCases();
  const matches = useCases.filter((useCase) => matchesFilter(useCase, input));
  matches.sort(compareUseCases(sort));

  const response: Record<string, unknown> = {
    total: matches.length,
    use_cases: matches.slice(offset, offset + limit).map(summarize),
  };
  if (offset + limit < matches.length) response.next_cursor = String(offset + limit);

  const wantsPools = (input.include ?? []).length > 0;
  if (input.cursor === undefined || wantsPools) {
    const { dimensions, personas, objects } = await loadPools(store);
    if (input.cursor === undefined) {
      response.counts = { use_cases: useCases.length, personas: personas.length, dimensions: dimensions.length, data_objects: objects.length };
      const { facets, truncated } = facetCounts(matches);
      response.facets = facets;
      if (truncated.length > 0) response.facets_truncated = truncated;
    }
    if (input.include?.includes("personas")) response.personas = personas;
    if (input.include?.includes("dimensions")) response.dimensions = dimensions;
    if (input.include?.includes("data_objects")) response.data_objects = objects;
  }
  if (invalid.length > 0) {
    response.warnings = invalid.slice(0, 10).map((file): Warning => ({ kind: "invalid_file", target: `use_case:${file.id}`, message: `usecases/cases/${file.id}.json is not loaded: ${file.error}` }));
    if (invalid.length > 10) response.invalid_file_count = invalid.length;
  }
  return response;
}

// ---------------------------------------------------------------------------
// get_use_case
// ---------------------------------------------------------------------------

export type GetUseCaseInput = { id: string; variant?: string };

type Mapping = { step: string; scope: "screen" | "element"; node?: { id: string; tag: string; text: string }; stale?: true; unstable?: true; variants?: string[] };
type MappedScreen = { screen: string; exists: boolean; title?: string; mappings: Mapping[] };

async function getUseCaseInner(store: Store, input: GetUseCaseInput): Promise<Record<string, unknown>> {
  const useCase = await loadUseCase(store, input.id);
  const variant = input.variant === undefined ? undefined : useCase.variants?.find((v) => v.id === input.variant);
  if (input.variant !== undefined && !variant) {
    throw new ToolError("not_found", `use case "${input.id}" has no variant "${input.variant}"`);
  }

  const resolved = resolveUseCase(useCase, variant);
  const effective = resolved.use_case;
  const { pools, dimensions, personas, objects } = await loadPools(store);

  // What a coding agent needs to implement this view of the case: with a variant selected only what that
  // variant touches, otherwise everything the case and its variants name (so the whole picture is one call).
  const scope: UseCase[] = variant ? [] : [useCase];
  const personaIds = new Set<string>([...effective.personas, ...effective.steps.map((s) => s.actor)]);
  const objectIds = new Set<string>();
  const addIo = (list: { object: string }[]): void => list.forEach((item) => objectIds.add(item.object));
  addIo(effective.inputs);
  addIo(effective.outputs);
  for (const step of effective.steps) addIo(step.data ?? []);
  for (const source of scope) {
    for (const v of source.variants ?? []) {
      (v.personas ?? []).forEach((id) => personaIds.add(id));
      addIo(v.inputs ?? []);
      addIo(v.outputs ?? []);
      for (const op of v.steps ?? []) {
        if (op.op === "remove") continue;
        personaIds.add(op.step.actor);
        addIo(op.step.data ?? []);
      }
    }
  }
  personaIds.delete("system");
  // Objects reached through `ref` fields travel along.
  for (const id of objectIds) {
    for (const field of pools.objects.get(id)?.fields ?? []) if (field.type === "ref" && field.ref !== undefined) objectIds.add(field.ref);
  }
  const bundlePersonas = personas.filter((p) => personaIds.has(p.id));
  const dimensionIds = new Set<string>(bundlePersonas.flatMap((p) => Object.keys(p.traits)));
  for (const v of variant ? [variant] : (useCase.variants ?? [])) Object.keys(v.when).forEach((id) => dimensionIds.add(id));

  const lookup = new ScreenLookup(store);
  const screens = new Map<string, MappedScreen>();
  // The effective flow, plus (without a selected variant) the steps only variants map, tagged with the variants using them.
  type Source = { step: UseCaseStep; variants?: string[] };
  const sources: Source[] = effective.steps.map((step) => ({ step }));
  if (!variant) {
    const byKey = new Map<string, Source>();
    for (const v of useCase.variants ?? []) {
      for (const op of v.steps ?? []) {
        if (op.op === "remove" || !op.step.target) continue;
        const key = `${op.step.id}|${op.step.target.screen}|${op.step.target.node ?? ""}`;
        const known = byKey.get(key);
        if (known) known.variants!.push(v.id);
        else {
          const source: Source = { step: op.step, variants: [v.id] };
          byKey.set(key, source);
          sources.push(source);
        }
      }
    }
  }
  for (const { step, variants } of sources) {
    if (!step.target) continue;
    const { screen, node } = step.target;
    let entry = screens.get(screen);
    if (!entry) {
      const exists = await lookup.hasScreen(screen);
      const title = exists ? await lookup.title(screen) : undefined;
      entry = { screen, exists, ...(title !== undefined ? { title } : {}), mappings: [] };
      screens.set(screen, entry);
    }
    const tail = { ...(variants ? { variants } : {}) };
    if (node === undefined) {
      entry.mappings.push({ step: step.id, scope: "screen", ...(entry.exists ? {} : { stale: true as const }), ...tail });
      continue;
    }
    const mapped = entry.exists ? await lookup.node(screen, node) : undefined;
    entry.mappings.push({
      step: step.id,
      scope: "element",
      node: mapped ?? { id: node, tag: "", text: "" },
      ...(mapped ? {} : { stale: true as const }),
      ...(isGeneratedId(node) ? { unstable: true as const } : {}),
      ...tail,
    });
  }

  const warnings = await validateUseCase(useCase, pools, lookup);
  const response: Record<string, unknown> = {
    use_case: effective,
    ...(variant ? { variant: { id: variant.id, title: variant.title, ...(variant.description !== undefined ? { description: variant.description } : {}), when: variant.when } } : {}),
    ...(!variant && (useCase.variants?.length ?? 0) > 0
      ? { variants: useCase.variants!.map((v) => ({ id: v.id, title: v.title, ...(v.description !== undefined ? { description: v.description } : {}), when: v.when })) }
      : {}),
    ...(resolved.removed_steps.length > 0 ? { removed_steps: resolved.removed_steps } : {}),
    personas: bundlePersonas,
    dimensions: dimensions.filter((d) => dimensionIds.has(d.id)),
    data_objects: objects.filter((o) => objectIds.has(o.id)),
    screens: [...screens.values()],
    ...reportWarnings(warnings),
  };
  return response;
}

// ---------------------------------------------------------------------------
// set_use_cases
// ---------------------------------------------------------------------------

const ENTITY_LIMIT = 5000;
const ERROR_LIMIT = 10;

export type SetUseCasesInput = {
  dimensions?: Record<string, unknown>[];
  personas?: Record<string, unknown>[];
  data_objects?: Record<string, unknown>[];
  use_cases?: Record<string, unknown>[];
};

type Parsed<T> = { id: string; value: T; created: boolean };

/** Shallow merge: given keys replace, `null` removes a key. Nothing else of an existing entity is touched. */
function applyPatch(base: Record<string, unknown> | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

function parseEntities<T>(
  label: string,
  items: Record<string, unknown>[] | undefined,
  existing: Map<string, T>,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: ZodError } },
  errors: string[],
): Parsed<T>[] {
  const result: Parsed<T>[] = [];
  const seen = new Set<string>();
  (items ?? []).forEach((item, index) => {
    const id = typeof item.id === "string" ? item.id : undefined;
    const at = `${label}[${index}]${id ? ` (${id})` : ""}`;
    if (id === undefined) {
      errors.push(`${at}: id is required`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`${at}: id appears twice in this call`);
      return;
    }
    seen.add(id);
    const before = existing.get(id);
    const parsed = schema.safeParse(applyPatch(before as Record<string, unknown> | undefined, item));
    if (!parsed.success) errors.push(describeIssues(parsed.error, `${at}.`));
    else result.push({ id, value: parsed.data, created: before === undefined });
  });
  return result;
}

function upsert<T extends { id: string }>(current: T[], changes: Parsed<T>[]): T[] {
  const byId = new Map(changes.map((c) => [c.id, c.value]));
  const next = current.map((item) => byId.get(item.id) ?? item);
  const known = new Set(current.map((item) => item.id));
  for (const change of changes) if (!known.has(change.id)) next.push(change.value);
  return next;
}

const WRITE_BATCH = 32;

async function setUseCasesInner(store: Store, input: SetUseCasesInput, ctx: ToolHandlerContext | undefined): Promise<Record<string, unknown>> {
  for (const key of ["dimensions", "personas", "data_objects", "use_cases"] as const) {
    const items = input[key];
    if (items !== undefined && items.length > ENTITY_LIMIT) throw new ToolError("validation_failed", `${key}: at most ${ENTITY_LIMIT} per call, got ${items.length}`);
  }
  if (!input.dimensions?.length && !input.personas?.length && !input.data_objects?.length && !input.use_cases?.length) {
    throw new ToolError("validation_failed", "at least one of dimensions, personas, data_objects, use_cases is required");
  }

  const pool = await store.readPersonaPool();
  const objects = await store.readDataObjects();
  const existingCases = new Map<string, UseCase>();
  for (const item of input.use_cases ?? []) {
    if (typeof item.id !== "string" || !isValidId(item.id) || existingCases.has(item.id)) continue;
    try {
      existingCases.set(item.id, await store.readUseCase(item.id));
    } catch (err) {
      // A missing case is a create; one that no longer validates is replaced by the (complete) incoming one.
      if (!isEnoent(err) && !(err instanceof InvalidFileError)) throw err;
    }
  }

  const errors: string[] = [];
  const dimensions = parseEntities("dimensions", input.dimensions, new Map(pool.dimensions.map((d) => [d.id, d])), dimensionSchema, errors);
  const personas = parseEntities("personas", input.personas, new Map(pool.personas.map((p) => [p.id, p])), personaSchema, errors);
  const dataObjects = parseEntities("data_objects", input.data_objects, new Map(objects.map((o) => [o.id, o])), dataObjectSchema, errors);
  const useCases = parseEntities("use_cases", input.use_cases, existingCases, useCaseSchema, errors);
  // A variant op must not put a second step with an existing id into the effective flow.
  for (const { id, value } of useCases) {
    for (const variant of value.variants ?? []) {
      for (const issue of resolveUseCase(value, variant).issues) {
        if (issue.kind === "duplicate_step_id") errors.push(`use_cases (${id}).variants.${variant.id}.steps.${issue.op}: ${issue.message}`);
      }
    }
  }
  if (errors.length > 0) {
    const more = errors.length > ERROR_LIMIT ? ` (+${errors.length - ERROR_LIMIT} more)` : "";
    throw new ToolError("validation_failed", `nothing written — ${errors.slice(0, ERROR_LIMIT).join("; ")}${more}`);
  }

  const nextDimensions = upsert(pool.dimensions, dimensions);
  const nextPersonas = upsert(pool.personas, personas);
  const nextObjects = upsert(objects, dataObjects);
  const pools = buildPools(nextDimensions, nextPersonas, nextObjects);

  const warnings: Warning[] = [];
  for (const persona of personas) warnings.push(...validatePersona(persona.value, pools));
  for (const object of dataObjects) warnings.push(...validateDataObject(object.value, pools));
  const lookup = new ScreenLookup(store);
  for (const useCase of useCases) warnings.push(...(await validateUseCase(useCase.value, pools, lookup)));

  const files: string[] = [];
  if (dimensions.length > 0 || personas.length > 0) {
    await store.writePersonaPool({ dimensions: nextDimensions, personas: nextPersonas });
    files.push(POOL_FILE);
  }
  if (dataObjects.length > 0) {
    await store.writeDataObjects(nextObjects);
    files.push(OBJECTS_FILE);
  }
  for (let i = 0; i < useCases.length; i += WRITE_BATCH) {
    const batch = useCases.slice(i, i + WRITE_BATCH);
    await Promise.all(batch.map((useCase) => store.writeUseCase(useCase.value)));
    files.push(...batch.map((useCase) => caseFile(useCase.id)));
  }

  const counts: Record<string, unknown> = {};
  const summary: string[] = [];
  for (const [kind, changes] of [["dimensions", dimensions], ["personas", personas], ["data_objects", dataObjects], ["use_cases", useCases]] as const) {
    if (changes.length === 0) continue;
    const created = changes.filter((c) => c.created).map((c) => c.id);
    const updated = changes.filter((c) => !c.created).map((c) => c.id);
    counts[kind] = {
      created: created.length,
      updated: updated.length,
    };
    summary.push(`${changes.length} ${kind}`);
  }
  const commitResult = await commitUseCaseWrite(store, ctx, "set_use_cases", summary.join(", "), files);
  return { ...counts, ...commitFields(commitResult), ...reportWarnings(warnings) };
}

// ---------------------------------------------------------------------------
// generate_personas
// ---------------------------------------------------------------------------

export type GeneratePersonasInput = { strategy?: Strategy; dimensions?: string[]; limit?: number; dry_run?: boolean };

const MAX_COMBINATION_SPACE = 1_000_000;

async function generatePersonasInner(store: Store, input: GeneratePersonasInput, ctx: ToolHandlerContext | undefined): Promise<Record<string, unknown>> {
  const strategy = input.strategy ?? "pairwise";
  const limit = input.limit ?? 100;
  const pool = await store.readPersonaPool();

  let dimensions = pool.dimensions;
  if (input.dimensions !== undefined) {
    const unknown = input.dimensions.filter((id) => !pool.dimensions.some((d) => d.id === id));
    if (unknown.length > 0) throw new ToolError("not_found", `unknown dimension(s): ${unknown.join(", ")}`);
    dimensions = pool.dimensions.filter((d) => input.dimensions!.includes(d.id));
  }
  if (dimensions.length === 0) {
    throw new ToolError("validation_failed", "no dimensions to expand — define them first with set_use_cases { dimensions: [...] }");
  }
  const space = dimensions.reduce((size, d) => size * d.values.length, 1);
  if (strategy === "all" && space > MAX_COMBINATION_SPACE) {
    throw new ToolError("validation_failed", `strategy "all" would span ${space} combinations — use "pairwise" or narrow dimensions`);
  }
  const pairs = pairSpace(dimensions);
  if (strategy === "pairwise" && pairs > MAX_COMBINATION_SPACE) {
    throw new ToolError("validation_failed", `strategy "pairwise" would have to cover ${pairs} value pairs — narrow dimensions`);
  }

  const generated = expandCombinations(dimensions, strategy, pool.personas, limit);
  const taken = new Set(pool.personas.map((p) => p.id));
  const created = generated.combinations.map((combination, index) => buildGeneratedPersona(combination, dimensions, taken, pool.personas.length + index));

  const base = {
    strategy,
    total: generated.total,
    skipped_covered: generated.skipped_covered,
    ...(generated.truncated ? { truncated: true } : {}),
    ...(generated.partial
      ? {
          partial: true,
          warnings: [{ kind: "partial_result", message: "generation stopped at its work budget before the whole space was walked, so this is a prefix of the full result — narrow dimensions and call again" } satisfies Warning],
        }
      : {}),
  };
  if (input.dry_run === true) {
    return {
      dry_run: true,
      ...base,
      would_create: created.length,
      personas: created.slice(0, DRY_RUN_PERSONA_CAP).map((p) => ({ id: p.id, name: p.name, traits: p.traits })),
      ...(created.length > DRY_RUN_PERSONA_CAP ? { personas_truncated: true } : {}),
    };
  }
  if (created.length === 0) return { ...base, created: 0 };

  await store.writePersonaPool({ dimensions: pool.dimensions, personas: [...pool.personas, ...created] });
  const commitResult = await commitUseCaseWrite(store, ctx, "generate_personas", `${created.length} ${strategy}`, [POOL_FILE]);
  return { ...base, created: created.length, ...(created.length <= WARNING_CAP ? { ids: created.map((p) => p.id) } : {}), ...commitFields(commitResult) };
}

// ---------------------------------------------------------------------------
// suggest_use_case_variants
// ---------------------------------------------------------------------------

export type SuggestVariantsInput = { id: string; limit?: number };

async function suggestVariantsInner(store: Store, input: SuggestVariantsInput): Promise<Record<string, unknown>> {
  const useCase = await loadUseCase(store, input.id);
  const pool = await store.readPersonaPool();
  const { coverage, suggestions } = suggestVariantGaps(useCase, pool.dimensions, pool.personas);
  const limit = input.limit ?? 20;
  return {
    coverage,
    suggestions: suggestions.slice(0, limit),
    ...(suggestions.length > limit ? { suggestion_count: suggestions.length } : {}),
    ...(pool.dimensions.length === 0 || pool.personas.length === 0 ? { hint: "define dimensions and personas first (set_use_cases), traits drive the suggestions" } : {}),
  };
}

// ---------------------------------------------------------------------------
// delete_entity — use-case kinds
// ---------------------------------------------------------------------------

export const USE_CASE_ENTITY_KINDS = ["persona", "data_object", "use_case", "dimension"] as const;
export type UseCaseEntityKind = (typeof USE_CASE_ENTITY_KINDS)[number];

const EXAMPLE_IDS = 5;

function dangling(kind: string, name: string, referrers: string[], by: string): Warning[] {
  if (referrers.length === 0) return [];
  const shown = referrers.slice(0, EXAMPLE_IDS).join(", ");
  const more = referrers.length > EXAMPLE_IDS ? `, +${referrers.length - EXAMPLE_IDS} more` : "";
  return [{ kind: "dangling_reference", target: `${kind}:${name}`, message: `${kind} "${name}" is still referenced by ${referrers.length} ${by}: ${shown}${more}` }];
}

function objectIdsOf(useCase: UseCase): Set<string> {
  const ids = new Set<string>();
  const add = (list: { object: string }[] | undefined): void => list?.forEach((item) => ids.add(item.object));
  add(useCase.inputs);
  add(useCase.outputs);
  for (const step of useCase.steps) add(step.data);
  for (const variant of useCase.variants ?? []) {
    add(variant.inputs);
    add(variant.outputs);
    for (const op of variant.steps ?? []) if (op.op !== "remove") add(op.step.data);
  }
  return ids;
}

async function deleteUseCaseEntityInner(store: Store, kind: UseCaseEntityKind, name: string, ctx: ToolHandlerContext | undefined): Promise<Record<string, unknown>> {
  const notFound = (): ToolError => new ToolError("not_found", `${kind.replace("_", " ")} "${name}" was not found`);
  let path: string;
  let warnings: Warning[] = [];

  if (kind === "use_case") {
    path = caseFile(name);
    if (!isValidId(name) || !(await store.listUseCaseIds()).includes(name)) throw notFound();
    await store.deleteUseCase(name);
  } else if (kind === "persona" || kind === "dimension") {
    path = POOL_FILE;
    const pool = await store.readPersonaPool();
    const list: { id: string }[] = kind === "persona" ? pool.personas : pool.dimensions;
    if (!list.some((item) => item.id === name)) throw notFound();
    const { useCases } = await store.readUseCases();
    if (kind === "persona") {
      warnings = dangling("persona", name, useCases.filter((u) => personasOf(u).has(name)).map((u) => u.id), "use case(s)");
      await store.writePersonaPool({ dimensions: pool.dimensions, personas: pool.personas.filter((p) => p.id !== name) });
    } else {
      warnings = [
        ...dangling("dimension", name, pool.personas.filter((p) => ownValue(p.traits, name) !== undefined).map((p) => p.id), "persona(s)"),
        ...dangling("dimension", name, useCases.filter((u) => u.variants?.some((v) => ownValue(v.when, name) !== undefined)).map((u) => u.id), "use case(s) via variant conditions"),
      ];
      await store.writePersonaPool({ dimensions: pool.dimensions.filter((d) => d.id !== name), personas: pool.personas });
    }
  } else {
    path = OBJECTS_FILE;
    const objects = await store.readDataObjects();
    if (!objects.some((o) => o.id === name)) throw notFound();
    const { useCases } = await store.readUseCases();
    warnings = [
      ...dangling("data_object", name, useCases.filter((u) => objectIdsOf(u).has(name)).map((u) => u.id), "use case(s)"),
      ...dangling("data_object", name, objects.filter((o) => o.id !== name && o.fields.some((f) => f.ref === name)).map((o) => o.id), "data object(s) via a ref field"),
    ];
    await store.writeDataObjects(objects.filter((o) => o.id !== name));
  }

  const commitResult = await commitUseCaseWrite(store, ctx, "delete_entity", `${kind}:${name}`, [path]);
  return { kind, name, path, ...commitFields(commitResult), warnings };
}

// Public entry points: invalid files become invalid_state; every writer runs one at a time per store.

export const listUseCases = (store: Store, input: ListUseCasesInput): Promise<Record<string, unknown>> => guarded(() => listUseCasesInner(store, input));
export const getUseCase = (store: Store, input: GetUseCaseInput): Promise<Record<string, unknown>> => guarded(() => getUseCaseInner(store, input));
export const suggestVariants = (store: Store, input: SuggestVariantsInput): Promise<Record<string, unknown>> => guarded(() => suggestVariantsInner(store, input));
export const setUseCases = (store: Store, input: SetUseCasesInput, ctx?: ToolHandlerContext): Promise<Record<string, unknown>> =>
  guarded(() => serialized(store, () => setUseCasesInner(store, input, ctx)));
export const generatePersonas = (store: Store, input: GeneratePersonasInput, ctx?: ToolHandlerContext): Promise<Record<string, unknown>> =>
  guarded(() => serialized(store, () => generatePersonasInner(store, input, ctx)));
export const deleteUseCaseEntity = (store: Store, kind: UseCaseEntityKind, name: string, ctx?: ToolHandlerContext): Promise<Record<string, unknown>> =>
  guarded(() => serialized(store, () => deleteUseCaseEntityInner(store, kind, name, ctx)));
