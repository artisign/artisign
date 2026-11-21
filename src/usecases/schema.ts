import { z } from "zod";

/** Ids are author-chosen, stable, lowercase kebab-case — a use case id is also its filename. */
export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ID_MAX = 80;

/** A file under usecases/ that does not validate; `file` is project-relative. Tools map it to `invalid_state`. */
export class InvalidFileError extends Error {
  readonly file: string;

  constructor(file: string, detail: string) {
    super(`invalid ${file}: ${detail}`);
    this.file = file;
  }
}

/** `object[key]` only when it is an own property — ids such as "constructor" must not resolve to Object.prototype members. */
export function ownValue<T>(object: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

export function isValidId(id: string): boolean {
  return id.length <= ID_MAX && ID_RE.test(id);
}

const idSchema = z.string().max(ID_MAX).regex(ID_RE, "must be lowercase kebab-case (a-z, 0-9, -)");

function uniqueIds<T extends { id: string }>(items: T[], ctx: z.RefinementCtx, label: string): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: `duplicate ${label} id "${item.id}"` });
    seen.add(item.id);
  });
}

// --- Dimensions and personas --------------------------------------------------

/** The actor of a step the product itself performs. Not a persona and not an entity; never an id in either pool. */
export const SYSTEM_ACTOR = "system";

/** An id of a persona or entity: `system` is the app itself (a shape error, like the kebab-case rule). */
const participantIdSchema = idSchema.refine((id) => id !== SYSTEM_ACTOR, { message: `"${SYSTEM_ACTOR}" is reserved for the app itself` });

const dimensionValueSchema = z.strictObject({ id: idSchema, label: z.string() });

/** What generation and coverage expand a dimension for; traits of any participant may still name any dimension. */
export const DIMENSION_SCOPES = ["personas", "constellations"] as const;

export const dimensionSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  description: z.string().optional(),
  scope: z.enum(DIMENSION_SCOPES).optional(),
  values: z.array(dimensionValueSchema).min(1).superRefine((values, ctx) => uniqueIds(values, ctx, "value")),
});

const avatarSchema = z.strictObject({ emoji: z.string().optional(), color: z.string().optional() });

/** What kind of external actor a persona is. Not a dimension: it plays no part in generation or coverage. */
export const PERSONA_KINDS = ["human", "agent", "service", "organization"] as const;

export const personaSchema = z.strictObject({
  id: participantIdSchema,
  name: z.string(),
  kind: z.enum(PERSONA_KINDS).optional(),
  role: z.string().optional(),
  description: z.string().optional(),
  avatar: avatarSchema.optional(),
  traits: z.record(z.string(), z.string()).default({}),
  goals: z.array(z.string()).optional(),
  generated: z.boolean().optional(),
});

// --- World: main entities, relationship types, constellations ----------------

export const entitySchema = z.strictObject({
  id: participantIdSchema,
  name: z.string(),
  type: z.string().optional(),
  description: z.string().optional(),
  avatar: avatarSchema.optional(),
  traits: z.record(z.string(), z.string()).default({}),
  /** The data object this entity is an instance of; only checked once a data model exists. */
  object: z.string().optional(),
});

export const relationshipTypeSchema = z.strictObject({
  id: idSchema,
  label: z.string(),
  inverse_label: z.string().optional(),
  description: z.string().optional(),
  /** Dimension ids on which both ends of a relationship of this type must agree. */
  same_traits: z.array(z.string()).optional(),
  /** The `ref` (or `list`) field of a data object this relationship maps to, once a data model exists. */
  field: z.strictObject({ object: z.string(), name: z.string() }).optional(),
});

const relationshipSchema = z.strictObject({ from: z.string().min(1), type: z.string().min(1), to: z.string().min(1), note: z.string().optional() });

export const constellationSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  description: z.string().optional(),
  traits: z.record(z.string(), z.string()).default({}),
  relationships: z.array(relationshipSchema),
  generated: z.boolean().optional(),
});

// --- Data objects -------------------------------------------------------------

export const FIELD_TYPES = ["string", "number", "boolean", "date", "datetime", "enum", "ref", "list", "object"] as const;

