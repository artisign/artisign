// CHR-1268 — which tools apply where (the old mode-toggle rules, plus the panels).
import { describe, it, expect } from "vitest";
import { toolStates } from "./tool-states.js";

const where = (over = {}) => ({ view: "screens", showMockup: false, comparing: false, hasScreen: true, ...over });
const disabled = (states) => Object.entries(states).filter(([, s]) => s.disabled).map(([id]) => id);

describe("toolStates", () => {
  it("everything applies to an open screen in the Screens view", () => {
    expect(disabled(toolStates(where()))).toEqual([]);
  });

  it("comparing: comment, inspect, comments and More are off with the reason; notes, flow (leaves Compare) and the design system stay", () => {
    const states = toolStates(where({ comparing: true }));
    expect(disabled(states)).toEqual(["comment", "inspect", "comments", "more"]);
    expect(states.comment.reason).toBe("Not available while comparing variants");
    expect(states.notes).toEqual({ disabled: false, reason: "" });
  });

  it("a mockup: only comment, comments and the design system apply (CHR-1263)", () => {
    const states = toolStates(where({ showMockup: true }));
    expect(disabled(states)).toEqual(["inspect", "notes", "flow", "more"]);
    expect(states.inspect.reason).toBe("Not available for mockups");
  });

  it("the Board: flow (it arms the tile jump) and the design system apply", () => {
    const states = toolStates(where({ view: "board" }));
    expect(disabled(states)).toEqual(["comment", "inspect", "notes", "comments", "more"]);
    expect(states.comment.reason).toBe("Not available on the Board");
  });

  it("the design system and Use Cases: only the design system tool applies", () => {
    for (const view of ["design-system", "usecases"]) expect(disabled(toolStates(where({ view })))).toEqual(["comment", "inspect", "notes", "comments", "flow", "more"]);
  });

  it("no screen open: the screen tools say so", () => {
    const states = toolStates(where({ hasScreen: false }));
    expect(disabled(states)).toEqual(["comment", "inspect", "notes", "comments", "flow", "more"]);
    expect(states.flow.reason).toBe("No screen is open");
  });
});
