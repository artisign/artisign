import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../mcp/server.js";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";

// CHR-1168: the advertised `set_use_cases` input schema (tools/list) is derived from the strict schemas in
// src/usecases/schema.ts. Runtime validation stays the tool's own, so a wrong write is `validation_failed` with path and rule.

type Json = { type?: string; description?: string; properties?: Record<string, Json>; required?: string[]; items?: Json; anyOf?: Json[]; oneOf?: Json[]; const?: unknown; enum?: unknown[] };

const GUIDE_URL = new URL("../../docs/agent-guide.md", import.meta.url);

let fx: ProjectFixture;
let client: Client;

beforeEach(async () => {
  fx = await setupProject();
  const server = createMcpServer(fx.store);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.1.0" });
  await Promise.all([client.connect(a), server.connect(b)]);
});
afterEach(async () => {
  await client.close();
  await fx.cleanup();
});

async function advertised(): Promise<Record<string, Json>> {
  const { tools } = await client.listTools();
  return (tools.find((t) => t.name === "set_use_cases")!.inputSchema as unknown as Json).properties!;
}

/** The object schema of a node: arrays and optional wrappers resolved to their item, a union to its (single) object branch. */
function objectOf(node: Json): Json {
  if (node.items) return objectOf(node.items);
  if (node.anyOf) return objectOf(node.anyOf.find((b) => b.type === "object" || b.items || b.anyOf)!);
  return node;
}
const at = (root: Json, ...path: string[]): Json => path.reduce((n, key) => objectOf(n).properties![key]!, root);
/** The array schema behind a nullable wrapper. */
const unwrap = (node: Json): Json => (node.anyOf ? unwrap(node.anyOf.find((b) => b.type !== "null")!) : node);
const op = (variant: Json, name: string): Json => {
  const element = unwrap(at(variant, "steps").items ? at(variant, "steps") : unwrap(variant.properties ? variant : objectOf(variant)).properties!.steps!).items!;
  return (element.oneOf ?? element.anyOf)!.find((o) => o.properties!.op!.const === name)!;
};

