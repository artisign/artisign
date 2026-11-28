// CHR-1268 — which tools apply where (the old mode-toggle rules, plus the panels).
import { describe, it, expect } from "vitest";
import { TOOLS, toolShown, toolStates } from "./tool-states.js";
import { readFileSync } from "node:fs";

const where = (over = {}) => ({ view: "screens", showMockup: false, comparing: false, hasScreen: true, ...over });
const disabled = (states) => Object.entries(states).filter(([, s]) => s.disabled).map(([id]) => id);

describe("toolStates", () => {
  it("everything applies to an open screen in the Screens view", () => {
    expect(disabled(toolStates(where()))).toEqual([]);
  });

  it("comparing: comment, inspect and comments are off with the reason; notes and flow (leaves Compare) stay", () => {
    const states = toolStates(where({ comparing: true }));
    expect(disabled(states)).toEqual(["comment", "inspect", "comments", "showResolved"]);
    expect(states.comment.reason).toBe("Not available while comparing variants");
    expect(states.notes).toEqual({ disabled: false, reason: "" });
  });

  it("a mockup: only comment, comments and show resolved apply (CHR-1263, CHR-1270)", () => {
    const states = toolStates(where({ showMockup: true }));
    expect(disabled(states)).toEqual(["inspect", "notes", "flow"]);
    expect(states.inspect.reason).toBe("Not available for mockups");
  });

  describe("the Board (design `board-view*`, `board-comments*`)", () => {
    const board = (over = {}) => toolStates(where({ view: "board", board: { commentsOn: true, tileCount: 5, openCount: 6, edgesOn: true, clustersOn: true, anyExpanded: true, ...over } }));

    it("comment, inspect and notes are greyed, each with the design's own words", () => {
      const states = board();
      expect(disabled(states)).toEqual(["comment", "inspect", "notes"]);
      expect(states.comment.name).toBe("Comment, read-only on the Board: comment in the Screens view");
      expect(states.comment.hint).toBe(states.comment.name);
      expect(states.inspect.name).toBe("Inspect, not available on the Board");
      expect(states.notes.name).toBe("Notes, not available on the Board");
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

    it("Show resolved is a switch on its own (CHR-1292): never greyed by the data, with the comments off or nothing on the board", () => {
      expect(board({ commentsOn: false }).showResolved.disabled).toBe(false);
      expect(board({ tileCount: 0, openCount: 0 }).showResolved.disabled).toBe(false);
    });

    it("nothing on the board: comments and collapse all are greyed and say so", () => {
      const states = board({ tileCount: 0 });
      expect(disabled(states)).toEqual(["comment", "inspect", "notes", "comments", "collapseAll"]);
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

  it("the design system and Use Cases: nothing in the bar applies (the bar itself is hidden there)", () => {
    for (const view of ["design-system", "usecases"]) expect(disabled(toolStates(where({ view })))).toEqual(["comment", "inspect", "notes", "comments", "flow"]);
  });

  it("no screen open: the screen tools say so", () => {
    const states = toolStates(where({ hasScreen: false }));
    expect(disabled(states)).toEqual(["comment", "inspect", "notes", "comments", "flow", "showResolved"]);
    expect(states.flow.reason).toBe("No screen is open");
  });
});

describe("the tool bar config (CHR-1283, CHR-1288)", () => {
  it("lists the canvas tools first (Comment, Inspect, Flow), then the panel tools", () => {
    expect(TOOLS.filter((t) => t.group === "canvas").slice(0, 3).map((t) => t.key)).toEqual(["comment", "inspect", "flow"]);
    expect(TOOLS.filter((t) => t.group === "panel").map((t) => t.key)).toEqual(["notes", "comments", "showResolved"]);
    const groups = TOOLS.map((t) => t.group);
    expect(groups.indexOf("panel")).toBeGreaterThan(groups.lastIndexOf("canvas")); // the divider sits between two blocks, not inside one
  });

  it("Clusters and Collapse all show on the Board only; Show resolved in the Screens view and on the Board; the rest everywhere", () => {
    for (const key of ["clusters", "collapseAll"]) {
      expect(toolShown(key, "board")).toBe(true);
      for (const view of ["screens", "design-system", "usecases"]) expect(toolShown(key, view)).toBe(false);
    }
    expect(["screens", "board", "design-system", "usecases"].filter((v) => toolShown("showResolved", v))).toEqual(["screens", "board"]);
    for (const key of ["comment", "inspect", "flow", "notes", "comments"]) expect(["screens", "board"].every((v) => toolShown(key, v))).toBe(true);
  });

  it("has no Design system tool (the view tab and key 3 switch views)", () => {
    expect(TOOLS.map((t) => t.key)).not.toContain("designSystem");
  });

  it("the stylesheet lets `hidden` win over the tool's display, so a hidden tool leaves no gap in the bar", () => {
    const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.tool-btn\[hidden\],\s*\.tool-sep\[hidden\]\s*\{\s*display:\s*none;/);
  });
});
