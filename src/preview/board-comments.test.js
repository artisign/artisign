import { describe, it, expect } from "vitest";
import { groupPins, screenCounts, dotText } from "./board-comments.js";

describe("groupPins", () => {
  it("merges pins closer than a pin's stacking step in both axes", () => {
    const groups = groupPins([{ x: 50, y: 50 }, { x: 60, y: 55 }, { x: 200, y: 50 }]);
    expect(groups.map((g) => g.length)).toEqual([2, 1]);
  });
  it("keeps pins stacked on one element (one step apart) separate", () => {
    expect(groupPins([{ x: 100, y: 10 }, { x: 80, y: 10 }]).map((g) => g.length)).toEqual([1, 1]);
  });
});

describe("screenCounts", () => {
  it("counts open without detached, and the status line's open total with them", () => {
    const t = (status, detached) => ({ status, detached });
    expect(screenCounts([t("open", false), t("open", false), t("open", true), t("resolved", false), t("resolved", true)])).toEqual({ open: 2, detached: 1, resolved: 2, openTotal: 3 });
  });
});

describe("dotText", () => {
  it("caps at 99+", () => {
    expect([dotText(7), dotText(99), dotText(100), dotText(141)]).toEqual(["7", "99", "99+", "99+"]);
  });
});
