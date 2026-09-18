import { describe, it, expect } from "vitest";
import { deriveActivityEvent } from "./activity.js";

describe("deriveActivityEvent", () => {
  it("classifies a read tool", () => {
    const evt = deriveActivityEvent("get_screen", { screen: "home" }, true, { screen: "home" });
    expect(evt.kind).toBe("read");
  });

  it("classifies a write tool", () => {
    const evt = deriveActivityEvent("write_html", { screen: "home", mode: "create" }, true, { root_node_id: "n1" });
    expect(evt.kind).toBe("write");
  });

  it("classifies an unlisted (future) tool as write, not read", () => {
    const evt = deriveActivityEvent("some_new_tool", {}, true, {});
    expect(evt.kind).toBe("write");
  });

  it("stamps every event with type \"activity\" and an epoch-ms `at`", () => {
    const before = Date.now();
    const evt = deriveActivityEvent("get_project", {}, true, {});
    expect(evt.type).toBe("activity");
    expect(evt.at).toBeGreaterThanOrEqual(before);
  });

  describe("reads", () => {
    it("get_screen targets the screen, no nodes", () => {
      const evt = deriveActivityEvent("get_screen", { screen: "home" }, true, { screen: "home" });
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual([]);
    });

    it("get_mockup targets the mockup, carrying variant when given", () => {
      const evt = deriveActivityEvent("get_mockup", { mockup: "hero", variant: "a" }, true, {});
      expect(evt.target).toEqual({ kind: "mockup", name: "hero", variant: "a" });
    });

    it("get_node targets the node ref's screen, nodes carries the ref itself", () => {
      const evt = deriveActivityEvent("get_node", { node: "home.n1" }, true, { node: "home.n1" });
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual(["home.n1"]);
    });

    it("get_node on a component definition ref targets the component + variant", () => {
      const evt = deriveActivityEvent("get_node", { node: "component:btn-primary#hover.n1" }, true, {});
      expect(evt.target).toEqual({ kind: "component", name: "btn-primary", variant: "hover" });
      expect(evt.nodes).toEqual(["component:btn-primary#hover.n1"]);
    });

    it("get_node on a pattern definition ref targets the pattern", () => {
      const evt = deriveActivityEvent("get_node", { node: "pattern:card-grid.n1" }, true, {});
      expect(evt.target).toEqual({ kind: "pattern", name: "card-grid" });
      expect(evt.nodes).toEqual(["pattern:card-grid.n1"]);
    });

    it("inspect_node derives the same way as get_node", () => {
      const evt = deriveActivityEvent("inspect_node", { node: "home.n1" }, true, {});
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual(["home.n1"]);
    });

    it("get_screenshot with a node ref behaves like get_node", () => {
      const evt = deriveActivityEvent("get_screenshot", { node: "home.n1" }, true, {});
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual(["home.n1"]);
    });

    it("get_screenshot with only screen targets the screen, no nodes", () => {
      const evt = deriveActivityEvent("get_screenshot", { screen: "home" }, true, {});
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual([]);
    });

    it("get_screenshot with mockup+variant targets the mockup", () => {
      const evt = deriveActivityEvent("get_screenshot", { mockup: "hero", variant: "a" }, true, {});
      expect(evt.target).toEqual({ kind: "mockup", name: "hero", variant: "a" });
    });

    it("broad reads (get_project, find_nodes, get_design_system, list_comments, get_guide) carry no target", () => {
      for (const tool of ["get_project", "find_nodes", "get_design_system", "list_comments", "get_guide"]) {
        const evt = deriveActivityEvent(tool, {}, true, {});
        expect(evt.target, tool).toBeNull();
        expect(evt.nodes, tool).toEqual([]);
      }
    });
  });

  describe("writes", () => {
    it("write_html reports the root node only (coarse — the whole screen is the affected region)", () => {
      const evt = deriveActivityEvent(
        "write_html",
        { screen: "home", mode: "create" },
        true,
        { root_node_id: "n1", node_count: 3 },
      );
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual(["home.n1"]);
    });

    it("write_html kind:component targets the component, no nodes (definitions carry no per-node ids)", () => {
      const evt = deriveActivityEvent(
        "write_html",
        { screen: "btn-primary", mode: "create", kind: "component", html_aug: "<button id=\"n1\"></button>" },
        true,
        { kind: "component", name: "btn-primary", variants: ["default"] },
      );
      expect(evt.target).toEqual({ kind: "component", name: "btn-primary" });
      expect(evt.nodes).toEqual([]);
    });

    it("patch_html by node target reports affected_nodes", () => {
      const evt = deriveActivityEvent(
        "patch_html",
        { target: { kind: "node", node: "home.n1" }, operation: "set_attr" },
        true,
        { affected_nodes: ["home.n1"] },
      );
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual(["home.n1"]);
    });

    it("patch_html by selector target reports the screen and every affected_nodes entry", () => {
      const evt = deriveActivityEvent(
        "patch_html",
        { target: { kind: "selector", screen: "home", css_selector: ".card" }, operation: "delete" },
        true,
        { affected_nodes: ["home.n1", "home.n2"] },
      );
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual(["home.n1", "home.n2"]);
    });

    it("update_refs reports the input node as both target and nodes", () => {
      const evt = deriveActivityEvent("update_refs", { node: "home.n1", refs: {} }, true, { applied_refs: {} });
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual(["home.n1"]);
    });

    it("promote_to_system reports rewritten_nodes, target from the source node", () => {
      const evt = deriveActivityEvent(
        "promote_to_system",
        { node: "home.n1", kind: "component", name: "btn-primary" },
        true,
        { rewritten_nodes: ["home.n1", "checkout.n7"] },
      );
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual(["home.n1", "checkout.n7"]);
    });

    it("set_tokens has no single target — it rewrites across many screens/components/patterns at once", () => {
      const evt = deriveActivityEvent(
        "set_tokens",
        { tokens: { "color.primary": "#000" }, mode: "patch" },
        true,
        { affected_screens: ["home", "checkout"] },
      );
      expect(evt.target).toBeNull();
      expect(evt.nodes).toEqual([]);
    });

    it("set_flow reports the trigger node as both target and nodes", () => {
      const evt = deriveActivityEvent("set_flow", { node: "home.n1", flow: null }, true, {});
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual(["home.n1"]);
    });

    it("set_meta on a screen target", () => {
      const evt = deriveActivityEvent("set_meta", { target: { kind: "screen", screen: "home" }, notes: "wip" }, true, {});
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
    });

    it("set_meta on a design_system target has no matching ActivityTarget kind", () => {
      const evt = deriveActivityEvent("set_meta", { target: { kind: "design_system" }, idea: "x" }, true, {});
      expect(evt.target).toBeNull();
    });

    it("write_mockup targets the mockup+variant", () => {
      const evt = deriveActivityEvent("write_mockup", { mockup: "hero", variant: "a", mode: "create", html: "<div></div>" }, true, {});
      expect(evt.target).toEqual({ kind: "mockup", name: "hero", variant: "a" });
    });

    it("set_board_state is a read when no field is given, a write otherwise", () => {
      expect(deriveActivityEvent("set_board_state", {}, true, {}).kind).toBe("read");
      expect(deriveActivityEvent("set_board_state", { filter: null }, true, {}).kind).toBe("write");
      expect(deriveActivityEvent("set_board_state", { pins: { op: "clear" } }, true, {}).kind).toBe("write");
    });

    it("delete_entity targets the deleted entity, no nodes", () => {
      const evt = deriveActivityEvent("delete_entity", { kind: "screen", name: "home" }, true, {});
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual([]);
    });

    it("delete_entity carries a variant only for a mockup", () => {
      const mockup = deriveActivityEvent("delete_entity", { kind: "mockup", name: "m", variant: "a" }, true, {});
      expect(mockup.target).toEqual({ kind: "mockup", name: "m", variant: "a" });
      const screen = deriveActivityEvent("delete_entity", { kind: "screen", name: "home", variant: "a" }, true, {});
      expect(screen.target).toEqual({ kind: "screen", name: "home" });
    });

    it("import_html targets the imported screen from the response, since the name isn't always in the input", () => {
      const evt = deriveActivityEvent(
        "import_html",
        { source: { kind: "html", html_aug: "<div></div>" } },
        true,
        { imported: [{ screen: "imported-1", path: "screens/imported-1.html" }] },
      );
      expect(evt.target).toEqual({ kind: "screen", name: "imported-1" });
    });

    it("init_project and reply_comment carry no target — no ActivityTarget shape fits", () => {
      const initEvt = deriveActivityEvent("init_project", { dir: "/tmp/x", seed: { kind: "empty" } }, true, { root: "/tmp/x" });
      expect(initEvt.target).toBeNull();
      const replyEvt = deriveActivityEvent("reply_comment", { comment_id: "cmt_1", body: "ok" }, true, { comment_id: "cmt_1" });
      expect(replyEvt.target).toBeNull();
    });
  });

  describe("degradation on a coarser/failed response", () => {
    // write_html's blocking-error path (writes.ts ~L94-131, ~L196-198) never
    // throws — it returns `{ commit: null, errors: [...], warnings: [] }`
    // normally, so server.ts's wrapper calls deriveActivityEvent with
    // ok:true (no exception happened). ok must still come out false: a
    // preview acting on true here would navigate to a screen that was never
    // written.
    it("write_html: a non-throwing blocking-error response still yields ok:false, target still named, no nodes", () => {
      const evt = deriveActivityEvent(
        "write_html",
        { screen: "home", mode: "create" },
        true,
        { screen: "home", commit: null, errors: [{ code: "malformed_html", message: "x" }], warnings: [] },
      );
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual([]);
      expect(evt.ok).toBe(false);
    });

    it("write_html kind:component's blocking-error path (no default-variant root) also yields ok:false", () => {
      const evt = deriveActivityEvent(
        "write_html",
        { screen: "btn-primary", mode: "create", kind: "component", html_aug: "<template></template>" },
        true,
        { kind: "component", screen: "btn-primary", path: "design-system/components/btn-primary.html", commit: null, errors: [{ code: "validation_failed", message: "x" }], warnings: [] },
      );
      expect(evt.target).toEqual({ kind: "component", name: "btn-primary" });
      expect(evt.ok).toBe(false);
    });

    it("import_html's parse-error response also yields ok:false, despite no exception", () => {
      const evt = deriveActivityEvent(
        "import_html",
        { source: { kind: "html", html_aug: "<div", screen: "imported" } },
        true,
        { commit: null, imported: [], skipped_duplicate_count: 0, warnings: [], errors: [{ code: "malformed_html", message: "x" }] },
      );
      expect(evt.ok).toBe(false);
    });

    it("a response with an empty errors array stays ok:true", () => {
      const evt = deriveActivityEvent("write_html", { screen: "home", mode: "create" }, true, { root_node_id: "n1", errors: [], warnings: [] });
      expect(evt.ok).toBe(true);
    });

    it("a thrown ToolError leaves ok:false and still derives target from input alone (no result)", () => {
      const evt = deriveActivityEvent("get_node", { node: "home.n1" }, false, undefined);
      expect(evt.ok).toBe(false);
      expect(evt.target).toEqual({ kind: "screen", name: "home" });
      expect(evt.nodes).toEqual(["home.n1"]);
    });

    it("a malformed node ref never throws — degrades to no target", () => {
      const evt = deriveActivityEvent("get_node", { node: "not-a-valid-ref" }, false, undefined);
      expect(evt.target).toBeNull();
      expect(evt.nodes).toEqual([]);
    });
  });
});
