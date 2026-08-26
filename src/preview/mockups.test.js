import { describe, it, expect } from "vitest";
import { filterMockups } from "./mockups.js";

describe("filterMockups", () => {
  const mockups = [
    { name: "checkout-redesign", title: "Checkout Redesign" },
    { name: "onboarding", title: undefined },
  ];

  it("returns everything for an empty filter", () => {
    expect(filterMockups(mockups, "")).toEqual(mockups);
    expect(filterMockups(mockups, "   ")).toEqual(mockups);
  });

  it("matches case-insensitively on name", () => {
    expect(filterMockups(mockups, "ONBOARD")).toEqual([mockups[1]]);
  });

  it("matches case-insensitively on title", () => {
    expect(filterMockups(mockups, "redesign")).toEqual([mockups[0]]);
  });

  it("tolerates a missing title without matching everything", () => {
    expect(filterMockups(mockups, "nonexistent")).toEqual([]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterMockups(mockups, "zzz")).toEqual([]);
  });
});
