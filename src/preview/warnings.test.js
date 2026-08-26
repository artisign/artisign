import { describe, it, expect } from "vitest";
import { nextIndex } from "./warnings.js";

describe("nextIndex", () => {
  it("starts at 0 when nothing has been selected yet (current = -1)", () => {
    expect(nextIndex(-1, 3)).toBe(0);
  });

  it("advances by one within bounds", () => {
    expect(nextIndex(0, 3)).toBe(1);
    expect(nextIndex(1, 3)).toBe(2);
  });

  it("wraps back to 0 after the last element", () => {
    expect(nextIndex(2, 3)).toBe(0);
  });

  it("returns -1 when there is nothing to cycle through", () => {
    expect(nextIndex(-1, 0)).toBe(-1);
  });
});
