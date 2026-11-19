// Use cases: the tool layer over `usecases/` — one
// implementation for MCP and /api/tools. Reads never create anything; writes
// validate the whole call before touching a file; reference problems are
// warnings, only a malformed shape blocks.

import type { ZodError } from "zod";
import type { Store } from "../store/index.js";
import {
  ScreenLookup,
  SORT_KEYS,
  ambiguousIds,
  buildGeneratedConstellation,
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
  objectIdsOf,
  actorMapPersonas,
  constellationMembers,
  constellationsOf,
  personasOf,
  stateSubjectsOf,
  resolveParticipant,
  personaSchema,
  constellationSchema,
  dataObjectSchema,
  dimensionSchema,
  entitySchema,
  relationshipTypeSchema,
  resolveUseCase,
  suggestVariantGaps,
  summarize,
  useCaseSchema,
  validateDataObject,
  validatePersona,
  validateUseCase,
  type DataObject,
  type World,
  type WorldLookup,
  type Constellation,
  type StepOp,
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
const ERROR_LIMIT = 10;
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
      ? `repair the file by hand (the one case where usecases/ may be edited directly) or remove the use case with delete_entity {kind: "use_case", name: "${caseId}"} and write it again with set_use_cases (the full case)`
      : "repair or remove the file by hand (the one case where usecases/ may be edited directly)";
  throw new ToolError("invalid_state", `${err.message} — ${remedy}`);
}

