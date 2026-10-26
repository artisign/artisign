import { describe, it, expect } from "vitest";
import { parseChangelog, readChangelog, releasesBetween } from "./changelog.js";

describe("readChangelog (real CHANGELOG.md)", () => {
  const releases = readChangelog();
  const byVersion = (v: string) => releases.find((r) => r.version === v);

  it("has the released sections and no Unreleased", () => {
    expect(byVersion("2.1.1")?.date).toBe("2026-10-21");
    expect(byVersion("2.1.0")).toBeDefined();
    expect(releases.some((r) => /unreleased/i.test(r.version))).toBe(false);
  });

  it("keeps non-empty Markdown bodies starting with a subsection or prose", () => {
    for (const r of releases) {
      expect(r.body.length).toBeGreaterThan(0);
      expect(r.body).not.toMatch(/^## /);
      expect(r.body).toBe(r.body.trim());
    }
    expect(byVersion("2.1.1")?.body.startsWith("### Fixed")).toBe(true);
    expect(byVersion("2.1.0")?.body.startsWith("One install path")).toBe(true);
  });
});

describe("parseChangelog", () => {
  it("keeps the body as-is and reads the date", () => {
    const text = "# Changelog\n\n## [1.2.0] - 2026-01-02\n\n### Added\n\n- one\n  wrapped\n\n## [1.1.0] - 2026-01-01\n\nProse.\n";
    expect(parseChangelog(text)).toEqual([
      { version: "1.2.0", date: "2026-01-02", body: "### Added\n\n- one\n  wrapped" },
      { version: "1.1.0", date: "2026-01-01", body: "Prose." },
    ]);
  });

  it("accepts a missing date", () => {
    expect(parseChangelog("## [1.0.0]\n\n- x\n")).toEqual([{ version: "1.0.0", date: null, body: "- x" }]);
  });

  it("skips Unreleased and non x.y.z headings", () => {
    expect(parseChangelog("## [Unreleased]\n\n- a\n\n## [2.0.0-rc.1] - 2026-01-01\n\n- b\n\n## Misc\n\n- c\n")).toEqual([]);
  });

  it("strips trailing link-reference definitions", () => {
    const text = "## [1.0.0] - 2026-01-01\n\n- x\n\n[1.0.0]: https://example.com/1\n[Unreleased]: https://example.com/u\n";
    expect(parseChangelog(text)).toEqual([{ version: "1.0.0", date: "2026-01-01", body: "- x" }]);
  });

  it("handles CRLF and empty input", () => {
    expect(parseChangelog("## [1.0.0] - 2026-01-01\r\n\r\n- x\r\n")[0]?.body).toBe("- x");
    expect(parseChangelog("")).toEqual([]);
  });
});

describe("releasesBetween", () => {
  const rel = (version: string) => ({ version, date: null, body: "b" });
  const all = [rel("1.0.0"), rel("2.0.0"), rel("1.5.0"), rel("3.0.0")];

  it("filters since < v <= upTo, newest first", () => {
    expect(releasesBetween(all, "1.0.0", "2.0.0").map((r) => r.version)).toEqual(["2.0.0", "1.5.0"]);
  });
  it("returns everything up to upTo without since", () => {
    expect(releasesBetween(all, undefined, "2.0.0").map((r) => r.version)).toEqual(["2.0.0", "1.5.0", "1.0.0"]);
  });
});
