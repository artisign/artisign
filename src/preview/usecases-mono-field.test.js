// CHR-1117: a mono chrome field renders at ui-sm (design chrome-field#mono); the mono text outside fields keeps its size.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const rule = (selector) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";

describe("mono chrome field size", () => {
  it("a .chrome-field.uc-mono field is set to ui-sm", () => {
    expect(rule(".chrome-field.uc-mono")).toMatch(/font-size:\s*var\(--ui-sm\)/);
  });

  it("the plain .chrome-field stays at ui-base and the bare .uc-mono rule sets no size (table cells and chips keep theirs)", () => {
    expect(rule(".chrome-field")).toMatch(/font-size:\s*var\(--ui-base\)/);
    expect(rule(".uc-mono")).not.toMatch(/font-size/);
  });

  it("the token is 12px", () => {
    expect(css).toMatch(/--ui-sm:\s*12px/);
  });
});
