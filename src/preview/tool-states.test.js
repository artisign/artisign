// CHR-1268 — which tools apply where (the old mode-toggle rules, plus the panels).
import { describe, it, expect } from "vitest";
import { toolStates } from "./tool-states.js";

const where = (over = {}) => ({ view: "screens", showMockup: false, comparing: false, hasScreen: true, ...over });
const disabled = (states) => Object.entries(states).filter(([, s]) => s.disabled).map(([id]) => id);

describe("toolStates", () => {
  it("everything applies to an open screen in the Screens view", () => {
    expect(disabled(toolStates(where()))).toEqual([]);
  });

  it("comparing: comment, inspect and comments are off with the reason; notes, flow (leaves Compare) and the design system stay", () => {
    const states = toolStates(where({ comparing: true }));
    expect(disabled(states)).toEqual(["comment", "inspect", "comments"]);
    expect(states.comment.reason).toBe("Not available while comparing variants");
    expect(states.notes).toEqual({ disabled: false, reason: "" });
  });

  it("a mockup: only comment and comments apply — the design system is greyed too (CHR-1263, CHR-1270)", () => {
    const states = toolStates(where({ showMockup: true }));
    expect(disabled(states)).toEqual(["inspect", "notes", "flow", "designSystem"]);
    expect(states.inspect.reason).toBe("Not available for mockups");
    expect(states.designSystem.reason).toBe("Not available for mockups");
  });

  describe("the Board (design `board-view*`, `board-comments*`)", () => {
    const board = (over = {}) => toolStates(where({ view: "board", board: { commentsOn: true, tileCount: 5, openCount: 6, edgesOn: true, clustersOn: true, anyExpanded: true, ...over } }));

    it("comment, inspect, notes and the design system are greyed, each with the design's own words", () => {
      const states = board();
      expect(disabled(states)).toEqual(["comment", "inspect", "notes", "designSystem"]);
      expect(states.comment.name).toBe("Comment, read-only on the Board: comment in the Screens view");
      expect(states.comment.hint).toBe(states.comment.name);
      expect(states.inspect.name).toBe("Inspect, not available on the Board");
      expect(states.notes.name).toBe("Notes, not available on the Board");
      expect(states.designSystem.name).toBe("Design system, not available on the Board");
    });

    it("comments, show resolved, flow arrows, clusters and collapse all apply, named as the design names them", () => {
      const states = board();
      expect(states.comments).toEqual({ disabled: false, reason: "", name: "Comments on tiles, 6 open" });
      expect(states.showResolved.name).toBe("Show resolved comments");
      expect(states.flow.name).toBe("Flow arrows");
      expect(states.clusters.name).toBe("Clusters");
      expect(states.collapseAll.name).toBe("Collapse all clusters");
      expect(board({ openCount: 0 }).comments.name).toBe("Comments on tiles");
    });

    it("Show resolved waits for the comments: greyed with the reason while they are off", () => {
      const states = board({ commentsOn: false });
      expect(states.showResolved.disabled).toBe(true);
      expect(states.showResolved.name).toBe("Show resolved comments, turn on comments first");
      expect(states.showResolved.hint).toBe("Show resolved comments, turn on comments first");
    });

    it("nothing on the board: comments, show resolved and collapse all are greyed and say so", () => {
      const states = board({ tileCount: 0 });
      expect(disabled(states)).toEqual(["comment", "inspect", "notes", "comments", "showResolved", "designSystem", "collapseAll"]);
      expect(states.comments.name).toBe("Comments on tiles, nothing on the board");
      expect(states.comments.hint).toBe("Nothing on the board");
      expect(states.collapseAll.name).toBe("Collapse all clusters, nothing on the board");
      expect(states.flow.disabled).toBe(false);
      expect(states.clusters.disabled).toBe(false);
    });

    it("collapse all is greyed while every cluster is collapsed, and while clusters are off", () => {
      const collapsed = board({ anyExpanded: false });
      expect(collapsed.collapseAll.name).toBe("Collapse all clusters, all are collapsed");
      expect(collapsed.collapseAll.hint).toBe("All clusters are collapsed");
      expect(board({ clustersOn: false }).collapseAll.disabled).toBe(true);
    });
  });

  it("the design system and Use Cases: only the design system tool applies", () => {
    for (const view of ["design-system", "usecases"]) expect(disabled(toolStates(where({ view })))).toEqual(["comment", "inspect", "notes", "comments", "flow"]);
  });

  it("no screen open: the screen tools say so", () => {
    const states = toolStates(where({ hasScreen: false }));
    expect(disabled(states)).toEqual(["comment", "inspect", "notes", "comments", "flow"]);
    expect(states.flow.reason).toBe("No screen is open");
  });
});
