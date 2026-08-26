import { describe, it, expect } from "vitest";
import { findSuspiciousAttr } from "./augmentation-attrs.js";

describe("findSuspiciousAttr", () => {
  it("flags a one-letter typo of a known augmentation attribute", () => {
    expect(findSuspiciousAttr("data-varient")).toBe("data-variant");
  });

  it("flags a near-miss of a longer known augmentation attribute", () => {
    expect(findSuspiciousAttr("data-flow-targt")).toBe("data-flow-target");
  });

  it("does not flag a legitimate data-* attribute an agent adds for its own purposes", () => {
    expect(findSuspiciousAttr("data-testid")).toBeUndefined();
  });

  it("does not flag a non-data attribute", () => {
    expect(findSuspiciousAttr("href")).toBeUndefined();
    expect(findSuspiciousAttr("class")).toBeUndefined();
  });

  it("does not flag a known augmentation attribute itself", () => {
    expect(findSuspiciousAttr("data-variant")).toBeUndefined();
    expect(findSuspiciousAttr("data-component")).toBeUndefined();
  });
});
