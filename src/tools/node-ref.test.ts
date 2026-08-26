import { describe, it, expect } from "vitest";
import { parseNodeRef, formatNodeRef, requireScreenNodeRef } from "./node-ref.js";
import { ToolError } from "./types.js";

describe("parseNodeRef", () => {
  it("parses a screen ref", () => {
    expect(parseNodeRef("home.n2")).toEqual({ kind: "screen", screen: "home", nodeId: "n2" });
  });

  it("parses a screen ref whose node id itself contains dots", () => {
    // Splits on the first "." only — screen stems don't contain dots, but a
    // generated/authored node id conceivably could.
    expect(parseNodeRef("home.n2.foo")).toEqual({ kind: "screen", screen: "home", nodeId: "n2.foo" });
  });

  it("rejects a screen ref with no dot", () => {
    expect(() => parseNodeRef("home")).toThrow(ToolError);
    expect(() => parseNodeRef("home")).toThrow(/malformed node ref/);
  });

  it("rejects a screen ref with a leading or trailing dot", () => {
    expect(() => parseNodeRef(".n1")).toThrow(ToolError);
    expect(() => parseNodeRef("home.")).toThrow(ToolError);
  });

  it("parses a component ref", () => {
    expect(parseNodeRef("component:btn-primary#hover.n2")).toEqual({
      kind: "component",
      name: "btn-primary",
      variant: "hover",
      nodeId: "n2",
      address: "component:btn-primary#hover",
    });
  });

  it("rejects a component ref missing the #variant", () => {
    expect(() => parseNodeRef("component:btn-primary.n2")).toThrow(ToolError);
    expect(() => parseNodeRef("component:btn-primary.n2")).toThrow(/validation_failed|malformed/);
  });

  it("rejects a component ref missing the node id", () => {
    expect(() => parseNodeRef("component:btn-primary#hover")).toThrow(ToolError);
  });

  it("rejects a component ref with an empty name", () => {
    expect(() => parseNodeRef("component:#hover.n2")).toThrow(ToolError);
  });

  it("parses a pattern ref", () => {
    expect(parseNodeRef("pattern:card-grid.n1")).toEqual({
      kind: "pattern",
      name: "card-grid",
      nodeId: "n1",
      address: "pattern:card-grid",
    });
  });

  it("rejects a pattern ref with no dot", () => {
    expect(() => parseNodeRef("pattern:card-grid")).toThrow(ToolError);
  });

  it("rejects a pattern ref with an empty name", () => {
    expect(() => parseNodeRef("pattern:.n1")).toThrow(ToolError);
  });

  it("every thrown error is validation_failed, not a generic Error", () => {
    for (const bad of ["home", "component:x.n1", "pattern:"]) {
      try {
        parseNodeRef(bad);
        expect.unreachable(`expected "${bad}" to throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(ToolError);
        expect((err as ToolError).code).toBe("validation_failed");
      }
    }
  });
});

describe("formatNodeRef", () => {
  it("joins a screen address and a node id", () => {
    expect(formatNodeRef("home", "n2")).toBe("home.n2");
  });

  it("joins a definition address (already carrying its prefix/variant) and a node id", () => {
    expect(formatNodeRef("component:btn-primary#hover", "n2")).toBe("component:btn-primary#hover.n2");
    expect(formatNodeRef("pattern:card-grid", "n1")).toBe("pattern:card-grid.n1");
  });

  it("round-trips through parseNodeRef", () => {
    const ref = parseNodeRef("component:btn-primary#hover.n2");
    expect(ref.kind).not.toBe("screen");
    expect(formatNodeRef((ref as { address: string }).address, ref.nodeId)).toBe("component:btn-primary#hover.n2");
  });
});

describe("requireScreenNodeRef", () => {
  it("passes a screen ref through unchanged", () => {
    const ref = parseNodeRef("home.n2");
    expect(requireScreenNodeRef(ref, "patch_html")).toEqual(ref);
  });

  it("rejects a definition ref with validation_failed naming the tool", async () => {
    const ref = parseNodeRef("component:btn-primary#hover.n2");
    expect(() => requireScreenNodeRef(ref, "patch_html")).toThrow(ToolError);
    try {
      requireScreenNodeRef(ref, "patch_html");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("validation_failed");
      expect((err as ToolError).message).toContain("patch_html");
    }
  });
});