const dataFieldSchema = z.strictObject({
  name: z.string().min(1),
  type: z.enum(FIELD_TYPES),
  description: z.string().optional(),
  values: z.array(z.string()).optional(),
  ref: z.string().optional(),
  example: z.unknown().optional(),
});

export const dataObjectSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  description: z.string().optional(),
  fields: z.array(dataFieldSchema).default([]),
});

// --- Use cases ----------------------------------------------------------------

/** A step's before/after may be empty (nothing there yet); an input/output example must show at least one field. */
const stepExample = z.record(z.string(), z.unknown());
const example = stepExample.refine((value) => Object.keys(value).length > 0, { message: "example must be an object with at least one key" });

const inputSchema = z.strictObject({ object: z.string(), source: z.string().optional(), example });
const outputSchema = z.strictObject({ object: z.string(), target: z.string().optional(), example });

// --- Property states, conditions and triggers ----------------------------------

/** Comparison operators of a condition; `eq` is the default. Never evaluated by Artisign. */
export const CONDITION_OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "in"] as const;

const stateKey = { subject: z.string().min(1), property: z.string().min(1) };

/** `value` is any JSON value, so its mere presence is the rule (`z.unknown()` alone would also accept a missing key). */
function requireValue(entry: { value?: unknown }, ctx: z.RefinementCtx): void {
  if (!Object.hasOwn(entry, "value")) ctx.addIssue({ code: "custom", path: ["value"], message: "value is required" });
}

/** One state entry per (subject, property): the merge key must be unambiguous. */
function uniqueStateKeys(entries: { subject: string; property: string }[] | undefined, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  (entries ?? []).forEach((entry, index) => {
    const key = JSON.stringify([entry.subject, entry.property]);
    if (seen.has(key)) ctx.addIssue({ code: "custom", path: [index], message: `duplicate state entry "${entry.subject}.${entry.property}"` });
    seen.add(key);
  });
}

/** An entry of the starting state: no `op` (conditions only). */
export const stateEntrySchema = z.strictObject({ ...stateKey, value: z.unknown() }).superRefine(requireValue);

/** A condition (branch `when`, state trigger): a state entry with an optional operator; `in` needs an array. */
export const conditionSchema = z
  .strictObject({ ...stateKey, op: z.enum(CONDITION_OPS).optional(), value: z.unknown() })
  .superRefine((condition, ctx) => {
    requireValue(condition, ctx);
    if (condition.op === "in" && !Array.isArray(condition.value)) ctx.addIssue({ code: "custom", path: ["value"], message: '"in" needs an array value' });
  });

/** A variant `state` entry: replaces or adds one by (subject, property), or `unset: true` (no `value`) removes the base entry. */
export const variantStateEntrySchema = z.strictObject({ ...stateKey, value: z.unknown().optional(), unset: z.literal(true).optional() }).superRefine((entry, ctx) => {
  if (entry.unset === true && Object.hasOwn(entry, "value")) ctx.addIssue({ code: "custom", path: ["value"], message: "an unset entry has no value" });
  if (entry.unset !== true) requireValue(entry, ctx);
});

const ISO_AT = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/;

/** An ISO date or datetime, calendar-checked (no 2026-02-31). */
function isIsoAt(value: string): boolean {
  const match = ISO_AT.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

export const triggerObjectSchema = z
  .strictObject({
    text: z.string(),
    actor: idSchema.optional(),
    via: z.string().optional(),
    state: z.array(conditionSchema).min(1).optional(),
    at: z.string().refine(isIsoAt, { message: "at must be an ISO date (2026-12-01) or datetime (2026-12-01T09:30:00Z)" }).optional(),
  })
  .superRefine((trigger, ctx) => {
    if (trigger.actor === SYSTEM_ACTOR) ctx.addIssue({ code: "custom", path: ["actor"], message: `a trigger actor is a persona, never "${SYSTEM_ACTOR}"` });
    if (trigger.actor !== undefined && (trigger.state !== undefined || trigger.at !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["actor"], message: "actor cannot be combined with state or at: an action trigger and a state trigger are different forms" });
    }
    if (trigger.via !== undefined && trigger.actor === undefined) ctx.addIssue({ code: "custom", path: ["via"], message: "via needs an actor" });
  });

