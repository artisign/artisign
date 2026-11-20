import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import type { z } from "zod";
import { conditionSchema, constellationSchema, dataObjectSchema, dimensionSchema, entitySchema, personaSchema, relationshipTypeSchema, stateEntrySchema, triggerObjectSchema, useCaseSchema, variantStateEntrySchema } from "./schema.js";

// Pins the "Key reference" block of the Use cases section of docs/agent-guide.md (```shapes fence) against the strict schemas.
const GUIDE_URL = new URL("../../docs/agent-guide.md", import.meta.url);

type Def = { type: string; innerType?: Def; element?: Def; in?: Def; shape?: Record<string, Def>; options?: Def[] };

/** Strips optional/default/pipe wrappers and arrays down to the object (or union) schema. */
function core(schema: unknown): z.ZodType {
  let node = schema as { _zod: { def: Def } };
  for (;;) {
    const def = node._zod.def;
    const next = def.innerType ?? def.element ?? (def.type === "pipe" ? def.in : undefined);
    if (!next) return node as unknown as z.ZodType;
    node = next as never;
  }
}

function shapeOf(schema: unknown): Record<string, z.ZodType> {
  return (core(schema) as unknown as { shape: Record<string, z.ZodType> }).shape;
}
const sub = (schema: unknown, ...path: string[]): z.ZodType => path.reduce<unknown>((s, key) => shapeOf(s)[key]!, schema) as z.ZodType;

const useCaseShape = shapeOf(useCaseSchema);
const stepSchema = useCaseShape.steps!;
const variantSchema = useCaseShape.variants!;
const branchSchema = useCaseShape.branches!;
const ops = (core(sub(variantSchema, "steps")) as unknown as { options: z.ZodType[] }).options;
const op = (name: string): z.ZodType => ops.find((o) => (shapeOf(o).op! as unknown as { _zod: { def: { values: string[] } } })._zod.def.values[0] === name)!;

/** entity name in the guide -> schema; `valueRequired` marks `value`, whose requiredness is a refinement, not the shape. */
const ENTITIES: Record<string, { schema: z.ZodType; valueRequired?: boolean }> = {
  dimension: { schema: dimensionSchema },
  "dimension.values[]": { schema: sub(dimensionSchema, "values") },
  persona: { schema: personaSchema },
  avatar: { schema: sub(personaSchema, "avatar") },
  entity: { schema: entitySchema },
  relationship_type: { schema: relationshipTypeSchema },
  "relationship_type.field": { schema: sub(relationshipTypeSchema, "field") },
  constellation: { schema: constellationSchema },
  "constellation.relationships[]": { schema: sub(constellationSchema, "relationships") },
  data_object: { schema: dataObjectSchema },
  "data_object.fields[]": { schema: sub(dataObjectSchema, "fields") },
  use_case: { schema: useCaseSchema },
  "trigger (object form)": { schema: triggerObjectSchema },
  "state[] (use case)": { schema: stateEntrySchema, valueRequired: true },
  "condition (trigger state, branch when)": { schema: conditionSchema, valueRequired: true },
  input: { schema: sub(useCaseSchema, "inputs") },
  output: { schema: sub(useCaseSchema, "outputs") },
  step: { schema: stepSchema },
  "step.target": { schema: sub(stepSchema, "target") },
  "step.data[]": { schema: sub(stepSchema, "data") },
  branch: { schema: branchSchema },
  variant: { schema: variantSchema },
  "variant.state[]": { schema: variantStateEntrySchema },
  "step_op replace": { schema: op("replace") },
  "step_op insert_after": { schema: op("insert_after") },
  "step_op remove": { schema: op("remove") },
  "step_op append": { schema: op("append") },
  "step_op add_branch": { schema: op("add_branch") },
  "step_op replace_branch": { schema: op("replace_branch") },
  "step_op remove_branch": { schema: op("remove_branch") },
};

async function guideShapes(): Promise<Map<string, { req: string[]; opt: string[] }>> {
  const guide = await readFile(GUIDE_URL, "utf-8");
  const fence = /```shapes\n([\s\S]*?)```/.exec(guide);
  if (!fence) throw new Error("agent-guide.md has no ```shapes block");
  const out = new Map<string, { req: string[]; opt: string[] }>();
  for (const line of fence[1]!.split("\n").filter((l) => l.trim())) {
    const match = /^(.+?): ([^|]*)\|(.*)$/.exec(line) ?? /^(.+?):()\s*\|(.*)$/.exec(line);
    if (!match) throw new Error(`unparsable shapes line: ${line}`);
    expect(out.has(match[1]!), `duplicate shapes entry ${match[1]!}`).toBe(false);
    out.set(match[1]!, { req: match[2]!.split(/\s+/).filter(Boolean), opt: match[3]!.split(/\s+/).filter(Boolean) });
  }
  return out;
}

describe("agent guide key reference vs. strict use-case schemas", () => {
  it("documents exactly the entities the test knows (no unmapped line, none missing)", async () => {
    expect([...(await guideShapes()).keys()].sort()).toEqual(Object.keys(ENTITIES).sort());
  });

  for (const [name, { schema, valueRequired }] of Object.entries(ENTITIES)) {
    it(`${name}: accepted keys and required/optional match the schema`, async () => {
      const documented = (await guideShapes()).get(name)!;
      const shape = shapeOf(schema);
      const required = Object.keys(shape).filter((key) => !(shape[key]! as unknown as { isOptional(): boolean }).isOptional() || (valueRequired && key === "value"));
      const optional = Object.keys(shape).filter((key) => !required.includes(key));
      expect(documented.req.sort(), `${name} required keys`).toEqual(required.sort());
      expect(documented.opt.sort(), `${name} optional keys`).toEqual(optional.sort());
    });
  }
});
