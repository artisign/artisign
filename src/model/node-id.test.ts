import { describe, it, expect } from "vitest";
import { isGeneratedId, NodeIdAllocator } from "./node-id.js";

describe("isGeneratedId", () => {
  it("accepts n<digits> element ids", () => {
    for (const id of ["n1", "n42", "n1000"]) expect(isGeneratedId(id)).toBe(true);
  });

  it("accepts generated text ids under a generated parent", () => {
    for (const id of ["n3t", "n3t2", "n12t10"]) expect(isGeneratedId(id)).toBe(true);
  });

  it("agrees with what the allocator generates", () => {
    const allocator = new NodeIdAllocator();
    const el = allocator.allocateElementId();
    expect(isGeneratedId(el)).toBe(true);
    expect(isGeneratedId(allocator.allocateTextId(el))).toBe(true);
    expect(isGeneratedId(allocator.allocateTextId(el))).toBe(true);
  });

  it("rejects authored ids, including ones that merely start with n", () => {
    for (const id of ["hero", "nav", "n", "n1a", "n-1", "nt", "content", "card-list", "n1t2x"]) {
      expect(isGeneratedId(id)).toBe(false);
    }
  });

  it("counts an authored id that is literally n<digits> as generated (accepted edge case)", () => {
    expect(isGeneratedId("n7")).toBe(true);
  });
});
