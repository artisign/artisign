import { describe, expect, it } from "vitest";
import { changelogSection } from "./changelog-section.js";

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.9.0] - 2026-08-26

### Added

- First public release.

## [0.0.1] - 2026-08-17

- Placeholder.
`;

describe("changelogSection", () => {
  it("returns the section body up to the next heading", () => {
    expect(changelogSection(CHANGELOG, "0.9.0")).toBe("### Added\n\n- First public release.");
  });

  it("returns the last section when no heading follows", () => {
    expect(changelogSection(CHANGELOG, "0.0.1")).toBe("- Placeholder.");
  });

  it("throws when the version has no section", () => {
    expect(() => changelogSection(CHANGELOG, "1.0.0")).toThrow('no "## [1.0.0]" section');
  });

  it("throws when the section is empty", () => {
    expect(() => changelogSection(CHANGELOG, "Unreleased")).toThrow("is empty");
  });
});
