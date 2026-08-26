import { describe, it, expect } from "vitest";
import { parseScreen } from "../model/parser.js";
import type { DesignSystemRegistry } from "../model/registry.js";
import { INSTRUCTIONS } from "./instructions.js";

/**
 * The worked example embedded in INSTRUCTIONS is the one piece of prose a
 * design agent is most likely to copy verbatim — if it stops matching the
 * real parser, the cheat sheet actively misleads. This extracts it and runs
 * it through the real parser with a registry containing the component/token
 * it references.
 */
function extractExample(instructions: string): string {
  const start = instructions.indexOf("EXAMPLE:");
  const end = instructions.indexOf("REVIEW LOOP:");
  const block = instructions.slice(start + "EXAMPLE:".length, end);
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

describe("INSTRUCTIONS worked example", () => {
  const registry: DesignSystemRegistry = {
    componentNames: new Set(["btn-primary"]),
    tokenPaths: new Set(["spacing.lg"]),
    tokenFlatNames: new Set(["spacing"]),
  };

  it("parses with zero blocking errors against a registry containing the referenced component/token", () => {
    const html = extractExample(INSTRUCTIONS);
    expect(html.length).toBeGreaterThan(0);

    const { doc, errors } = parseScreen(html, "example", registry);

    expect(errors).toEqual([]);
    expect(doc.flows).toHaveLength(1);
    expect(doc.flows[0]).toMatchObject({ targetKind: "screen", targetId: "dashboard", triggerEvent: "tap" });
  });
});
