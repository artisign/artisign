import { describe, it, expect } from "vitest";
import { buildPools, useCaseSchema, validateUseCase, type DataObject, type UseCase } from "./index.js";

const book: DataObject = {
  id: "book",
  name: "Book",
  fields: [
    { name: "title", type: "string" },
    { name: "pages", type: "number" },
    { name: "borrowed", type: "boolean" },
    { name: "published", type: "date" },
    { name: "added", type: "datetime" },
    { name: "tags", type: "list" },
    { name: "meta", type: "object" },
    { name: "loan", type: "ref", ref: "loan" },
  ],
};
const loan: DataObject = {
  id: "loan",
  name: "Loan",
  fields: [
    { name: "status", type: "enum", values: ["active", "returned"] },
    { name: "kind", type: "enum" },
  ],
};
const world = { entities: [], relationship_types: [], constellations: [] };
const pools = (dataModel = true) => buildPools([], [], [book, loan], world, dataModel);

function useCase(overrides: Record<string, unknown> = {}): UseCase {
  return useCaseSchema.parse({
    id: "borrow-a-book",
    title: "Borrow a book",
    inputs: [{ object: "book", example: { title: "Dune" } }],
    outputs: [{ object: "loan", example: { status: "active" } }],
    ...overrides,
  });
}

const invalid = async (c: UseCase, p = pools()) => (await validateUseCase(c, p)).filter((w) => w.kind === "invalid_example_value");

describe("invalid_example_value", () => {
  it("is quiet for values that fit every field type", async () => {
    const c = useCase({
      inputs: [{ object: "book", example: { title: "Dune", pages: 412, borrowed: false, published: "1965-08-01", added: "2026-12-01T09:30:00Z", tags: ["scifi"], meta: { a: 1 }, loan: "loan-1" } }],
      outputs: [{ object: "loan", example: { status: "returned", kind: "anything", } }],
    });
    expect(await validateUseCase(c, pools())).toEqual([]);
  });

  it("lets null through: nothing there yet", async () => {
    expect(await invalid(useCase({ inputs: [{ object: "book", example: { title: null, pages: null } }] }))).toEqual([]);
  });

  it("reproduces the ticket: a value outside an enum and a number for a string", async () => {
    const w = await invalid(useCase({ inputs: [{ object: "book", example: { title: 5 } }], outputs: [{ object: "loan", example: { status: "lost" } }] }));
    expect(w.map((x) => [x.target, x.message])).toEqual([
      ["use_case:borrow-a-book", "book.title: expected string, got number"],
      ["use_case:borrow-a-book", '"lost" is not a value of enum loan.status (active, returned)'],
    ]);
  });

  it("names the expected type for each field type", async () => {
    const w = await invalid(
      useCase({
        inputs: [{ object: "book", example: { pages: "412", borrowed: "no", published: "tomorrow", added: "2026-02-31T10:00:00Z", tags: "scifi", meta: [1], loan: 7 } }],
      }),
    );
    expect(w.map((x) => x.message)).toEqual([
      'book.pages: expected number, got string',
      "book.borrowed: expected boolean, got string",
      'book.published: expected a date (YYYY-MM-DD), got "tomorrow"',
      'book.added: expected a datetime (e.g. 2026-12-01T09:30:00Z), got "2026-02-31T10:00:00Z"',
      "book.tags: expected list, got string",
      "book.meta: expected object, got list",
      "book.loan: expected a ref (id string), got number",
    ]);
  });

  it("rejects a non-string for an enum without declared values", async () => {
    const w = await invalid(useCase({ outputs: [{ object: "loan", example: { kind: 3 } }] }));
    expect(w.map((x) => x.message)).toEqual(["loan.kind: expected an enum value (string), got number"]);
  });

  it("checks step data before and after and the variant's inputs, and reports an undeclared key as unknown_data_field only", async () => {
    const c = useCase({
      steps: [{ id: "s", actor: "system", action: "x", data: [{ object: "loan", before: { status: "lost" }, after: { colour: "red" } }] }],
      variants: [{ id: "v", title: "V", when: { a: ["b"] }, inputs: [{ object: "book", example: { pages: "x" } }] }],
    });
    const all = await validateUseCase(c, pools());
    expect(all.filter((w) => w.kind === "invalid_example_value").map((w) => [w.target, w.message])).toEqual([
      ["use_case:borrow-a-book/s", '"lost" is not a value of enum loan.status (active, returned)'],
      ["use_case:borrow-a-book#v", "book.pages: expected number, got string"],
    ]);
    expect(all.filter((w) => w.kind === "unknown_data_field")).toHaveLength(1);
  });

  it("is off without a data model, like every data-object check", async () => {
    expect(await validateUseCase(useCase({ inputs: [{ object: "book", example: { title: 5 } }] }), pools(false))).toEqual([]);
  });
});