/** Stored as a string (text only) or an object; reads always return the object. */
export const triggerSchema = z.union([z.string(), triggerObjectSchema]);

const stepSchema = z.strictObject({
  id: idSchema,
  actor: z.string(),
  action: z.string(),
  target: z.strictObject({ screen: z.string(), node: z.string().optional() }).optional(),
  data: z.array(z.strictObject({ object: z.string(), before: stepExample.optional(), after: stepExample.optional() })).optional(),
  note: z.string().optional(),
  /** How the step is triggered when it is not a person's action: free display text ("webhook", "email"); nothing resolves it. */
  via: z.string().optional(),
});

/**
 * An alternative or exception path of a case: forks after the main-flow step `from` (none = before the first step), holds while
 * every condition of `when` does, runs `steps`, and either continues at the main-flow step `rejoin` or ends with `outcome`.
 * Never evaluated by Artisign. Step ids share one namespace with the main flow.
 */
export const branchSchema = z
  .strictObject({
    id: idSchema,
    title: z.string(),
    from: z.string().optional(),
    when: z.array(conditionSchema).min(1),
    steps: z.array(stepSchema).min(1).superRefine((steps, ctx) => uniqueIds(steps, ctx, "step")),
    rejoin: z.string().optional(),
    outcome: z.string().optional(),
  });

const stepOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("replace"), step_id: z.string(), step: stepSchema }),
  z.strictObject({ op: z.literal("insert_after"), step_id: z.string(), step: stepSchema }),
  z.strictObject({ op: z.literal("remove"), step_id: z.string() }),
  z.strictObject({ op: z.literal("append"), step: stepSchema, branch: z.string().optional() }),
  z.strictObject({ op: z.literal("add_branch"), branch: branchSchema }),
  z
    .strictObject({ op: z.literal("replace_branch"), branch_id: z.string(), branch: branchSchema })
    .refine((op) => op.branch.id === op.branch_id, { path: ["branch", "id"], message: "replace_branch keeps the id; to rename a branch, use remove_branch and add_branch" }),
  z.strictObject({ op: z.literal("remove_branch"), branch_id: z.string() }),
]);

const variantSchema = z.strictObject({
  id: idSchema,
  title: z.string(),
  description: z.string().optional(),
  when: z.record(z.string(), z.array(z.string()).min(1)).refine((when) => Object.keys(when).length > 0, { message: "when must name at least one dimension" }),
  personas: z.array(z.string()).optional(),
  constellations: z.array(z.string()).optional(),
  /** Merged into the base `state` by (subject, property). */
  state: z.array(variantStateEntrySchema).optional().superRefine(uniqueStateKeys),
  /** Persona (or `system`) of an inherited base step → the persona it becomes in this variant. Keys and values are ids; `system` is a valid id. */
  actors: z.record(idSchema, idSchema).optional(),
  trigger: triggerSchema.optional(),
  goal: z.string().optional(),
  outcome: z.string().optional(),
  inputs: z.array(inputSchema).min(1).optional(),
  outputs: z.array(outputSchema).min(1).optional(),
  steps: z.array(stepOpSchema).optional(),
});

/** Spec maturity only. Work state and priority live in the ticket system, linked through `tags`. */
export const USE_CASE_STATUSES = ["draft", "ready"] as const;

