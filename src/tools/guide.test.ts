import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { getGuide } from "./guide.js";

// Same module-relative resolution as guide.ts itself — see its comment.
const AGENT_GUIDE_URL = new URL("../../docs/agent-guide.md", import.meta.url);
const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);

describe("get_guide", () => {
  it("returns the full, unmodified content of docs/agent-guide.md", async () => {
    const expected = await readFile(AGENT_GUIDE_URL, "utf-8");
    const res = await getGuide();
    expect(res.guide).toBe(expected);
  });

  it("is non-empty and opens with the guide's heading", async () => {
    const res = await getGuide();
    expect(res.guide.length).toBeGreaterThan(0);
    expect(res.guide).toContain("# Designing with Artisign — Agent Guide");
  });
});

describe("get_guide — packaging", () => {
  it("package.json files[] ships both guide documents", async () => {
    const pkg = JSON.parse(await readFile(PACKAGE_JSON_URL, "utf-8")) as { files: string[] };
    expect(pkg.files).toContain("docs/agent-guide.md");
    expect(pkg.files).toContain("docs/design-workflow-tutorial.md");
  });
});