/** Several invalid stored cases in one call: one error naming the first ERROR_LIMIT files and counting the rest, with the remedy of the single-file message once. */
function invalidCasesAsToolError(errors: InvalidFileError[]): never {
  if (errors.length === 1) return invalidFileAsToolError(errors[0]);
  const more = errors.length > ERROR_LIMIT ? ` (+${errors.length - ERROR_LIMIT} more)` : "";
  const named = errors.slice(0, ERROR_LIMIT).map((err) => err.message).join(" | ") + more;
  throw new ToolError(
    "invalid_state",
    `${errors.length} stored use cases are invalid, nothing written — ${named} — repair each file by hand (the one case where usecases/ may be edited directly) or remove the use case with delete_entity {kind: "use_case", name: "<id>"} and write it again with set_use_cases (the full case)`,
  );
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
const WORLD_FILE = "usecases/world.json";
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
  // The world is read only for the `entity` filter, so a project without one pays nothing.
  let world: WorldLookup | undefined;
  if ((input.entity ?? "").trim() !== "") {
    const [{ constellations, entities }, pool] = await Promise.all([store.readWorld(), store.readPersonaPool()]);
    world = { constellations, isEntity: (id) => resolveParticipant(id, pool.personas, entities) === "entity" };
  }
  const matches = useCases.filter((useCase) => matchesFilter(useCase, input, world));
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

type Mapping = { step: string; scope: "screen" | "element"; node?: { id: string; tag: string; text: string }; stale?: true; unstable?: true; variants?: string[]; branch?: string };
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
  const world = await store.readWorld();

  // The world the bundle names (ADR-011): with a variant the effective case's constellations, otherwise the case's and every variant's.
  const constellationIds = variant ? new Set(effective.constellations) : constellationsOf(useCase);
  const bundleConstellations = world.constellations.filter((c) => constellationIds.has(c.id));
  const memberIds = new Set(bundleConstellations.flatMap((c) => [...constellationMembers(c)]));
  // With a variant, what it removed still names subjects: they stay resolvable in the same response.
  const removedSubjects = [...resolved.removed_state.map((e) => e.subject), ...resolved.removed_branches.flatMap((b) => b.when.map((c) => c.subject))];
  const entityIds = new Set([...memberIds, ...stateSubjectsOf(variant ? effective : useCase), ...removedSubjects].filter((id) => resolveParticipant(id, personas, world.entities) === "entity"));
  const bundleEntities = world.entities.filter((e) => entityIds.has(e.id));
  const bundleRelationshipTypes = world.relationship_types.filter((t) => bundleConstellations.some((c) => c.relationships.some((r) => r.type === t.id)));

  // What a coding agent needs to implement this view of the case: with a variant selected only what that
  // variant touches, otherwise everything the case and its variants name (so the whole picture is one call).
  const personaIds = personasOf(variant ? effective : useCase);
  const objectIds = objectIdsOf(variant ? effective : useCase);
  // The selected variant's map names personas the effective flow may no longer show (a key nothing uses any more).
  if (variant) for (const id of actorMapPersonas(variant)) personaIds.add(id);
  personaIds.delete("system");
  for (const id of memberIds) if (resolveParticipant(id, personas, world.entities) === "persona") personaIds.add(id);
  for (const entity of bundleEntities) if (entity.object !== undefined) objectIds.add(entity.object);
  for (const type of bundleRelationshipTypes) if (type.field !== undefined) objectIds.add(type.field.object);
  // Objects reached through `ref` fields travel along, also from the world's objects.
  for (const id of objectIds) {
    for (const field of pools.objects.get(id)?.fields ?? []) if (field.type === "ref" && field.ref !== undefined) objectIds.add(field.ref);
  }
  const bundlePersonas = personas.filter((p) => personaIds.has(p.id));
  const dimensionIds = new Set<string>(bundlePersonas.flatMap((p) => Object.keys(p.traits)));
  for (const item of [...bundleEntities, ...bundleConstellations]) Object.keys(item.traits).forEach((id) => dimensionIds.add(id));
  for (const v of variant ? [variant] : (useCase.variants ?? [])) Object.keys(v.when).forEach((id) => dimensionIds.add(id));

  const lookup = new ScreenLookup(store);
  const screens = new Map<string, MappedScreen>();
  // The effective flow, plus (without a selected variant) the steps only variants map, tagged with the variants using them.
  type Source = { step: UseCaseStep; variants?: string[]; branch?: string };
  const sources: Source[] = [...effective.steps.map((step): Source => ({ step })), ...(effective.branches ?? []).flatMap((branch) => branch.steps.map((step): Source => ({ step, branch: branch.id })))];
  if (!variant) {
    const byKey = new Map<string, Source>();
    for (const v of useCase.variants ?? []) {
      // The branch each step is in at this point of the variant's ops: the base branches first, then what the ops write.
      const branchOfStep = new Map<string, string>((useCase.branches ?? []).flatMap((br) => br.steps.map((st): [string, string] => [st.id, br.id])));
      // The steps an op writes: a step op (into the branch of the step it names, or `append`'s branch), or the steps of a branch it adds or replaces.
      const introduced = (op: StepOp): Source[] => {
        if (op.op === "add_branch" || op.op === "replace_branch") {
          op.branch.steps.forEach((st) => branchOfStep.set(st.id, op.branch.id));
          return op.branch.steps.map((step) => ({ step, branch: op.branch.id }));
        }
        if (op.op === "remove" || op.op === "remove_branch") return [];
        const branch = op.op === "append" ? op.branch : branchOfStep.get(op.step_id);
        if (branch !== undefined) branchOfStep.set(op.step.id, branch);
        return [{ step: op.step, ...(branch !== undefined ? { branch } : {}) }];
      };
      for (const op of v.steps ?? []) {
        for (const { step, branch } of introduced(op)) {
          if (!step.target) continue;
          const key = `${step.id}|${step.target.screen}|${step.target.node ?? ""}|${branch ?? ""}`;
          const known = byKey.get(key);
          if (known) known.variants!.push(v.id);
          else {
            const source: Source = { step, variants: [v.id], ...(branch !== undefined ? { branch } : {}) };
            byKey.set(key, source);
            sources.push(source);
          }
        }
      }
    }
  }
  for (const { step, variants, branch } of sources) {
    if (!step.target) continue;
    const { screen, node } = step.target;
    let entry = screens.get(screen);
    if (!entry) {
      const exists = await lookup.hasScreen(screen);
      const title = exists ? await lookup.title(screen) : undefined;
      entry = { screen, exists, ...(title !== undefined ? { title } : {}), mappings: [] };
      screens.set(screen, entry);
    }
    const tail = { ...(variants ? { variants } : {}), ...(branch !== undefined ? { branch } : {}) };
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
  warnings.push(...ambiguousIds(bundlePersonas, world.entities));
  const response: Record<string, unknown> = {
    use_case: effective,
    ...(variant ? { variant: { id: variant.id, title: variant.title, ...(variant.description !== undefined ? { description: variant.description } : {}), when: variant.when } } : {}),
    ...(!variant && (useCase.variants?.length ?? 0) > 0
      ? { variants: useCase.variants!.map((v) => ({ id: v.id, title: v.title, ...(v.description !== undefined ? { description: v.description } : {}), when: v.when })) }
      : {}),
    ...(resolved.removed_steps.length > 0 ? { removed_steps: resolved.removed_steps } : {}),
    ...(resolved.removed_branches.length > 0 ? { removed_branches: resolved.removed_branches } : {}),
    ...(resolved.removed_state.length > 0 ? { removed_state: resolved.removed_state } : {}),
    personas: bundlePersonas,
    dimensions: dimensions.filter((d) => dimensionIds.has(d.id)),
    data_objects: objects.filter((o) => objectIds.has(o.id)),
    ...(bundleEntities.length > 0 ? { entities: bundleEntities } : {}),
    ...(bundleConstellations.length > 0 ? { constellations: bundleConstellations } : {}),
    ...(bundleRelationshipTypes.length > 0 ? { relationship_types: bundleRelationshipTypes } : {}),
    screens: [...screens.values()],
    ...reportWarnings(warnings),
  };
  return response;
}

// ---------------------------------------------------------------------------
// set_use_cases
// ---------------------------------------------------------------------------

const ENTITY_LIMIT = 5000;
const SET_KEYS = ["dimensions", "personas", "entities", "relationship_types", "constellations", "data_objects", "use_cases"] as const;

export type SetUseCasesInput = {
  dimensions?: Record<string, unknown>[];
  personas?: Record<string, unknown>[];
  data_objects?: Record<string, unknown>[];
  use_cases?: Record<string, unknown>[];
  entities?: Record<string, unknown>[];
  relationship_types?: Record<string, unknown>[];
  constellations?: Record<string, unknown>[];
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

/**
 * The stored versions of the cases a call names, read in batches like the writes. A missing case is a create.
 * An invalid stored case is never overwritten: every one the call names is collected and reported together as
 * invalid_state (hand repair, or delete_entity then set_use_cases), and nothing of the call is written.
 */
async function readExistingCases(store: Store, items: Record<string, unknown>[] | undefined): Promise<Map<string, UseCase>> {
  const ids = [...new Set((items ?? []).flatMap((item) => (typeof item.id === "string" && isValidId(item.id) ? [item.id] : [])))];
  const existing = new Map<string, UseCase>();
  const invalid: InvalidFileError[] = [];
  for (let i = 0; i < ids.length; i += WRITE_BATCH) {
    const batch = ids.slice(i, i + WRITE_BATCH);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          return await store.readUseCase(id);
        } catch (err) {
          if (isEnoent(err)) return undefined;
          if (err instanceof InvalidFileError) return err;
          throw err;
        }
      }),
    );
    results.forEach((result, index) => {
      if (result instanceof InvalidFileError) invalid.push(result);
      else if (result !== undefined) existing.set(batch[index]!, result);
    });
  }
  if (invalid.length > 0) invalidCasesAsToolError(invalid);
  return existing;
}