describe("set_use_cases advertised input schema", () => {
  it("lists all seven pools as typed arrays, not open records", async () => {
    const props = await advertised();
    expect(Object.keys(props).sort()).toEqual(["constellations", "data_objects", "dimensions", "entities", "personas", "relationship_types", "use_cases"]);
    for (const [name, pool] of Object.entries(props)) {
      expect(pool.type, name).toBe("array");
      expect(objectOf(pool).properties, `${name} keys`).toBeDefined();
      expect(objectOf(pool).required, `${name} required`).toContain("id");
    }
  });

  it("pins the guide's key reference (```shapes) against the advertised schema", async () => {
    const props = await advertised();
    const useCase = props.use_cases!;
    const variant = at(useCase, "variants");
    const step = at(useCase, "steps");
    const tracked: Record<string, Json> = {
      dimension: props.dimensions!,
      "dimension.values[]": at(props.dimensions!, "values"),
      persona: props.personas!,
      avatar: at(props.personas!, "avatar"),
      entity: props.entities!,
      relationship_type: props.relationship_types!,
      "relationship_type.field": at(props.relationship_types!, "field"),
      constellation: props.constellations!,
      "constellation.relationships[]": at(props.constellations!, "relationships"),
      data_object: props.data_objects!,
      "data_object.fields[]": at(props.data_objects!, "fields"),
      use_case: useCase,
      "trigger (object form)": at(useCase, "trigger"),
      "state[] (use case)": at(useCase, "state"),
      "condition (trigger state, branch when)": at(at(useCase, "trigger"), "state"),
      input: at(useCase, "inputs"),
      output: at(useCase, "outputs"),
      step,
      "step.target": at(step, "target"),
      "step.data[]": at(step, "data"),
      branch: at(useCase, "branches"),
      variant,
      "variant.state[]": at(variant, "state"),
      "step_op replace": op(variant, "replace"),
      "step_op insert_after": op(variant, "insert_after"),
      "step_op remove": op(variant, "remove"),
      "step_op append": op(variant, "append"),
      "step_op add_branch": op(variant, "add_branch"),
      "step_op replace_branch": op(variant, "replace_branch"),
      "step_op remove_branch": op(variant, "remove_branch"),
    };

    const guide = await readFile(GUIDE_URL, "utf-8");
    const fence = /```shapes\n([\s\S]*?)```/.exec(guide);
    if (!fence) throw new Error("agent-guide.md has no ```shapes block");
    const documented = new Map<string, { req: string[]; opt: string[] }>();
    for (const line of fence[1]!.split("\n").filter((l) => l.trim())) {
      const match = /^(.+?): ([^|]*)\|(.*)$/.exec(line) ?? /^(.+?):()\s*\|(.*)$/.exec(line);
      if (!match) throw new Error(`unparsable shapes line: ${line}`);
      documented.set(match[1]!, { req: match[2]!.split(/\s+/).filter(Boolean), opt: match[3]!.split(/\s+/).filter(Boolean) });
    }
    expect([...documented.keys()].sort()).toEqual(Object.keys(tracked).sort());

    for (const [name, node] of Object.entries(tracked)) {
      const obj = objectOf(node);
      const keys = Object.keys(obj.properties!);
      // Top level of a pool: the create-required keys are stated in the item description (merge upsert: only `id` is schema-required).
      const created = /requires: (.+)$/.exec(obj.description ?? "");
      const required = (created ? created[1]!.split(", ") : (obj.required ?? [])).filter((k) => keys.includes(k));
      const optional = keys.filter((k) => !required.includes(k));
      const doc = documented.get(name)!;
      expect([...doc.req].sort(), `${name} required keys`).toEqual([...required].sort());
      expect([...doc.opt].sort(), `${name} optional keys`).toEqual([...optional].sort());
    }
  });

  it("builds a dimension only from tools/list and writes it without validation_failed", async () => {
    const dimension = objectOf((await advertised()).dimensions!);
    dimension.required = (/requires: (.+)$/.exec(dimension.description!)![1]!).split(", ");
    const value = objectOf(dimension.properties!.values!);
    const build = (schema: Json): Record<string, unknown> =>
      Object.fromEntries((schema.required ?? []).map((key) => [key, sampleOf(schema.properties![key]!, key)]));
    function sampleOf(node: Json, key: string): unknown {
      if (node.type === "array") return [build(objectOf(node))];
      return `${key}-sample`.replace(/_/g, "-");
    }
    const entry = build(dimension);
    expect(Object.keys(entry).sort()).toEqual(["id", "name", "values"]);
    expect(Object.keys((entry.values as Record<string, unknown>[])[0]!).sort()).toEqual([...(value.required ?? [])].sort());

    const result = await client.callTool({ name: "set_use_cases", arguments: { dimensions: [entry] } });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  });

  it("still answers a wrong write with the tool's validation_failed (path and rule), not an SDK input error", async () => {
    const result = await client.callTool({
      name: "set_use_cases",
      arguments: { dimensions: [{ id: "plan", label: "Plan", values: ["free", "paid"] }] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain("validation_failed");
    expect(text).toMatch(/dimensions\[0\]|dimensions\.0|plan/);
    expect(text).not.toMatch(/Invalid arguments|Input validation error/i);
  });

  it("advertises a merge upsert: only id required on top, others optional and nullable unless the create schema requires them", async () => {
    const props = await advertised();
    const dimension = objectOf(props.dimensions!);
    expect(dimension.required).toEqual(["id"]);
    expect(dimension.description).toBe("merge by id; a new dimension requires: id, name, values");
    expect(dimension.properties!.name!.anyOf).toBeUndefined();
    expect(dimension.properties!.description!.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
    expect(objectOf(props.use_cases!).description).toMatch(/^merge by id; a new use case requires: id, title, inputs, outputs$/);
    expect((dimension as unknown as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });

  it("accepts a partial update and a null removal, on the server and as advertised", async () => {
    const dimension = objectOf((await advertised()).dimensions!);
    const create = { id: "plan", name: "Plan", description: "Billing plan", values: [{ id: "free", label: "Free" }] };
    expect((await client.callTool({ name: "set_use_cases", arguments: { dimensions: [create] } })).isError).not.toBe(true);

    const partial = { id: "plan", name: "Plan tier" };
    const removal = { id: "plan", description: null };
    for (const entry of [partial, removal]) {
      for (const key of Object.keys(entry)) expect(Object.keys(dimension.properties!), key).toContain(key);
      expect(dimension.required!.every((k) => k in entry), "advertised required keys").toBe(true);
      const result = await client.callTool({ name: "set_use_cases", arguments: { dimensions: [entry] } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    }
    expect(dimension.properties!.description!.anyOf!.some((b) => b.type === "null")).toBe(true);
  });

  it("requires `value` on state entries and conditions (use case state, trigger state, branch when) but not on variant state", async () => {
    const useCase = (await advertised()).use_cases!;
    expect(objectOf(at(useCase, "state")).required).toContain("value");
    expect(objectOf(at(at(useCase, "trigger"), "state")).required).toContain("value");
    expect(objectOf(at(useCase, "branches", "when")).required).toContain("value");
    expect(objectOf(at(useCase, "variants", "state")).required).not.toContain("value");
  });

  it("is self-contained: no $ref, definitions or $defs, no nested $schema", async () => {
    const text = JSON.stringify(await advertised());
    expect(text).not.toMatch(/\$ref|"definitions"|\$defs|\$schema/);
  });
});