export const useCaseSchema = z.strictObject({
  id: idSchema,
  title: z.string(),
  group: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(USE_CASE_STATUSES).default("draft"),
  personas: z.array(z.string()).default([]),
  /** The starting worlds the case holds for (a set, any of which applies). */
  constellations: z.array(z.string()).default([]),
  trigger: triggerSchema.optional(),
  goal: z.string().optional(),
  outcome: z.string().optional(),
  /** The starting state: property values at the start of the case. */
  state: z.array(stateEntrySchema).optional().superRefine(uniqueStateKeys),
  inputs: z.array(inputSchema).min(1),
  outputs: z.array(outputSchema).min(1),
  steps: z.array(stepSchema).default([]).superRefine((steps, ctx) => uniqueIds(steps, ctx, "step")),
  /** Alternative and error paths, each from a main-flow step. */
  branches: z.array(branchSchema).optional().superRefine((branches, ctx) => uniqueIds(branches ?? [], ctx, "branch")),
  variants: z.array(variantSchema).optional().superRefine((variants, ctx) => uniqueIds(variants ?? [], ctx, "variant")),
}).superRefine((useCase, ctx) => {
  // One step namespace per case: a branch step must not reuse the id of a main-flow step or of a step in another branch.
  const seen = new Set((useCase.steps ?? []).map((step) => step.id));
  (useCase.branches ?? []).forEach((branch, b) => {
    const own = new Set<string>();
    branch.steps.forEach((step, s) => {
      if (own.has(step.id)) return; // a repeat inside one branch is reported by the branch itself
      own.add(step.id);
      if (seen.has(step.id)) ctx.addIssue({ code: "custom", path: ["branches", b, "steps", s, "id"], message: `duplicate step id "${step.id}" (step ids are unique across the main flow and all branches)` });
    });
    own.forEach((id) => seen.add(id));
  });
});

// --- File documents -----------------------------------------------------------

export const personaPoolSchema = z.strictObject({
  dimensions: z.array(dimensionSchema).default([]).superRefine((items, ctx) => uniqueIds(items, ctx, "dimension")),
  personas: z.array(personaSchema).default([]).superRefine((items, ctx) => uniqueIds(items, ctx, "persona")),
});

export const worldSchema = z.strictObject({
  entities: z.array(entitySchema).default([]).superRefine((items, ctx) => uniqueIds(items, ctx, "entity")),
  relationship_types: z.array(relationshipTypeSchema).default([]).superRefine((items, ctx) => uniqueIds(items, ctx, "relationship type")),
  constellations: z.array(constellationSchema).default([]).superRefine((items, ctx) => uniqueIds(items, ctx, "constellation")),
});

export const dataObjectsDocSchema = z.strictObject({
  objects: z.array(dataObjectSchema).default([]).superRefine((items, ctx) => uniqueIds(items, ctx, "data object")),
});

// --- Types --------------------------------------------------------------------

export type Dimension = z.infer<typeof dimensionSchema>;
export type Persona = z.infer<typeof personaSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type RelationshipType = z.infer<typeof relationshipTypeSchema>;
export type Constellation = z.infer<typeof constellationSchema>;
export type World = { entities: Entity[]; relationship_types: RelationshipType[]; constellations: Constellation[] };
export type DataField = z.infer<typeof dataFieldSchema>;
export type DataObject = z.infer<typeof dataObjectSchema>;
export type UseCaseInput = z.infer<typeof inputSchema>;
export type UseCaseOutput = z.infer<typeof outputSchema>;
export type StateEntry = z.infer<typeof stateEntrySchema>;
export type Condition = z.infer<typeof conditionSchema>;
export type VariantStateEntry = z.infer<typeof variantStateEntrySchema>;
export type TriggerObject = z.infer<typeof triggerObjectSchema>;
export type Trigger = z.infer<typeof triggerSchema>;
export type UseCaseStep = z.infer<typeof stepSchema>;
export type UseCaseBranch = z.infer<typeof branchSchema>;
export type StepOp = z.infer<typeof stepOpSchema>;
export type UseCaseVariant = z.infer<typeof variantSchema>;
export type UseCase = z.infer<typeof useCaseSchema>;
export type PersonaPool = { dimensions: Dimension[]; personas: Persona[] };

/** The object form of a trigger: a string is text only. Reads always return this. */
export function normalizeTrigger(trigger: Trigger): TriggerObject {
  return typeof trigger === "string" ? { text: trigger } : trigger;
}

/** `path: message` lines for a zod failure — what a caller needs to fix their input. */
export function describeIssues(error: z.ZodError, prefix = ""): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${prefix}${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}
