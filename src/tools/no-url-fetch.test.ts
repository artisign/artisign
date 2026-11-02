import { describe, it, expect } from "vitest";
import { z } from "zod";
import { findTool } from "./registry.js";

const parse = (tool: string, key: "seed" | "source", value: unknown) =>
  z.object(findTool(tool)!.inputShape).safeParse(tool === "init_project" ? { dir: "/x", [key]: value } : { [key]: value });

describe("URL fetching is gone (CHR-984)", () => {
  const stitch = { kind: "stitch_export", url: "https://example.com/a.html" };

  it("init_project rejects seed kind stitch_export", () => {
    expect(parse("init_project", "seed", stitch).success).toBe(false);
  });
  it("import_html rejects source kind stitch_export", () => {
    expect(parse("import_html", "source", stitch).success).toBe(false);
  });
  it("kind html is still accepted by both", () => {
    expect(parse("init_project", "seed", { kind: "html", html_aug: "<div></div>", screen: "home" }).success).toBe(true);
    expect(parse("import_html", "source", { kind: "html", html_aug: "<div></div>" }).success).toBe(true);
  });
  it("tool descriptions no longer mention Stitch or URLs", () => {
    for (const name of ["init_project", "import_html"]) {
      expect(findTool(name)!.description).not.toMatch(/stitch|url/i);
    }
  });
});