async function setUseCasesInner(store: Store, input: SetUseCasesInput, ctx: ToolHandlerContext | undefined): Promise<Record<string, unknown>> {
  for (const key of SET_KEYS) {
    const items = input[key];
    if (items !== undefined && items.length > ENTITY_LIMIT) throw new ToolError("validation_failed", `${key}: at most ${ENTITY_LIMIT} per call, got ${items.length}`);
  }
  if (SET_KEYS.every((key) => !input[key]?.length)) {
    throw new ToolError("validation_failed", `at least one of ${SET_KEYS.join(", ")} is required`);
  }

  const [pool, world, objects] = await Promise.all([store.readPersonaPool(), store.readWorld(), store.readDataObjects()]);
  const existingCases = await readExistingCases(store, input.use_cases);

  const errors: string[] = [];
  const dimensions = parseEntities("dimensions", input.dimensions, new Map(pool.dimensions.map((d) => [d.id, d])), dimensionSchema, errors);
  const personas = parseEntities("personas", input.personas, new Map(pool.personas.map((p) => [p.id, p])), personaSchema, errors);
  const entities = parseEntities("entities", input.entities, new Map(world.entities.map((e) => [e.id, e])), entitySchema, errors);
  const relationshipTypes = parseEntities("relationship_types", input.relationship_types, new Map(world.relationship_types.map((t) => [t.id, t])), relationshipTypeSchema, errors);
  const constellations = parseEntities("constellations", input.constellations, new Map(world.constellations.map((c) => [c.id, c])), constellationSchema, errors);
  const dataObjects = parseEntities("data_objects", input.data_objects, new Map(objects.map((o) => [o.id, o])), dataObjectSchema, errors);
  const useCases = parseEntities("use_cases", input.use_cases, existingCases, useCaseSchema, errors);
  // A variant op must not put a second step with an existing id into the effective flow.
  for (const { id, value } of useCases) {
    for (const variant of value.variants ?? []) {
      for (const issue of resolveUseCase(value, variant).issues) {
        if (issue.kind === "duplicate_step_id" || issue.kind === "duplicate_branch_id") errors.push(`use_cases (${id}).variants.${variant.id}.steps.${issue.op}: ${issue.message}`);
      }
    }
  }
  if (errors.length > 0) {
    const more = errors.length > ERROR_LIMIT ? ` (+${errors.length - ERROR_LIMIT} more)` : "";
    throw new ToolError("validation_failed", `nothing written — ${errors.slice(0, ERROR_LIMIT).join("; ")}${more}`);
  }

  const nextDimensions = upsert(pool.dimensions, dimensions);
  const nextPersonas = upsert(pool.personas, personas);
  const nextWorld: World = {
    entities: upsert(world.entities, entities),
    relationship_types: upsert(world.relationship_types, relationshipTypes),
    constellations: upsert(world.constellations, constellations),
  };
  const nextObjects = upsert(objects, dataObjects);
  const pools = buildPools(nextDimensions, nextPersonas, nextObjects);

  const warnings: Warning[] = [];
  for (const persona of personas) warnings.push(...validatePersona(persona.value, pools));
  // A persona and an entity with one id are both written; the warning names the ids this call touched.
  warnings.push(...ambiguousIds(nextPersonas, nextWorld.entities, new Set([...personas, ...entities].map((c) => c.id))));
  for (const object of dataObjects) warnings.push(...validateDataObject(object.value, pools));
  const lookup = new ScreenLookup(store);
  for (const useCase of useCases) warnings.push(...(await validateUseCase(useCase.value, pools, lookup)));

  const files: string[] = [];
  if (dimensions.length > 0 || personas.length > 0) {
    await store.writePersonaPool({ dimensions: nextDimensions, personas: nextPersonas });
    files.push(POOL_FILE);
  }
  if (entities.length > 0 || relationshipTypes.length > 0 || constellations.length > 0) {
    await store.writeWorld(nextWorld);
    files.push(WORLD_FILE);
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
  for (const [kind, changes] of [["dimensions", dimensions], ["personas", personas], ["entities", entities], ["relationship_types", relationshipTypes], ["constellations", constellations], ["data_objects", dataObjects], ["use_cases", useCases]] as const) {
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

export type GeneratePersonasInput = { strategy?: Strategy; dimensions?: string[]; limit?: number; dry_run?: boolean; target?: "personas" | "constellations" };

const MAX_COMBINATION_SPACE = 1_000_000;

async function generatePersonasInner(store: Store, input: GeneratePersonasInput, ctx: ToolHandlerContext | undefined): Promise<Record<string, unknown>> {
  const strategy = input.strategy ?? "pairwise";
  const limit = input.limit ?? 100;
  const target = input.target ?? "personas";
  const pool = await store.readPersonaPool();
  const world = await store.readWorld();

  // A dimension is expanded for exactly one target; unset means personas.
  const scopeOf = (d: { scope?: string }): string => d.scope ?? "personas";
  let dimensions = pool.dimensions.filter((d) => scopeOf(d) === target);
  if (input.dimensions !== undefined) {
    const unknown = input.dimensions.filter((id) => !pool.dimensions.some((d) => d.id === id));
    if (unknown.length > 0) throw new ToolError("not_found", `unknown dimension(s): ${unknown.join(", ")}`);
    const wrong = pool.dimensions.filter((d) => input.dimensions!.includes(d.id) && scopeOf(d) !== target);
    if (wrong.length > 0) {
      throw new ToolError("validation_failed", `dimension(s) with the wrong scope for target "${target}": ${wrong.map((d) => `${d.id} (scope "${scopeOf(d)}")`).join(", ")}`);
    }
    dimensions = dimensions.filter((d) => input.dimensions!.includes(d.id));
  }
  if (dimensions.length === 0) {
    throw new ToolError("validation_failed", `no ${target}-scoped dimensions to expand — define them first with set_use_cases { dimensions: [...] }`);
  }
  const space = dimensions.reduce((size, d) => size * d.values.length, 1);
  if (strategy === "all" && space > MAX_COMBINATION_SPACE) {
    throw new ToolError("validation_failed", `strategy "all" would span ${space} combinations — use "pairwise" or narrow dimensions`);
  }
  const pairs = pairSpace(dimensions);
  if (strategy === "pairwise" && pairs > MAX_COMBINATION_SPACE) {
    throw new ToolError("validation_failed", `strategy "pairwise" would have to cover ${pairs} value pairs — narrow dimensions`);
  }

  const forConstellations = target === "constellations";
  const existing = forConstellations ? world.constellations : pool.personas;
  const generated = expandCombinations(dimensions, strategy, existing, limit);
  // Personas share their id space with entities; constellations only collide with constellations.
  const taken = new Set(forConstellations ? world.constellations.map((c) => c.id) : [...pool.personas.map((p) => p.id), ...world.entities.map((e) => e.id)]);
  const created = generated.combinations.map((combination, index) =>
    forConstellations
      ? buildGeneratedConstellation(combination, dimensions, taken, existing.length + index)
      : buildGeneratedPersona(combination, dimensions, taken, existing.length + index),
  );

  const base = {
    strategy,
    ...(forConstellations ? { target } : {}),
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
      [target]: created.slice(0, DRY_RUN_PERSONA_CAP).map((p) => ({ id: p.id, name: p.name, traits: p.traits })),
      ...(created.length > DRY_RUN_PERSONA_CAP ? { [`${target}_truncated`]: true } : {}),
    };
  }
  if (created.length === 0) return { ...base, created: 0 };

  if (forConstellations) {
    await store.writeWorld({ ...world, constellations: [...world.constellations, ...(created as Constellation[])] });
  } else {
    await store.writePersonaPool({ dimensions: pool.dimensions, personas: [...pool.personas, ...(created as Persona[])] });
  }
  const commitResult = await commitUseCaseWrite(store, ctx, "generate_personas", `${created.length} ${strategy}${forConstellations ? " constellations" : ""}`, [forConstellations ? WORLD_FILE : POOL_FILE]);
  return { ...base, created: created.length, ...(created.length <= WARNING_CAP ? { ids: created.map((p) => p.id) } : {}), ...commitFields(commitResult) };
}

// ---------------------------------------------------------------------------
// suggest_use_case_variants
// ---------------------------------------------------------------------------

export type SuggestVariantsInput = { id: string; limit?: number };

async function suggestVariantsInner(store: Store, input: SuggestVariantsInput): Promise<Record<string, unknown>> {
  const useCase = await loadUseCase(store, input.id);
  const pool = await store.readPersonaPool();
  const world = await store.readWorld();
  const { coverage, suggestions } = suggestVariantGaps(useCase, pool.dimensions, pool.personas, world.constellations);
  const limit = input.limit ?? 20;
  return {
    coverage,
    suggestions: suggestions.slice(0, limit),
    ...(suggestions.length > limit ? { suggestion_count: suggestions.length } : {}),
    ...(coverage.length === 0 && (pool.dimensions.length === 0 || pool.personas.length === 0) ? { hint: "define dimensions and personas first (set_use_cases), traits drive the suggestions" } : {}),
  };
}

// ---------------------------------------------------------------------------
// delete_entity — use-case kinds
// ---------------------------------------------------------------------------

export const USE_CASE_ENTITY_KINDS = ["persona", "data_object", "use_case", "dimension", "entity", "constellation", "relationship_type"] as const;
export type UseCaseEntityKind = (typeof USE_CASE_ENTITY_KINDS)[number];

export function isUseCaseEntityKind(kind: string): kind is UseCaseEntityKind {
  return (USE_CASE_ENTITY_KINDS as readonly string[]).includes(kind);
}

const EXAMPLE_IDS = 5;

function dangling(kind: string, name: string, referrers: string[], by: string): Warning[] {
  if (referrers.length === 0) return [];
  const shown = referrers.slice(0, EXAMPLE_IDS).join(", ");
  const more = referrers.length > EXAMPLE_IDS ? `, +${referrers.length - EXAMPLE_IDS} more` : "";
  return [{ kind: "dangling_reference", target: `${kind}:${name}`, message: `${kind} "${name}" is still referenced by ${referrers.length} ${by}: ${shown}${more}` }];
}

/** A constellation names a participant when it is an end of one of its relationships. */
function namesParticipant(constellation: World["constellations"][number], id: string): boolean {
  return constellation.relationships.some((r) => r.from === id || r.to === id);
}

async function deleteUseCaseEntityInner(store: Store, kind: UseCaseEntityKind, name: string, ctx: ToolHandlerContext | undefined): Promise<Record<string, unknown>> {
  const notFound = (): ToolError => new ToolError("not_found", `${kind.replace("_", " ")} "${name}" was not found`);
  let path: string;
  let warnings: Warning[] = [];

  if (kind === "use_case") {
    path = caseFile(name);
    if (!isValidId(name) || !(await store.listUseCaseIds()).includes(name)) throw notFound();
    await store.deleteUseCase(name);
  } else if (kind === "entity" || kind === "constellation" || kind === "relationship_type") {
    path = WORLD_FILE;
    const world = await store.readWorld();
    if (kind === "entity") {
      if (!world.entities.some((e) => e.id === name)) throw notFound();
      const [pool, { useCases }] = await Promise.all([store.readPersonaPool(), store.readUseCases()]);
      const entitiesAfter = world.entities.filter((e) => e.id !== name);
      // A persona with the same id still resolves the reference: nothing dangles then.
      const stillResolves = resolveParticipant(name, pool.personas, entitiesAfter) !== undefined;
      if (!stillResolves) {
        warnings = [
          ...dangling("entity", name, world.constellations.filter((c) => namesParticipant(c, name)).map((c) => c.id), "constellation(s)"),
          ...dangling("entity", name, useCases.filter((u) => stateSubjectsOf(u).has(name)).map((u) => u.id), "use case(s) as a state, condition or trigger subject"),
        ];
      }
      await store.writeWorld({ ...world, entities: entitiesAfter });
    } else if (kind === "constellation") {
      if (!world.constellations.some((c) => c.id === name)) throw notFound();
      const { useCases } = await store.readUseCases();
      const referrers = useCases.flatMap((u) => [
        ...(u.constellations.includes(name) ? [u.id] : []),
        ...(u.variants ?? []).filter((v) => v.constellations?.includes(name)).map((v) => `${u.id}#${v.id}`),
      ]);
      warnings = dangling("constellation", name, referrers, "use case(s) or variant(s)");
      await store.writeWorld({ ...world, constellations: world.constellations.filter((c) => c.id !== name) });
    } else {
      if (!world.relationship_types.some((t) => t.id === name)) throw notFound();
      warnings = dangling("relationship_type", name, world.constellations.filter((c) => c.relationships.some((r) => r.type === name)).map((c) => c.id), "constellation(s)");
      await store.writeWorld({ ...world, relationship_types: world.relationship_types.filter((t) => t.id !== name) });
    }
  } else if (kind === "persona" || kind === "dimension") {
    path = POOL_FILE;
    const pool = await store.readPersonaPool();
    const list: { id: string }[] = kind === "persona" ? pool.personas : pool.dimensions;
    if (!list.some((item) => item.id === name)) throw notFound();
    const { useCases } = await store.readUseCases();
    const world = await store.readWorld();
    if (kind === "persona") {
      const personasAfter = pool.personas.filter((p) => p.id !== name);
      // An entity with the same id still resolves the constellation references: nothing dangles there then.
      const stillResolves = resolveParticipant(name, personasAfter, world.entities) !== undefined;
      warnings = [
        ...dangling("persona", name, useCases.filter((u) => personasOf(u).has(name)).map((u) => u.id), "use case(s)"),
        ...(stillResolves ? [] : dangling("persona", name, useCases.filter((u) => stateSubjectsOf(u).has(name)).map((u) => u.id), "use case(s) as a state, condition or trigger subject")),
        ...(stillResolves ? [] : dangling("persona", name, world.constellations.filter((c) => namesParticipant(c, name)).map((c) => c.id), "constellation(s)")),
      ];
      await store.writePersonaPool({ dimensions: pool.dimensions, personas: personasAfter });
    } else {
      warnings = [
        ...dangling("dimension", name, pool.personas.filter((p) => ownValue(p.traits, name) !== undefined).map((p) => p.id), "persona(s)"),
        ...dangling("dimension", name, useCases.filter((u) => u.variants?.some((v) => ownValue(v.when, name) !== undefined)).map((u) => u.id), "use case(s) via variant conditions"),
        ...dangling("dimension", name, world.entities.filter((e) => ownValue(e.traits, name) !== undefined).map((e) => e.id), "entity(ies)"),
        ...dangling("dimension", name, world.constellations.filter((c) => ownValue(c.traits, name) !== undefined).map((c) => c.id), "constellation(s)"),
        ...dangling("dimension", name, world.relationship_types.filter((t) => t.same_traits?.includes(name)).map((t) => t.id), "relationship type(s) via same_traits"),
      ];
      await store.writePersonaPool({ dimensions: pool.dimensions.filter((d) => d.id !== name), personas: pool.personas });
    }
  } else {
    path = OBJECTS_FILE;
    const objects = await store.readDataObjects();
    if (!objects.some((o) => o.id === name)) throw notFound();
    const { useCases } = await store.readUseCases();
    const world = await store.readWorld();
    warnings = [
      ...dangling("data_object", name, useCases.filter((u) => objectIdsOf(u).has(name)).map((u) => u.id), "use case(s)"),
      ...dangling("data_object", name, objects.filter((o) => o.id !== name && o.fields.some((f) => f.ref === name)).map((o) => o.id), "data object(s) via a ref field"),
      ...dangling("data_object", name, world.entities.filter((e) => e.object === name).map((e) => e.id), "entity(ies)"),
      ...dangling("data_object", name, world.relationship_types.filter((t) => t.field?.object === name).map((t) => t.id), "relationship type(s) via field"),
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
