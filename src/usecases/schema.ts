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

const dimensionValueSchema = z.strictObject({ id: idSchema, label: z.string() });

export const dimensionSchema = z.strictObject({
  id: idSchema,
  label: z.string(),
  description: z.string().optional(),
  values: z.array(dimensionValueSchema).min(1).superRefine((values, ctx) => uniqueIds(values, ctx, "value")),
});

export const personaSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  role: z.string().optional(),
  description: z.string().optional(),
  avatar: z.strictObject({ emoji: z.string().optional(), color: z.string().optional() }).optional(),
  traits: z.record(z.string(), z.string()).default({}),
  goals: z.array(z.string()).optional(),
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

const example = z.record(z.string(), z.unknown());

const inputSchema = z.strictObject({ object: z.string(), source: z.string().optional(), example });
const outputSchema = z.strictObject({ object: z.string(), target: z.string().optional(), example });

const stepSchema = z.strictObject({
  id: idSchema,
  actor: z.string(),
  action: z.string(),
  target: z.strictObject({ screen: z.string(), node: z.string().optional() }).optional(),
  data: z.array(z.strictObject({ object: z.string(), before: example.optional(), after: example.optional() })).optional(),
  note: z.string().optional(),
});

const stepOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("replace"), step_id: z.string(), step: stepSchema }),
  z.strictObject({ op: z.literal("insert_after"), step_id: z.string(), step: stepSchema }),
  z.strictObject({ op: z.literal("remove"), step_id: z.string() }),
  z.strictObject({ op: z.literal("append"), step: stepSchema }),
]);

const variantSchema = z.strictObject({
  id: idSchema,
  title: z.string(),
  description: z.string().optional(),
  when: z.record(z.string(), z.array(z.string()).min(1)),
  personas: z.array(z.string()).optional(),
  trigger: z.string().optional(),
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
  trigger: z.string().optional(),
  goal: z.string().optional(),
  outcome: z.string().optional(),
  inputs: z.array(inputSchema).min(1),
  outputs: z.array(outputSchema).min(1),
  steps: z.array(stepSchema).default([]).superRefine((steps, ctx) => uniqueIds(steps, ctx, "step")),
  variants: z.array(variantSchema).optional().superRefine((variants, ctx) => uniqueIds(variants ?? [], ctx, "variant")),
});

// --- File documents -----------------------------------------------------------

export const personaPoolSchema = z.strictObject({
  dimensions: z.array(dimensionSchema).default([]).superRefine((items, ctx) => uniqueIds(items, ctx, "dimension")),
  personas: z.array(personaSchema).default([]).superRefine((items, ctx) => uniqueIds(items, ctx, "persona")),
});

export const dataObjectsDocSchema = z.strictObject({
  objects: z.array(dataObjectSchema).default([]).superRefine((items, ctx) => uniqueIds(items, ctx, "data object")),
});

// --- Types --------------------------------------------------------------------

export type Dimension = z.infer<typeof dimensionSchema>;
export type Persona = z.infer<typeof personaSchema>;
export type DataField = z.infer<typeof dataFieldSchema>;
export type DataObject = z.infer<typeof dataObjectSchema>;
export type UseCaseInput = z.infer<typeof inputSchema>;
export type UseCaseOutput = z.infer<typeof outputSchema>;
export type UseCaseStep = z.infer<typeof stepSchema>;
export type StepOp = z.infer<typeof stepOpSchema>;
export type UseCaseVariant = z.infer<typeof variantSchema>;
export type UseCase = z.infer<typeof useCaseSchema>;
export type PersonaPool = { dimensions: Dimension[]; personas: Persona[] };

/** `path: message` lines for a zod failure — what a caller needs to fix their input. */
export function describeIssues(error: z.ZodError, prefix = ""): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${prefix}${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}
