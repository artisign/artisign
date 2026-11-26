import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, estimateTokens, type ProjectFixture } from "./test-fixtures.js";
import { applyThreadAction, createAgentComment, createComment, groupThreads, readCommentRecordsWithStats, replyComment } from "./comments.js";
import { findNodes, getProject, listComments } from "./reads.js";
import { deleteMockupEntity, getMockup, promoteMockup, writeMockup } from "./mockups.js";
import { patchHtml } from "./writes.js";
import { ToolError } from "./types.js";

type Listed = {
  id: string;
  screen?: string;
  mockup?: string;
  variant?: string;
  node: string | null;
  detached?: boolean;
  status: string;
  body: string;
};

async function list(fx: ProjectFixture, input: Parameters<typeof listComments>[1] = {}): Promise<Listed[]> {
  return (await listComments(fx.store, input)).comments as Listed[];
}

async function rejects(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error("expected the call to be refused");
}

const LINE = { parent_id: null, node_id: null, author: "human", text: "old", resolved: false, ts: "2026-01-01T00:00:00.000Z" };

// CHR-1262 / ADR-012 — comment threads anchored to mockup variants.
describe("comments on mockup variants", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<div id="root"><p id="card-goal">Goal</p></div>`);
    await writeMockup(fx.store, {
      mockup: "cart-options",
      variant: "a",
      mode: "create",
      html: `<section id="cart"><ul><li id="item-1">Tea</li><li>Coffee</li></ul><template><b id="in-template">x</b></template></section>`,
    });
    await writeMockup(fx.store, { mockup: "cart-options", variant: "b", mode: "create", html: `<div>no ids here</div>` });
  });
  afterEach(() => fx.cleanup());

  describe("storage", () => {
    it("keeps old lines valid and counts a line with neither screen nor mockup as malformed", async () => {
      await fx.store.appendComment(JSON.stringify({ ...LINE, id: "cmt_old", screen: "home", node_id: "home.card-goal" }));
      await fx.store.appendComment(JSON.stringify({ ...LINE, id: "cmt_none" }));
      await fx.store.appendComment(JSON.stringify({ ...LINE, id: "cmt_half", mockup: "cart-options" }));
      await fx.store.appendComment(JSON.stringify(42));

      const { records, skippedMalformedLines } = await readCommentRecordsWithStats(fx.store);
      expect(records.map((r) => r.id)).toEqual(["cmt_old"]);
      expect(skippedMalformedLines).toBe(3);

      const res = await listComments(fx.store, {});
      expect(res.skipped_malformed_lines).toBe(3);
      expect(res.comments).toEqual([expect.objectContaining({ id: "cmt_old", screen: "home", node: "home.card-goal" })]);
    });

    it("reads a mockup line written by hand and applies its events", async () => {
      await fx.store.appendComment(JSON.stringify({ ...LINE, id: "cmt_m", mockup: "cart-options", variant: "a", node_id: "mockup:cart-options#a.item-1" }));
      await fx.store.appendComment(
        JSON.stringify({ ...LINE, id: "cmt_e", mockup: "cart-options", variant: "a", node_id: "mockup:cart-options#a.cart", parent_id: "cmt_m", text: "", event: "reanchor" }),
      );
      const [thread] = groupThreads((await readCommentRecordsWithStats(fx.store)).records);
      expect(thread!.root).toMatchObject({ mockup: "cart-options", variant: "a", node_id: "mockup:cart-options#a.cart" });
      expect(thread!.root).not.toHaveProperty("screen");
    });
  });

  describe("create_comment", () => {
    it("starts a thread on an authored id, by ref or bare id", async () => {
      const bare = await createAgentComment(fx.store, { mockup: "cart-options", variant: "a", node: "item-1", body: "heavy rows" }, "claude");
      expect(bare).toMatchObject({ mockup: "cart-options", variant: "a", node: "mockup:cart-options#a.item-1", status: "open", path: "comments.jsonl" });
      expect(bare).not.toHaveProperty("screen");
      const byRef = await createAgentComment(fx.store, { mockup: "cart-options", variant: "a", node: "mockup:cart-options#a.cart", body: "whole card" });
      expect(byRef.node).toBe("mockup:cart-options#a.cart");

      const roots = await list(fx);
      expect(roots).toEqual([
        expect.objectContaining({ mockup: "cart-options", variant: "a", node: "mockup:cart-options#a.item-1", body: "heavy rows", status: "open" }),
        expect.objectContaining({ mockup: "cart-options", variant: "a", node: "mockup:cart-options#a.cart" }),
      ]);
      expect(roots[0]).not.toHaveProperty("screen");
    });

    it("starts a whole-variant thread without a node", async () => {
      const res = await createAgentComment(fx.store, { mockup: "cart-options", variant: "b", body: "no ids to anchor to" });
      expect(res.node).toBeNull();
      expect((await list(fx, { mockup: "cart-options", variant: "b" }))[0]).toMatchObject({ node: null });
    });

    it("refuses a derived id with not_found and a hint", async () => {
      const err = await rejects(createAgentComment(fx.store, { mockup: "cart-options", variant: "a", node: "n3", body: "x" }));
      expect(err.code).toBe("not_found");
      expect(err.message).toMatch(/authored id/);
      expect(err.message).toMatch(/write_mockup or patch_html replace/);
    });

    it("does not count an id inside <template> content", async () => {
      expect((await rejects(createAgentComment(fx.store, { mockup: "cart-options", variant: "a", node: "in-template", body: "x" }))).code).toBe("not_found");
    });

    it("answers not_found for an unknown mockup or variant", async () => {
      expect((await rejects(createAgentComment(fx.store, { mockup: "nope", variant: "a", body: "x" }))).code).toBe("not_found");
      expect((await rejects(createAgentComment(fx.store, { mockup: "cart-options", variant: "z", body: "x" }))).code).toBe("not_found");
      expect((await rejects(createAgentComment(fx.store, { mockup: "cart-options", variant: "z", node: "item-1", body: "x" }))).code).toBe("not_found");
    });

    it("validates the target union", async () => {
      const bad = [
        { body: "x" },
        { screen: "home", mockup: "cart-options", variant: "a", body: "x" },
        { variant: "a", body: "x" },
        { mockup: "cart-options", body: "x" },
        { screen: "home", variant: "a", body: "x" },
        { mockup: "../x", variant: "a", body: "x" },
        { mockup: "cart-options", variant: "a", node: "component:chip#default.x", body: "x" },
        { mockup: "cart-options", variant: "a", node: "home.card-goal", body: "x" },
      ];
      for (const input of bad) expect((await rejects(createAgentComment(fx.store, input))).code, JSON.stringify(input)).toBe("validation_failed");
    });

    it("refuses a mockup ref on a screen target", async () => {
      expect((await rejects(createAgentComment(fx.store, { screen: "home", node: "mockup:cart-options#a.item-1", body: "x" }))).code).toBe("validation_failed");
    });
  });

  describe("list_comments", () => {
    beforeEach(async () => {
      await createAgentComment(fx.store, { screen: "home", node: "card-goal", body: "screen thread" });
      await createAgentComment(fx.store, { mockup: "cart-options", variant: "a", node: "item-1", body: "on a" });
      await createAgentComment(fx.store, { mockup: "cart-options", variant: "b", body: "on b" });
    });

    it("lists screens and mockups without a filter", async () => {
      expect((await list(fx)).map((c) => c.body)).toEqual(["screen thread", "on a", "on b"]);
    });

    it("filters by screen, by mockup and by mockup + variant", async () => {
      expect((await list(fx, { screen: "home" })).map((c) => c.body)).toEqual(["screen thread"]);
      expect((await list(fx, { mockup: "cart-options" })).map((c) => c.body)).toEqual(["on a", "on b"]);
      expect((await list(fx, { mockup: "cart-options", variant: "b" })).map((c) => c.body)).toEqual(["on b"]);
      expect(await list(fx, { mockup: "other" })).toEqual([]);
    });

    it("lets the node filter win, for a screen ref and a mockup ref", async () => {
      expect((await list(fx, { node: "mockup:cart-options#a.item-1" })).map((c) => c.body)).toEqual(["on a"]);
      expect((await list(fx, { node: "home.card-goal", mockup: "cart-options" })).map((c) => c.body)).toEqual(["screen thread"]);
    });

    it("validates the filter combination", async () => {
      expect((await rejects(listComments(fx.store, { variant: "a" }))).code).toBe("validation_failed");
      expect((await rejects(listComments(fx.store, { screen: "home", mockup: "cart-options" }))).code).toBe("validation_failed");
    });

    it("keeps a mockup root within a few tokens of a screen root", async () => {
      const screenRoot = (await list(fx, { screen: "home" }))[0]!;
      const mockupRoot = (await list(fx, { mockup: "cart-options", variant: "a" }))[0]!;
      expect(estimateTokens(mockupRoot) - estimateTokens(screenRoot)).toBeLessThanOrEqual(12);
    });
  });

  describe("detached", () => {
    it("detaches when the id is rewritten away, reattaches when it returns, and spares whole-variant threads", async () => {
      await createAgentComment(fx.store, { mockup: "cart-options", variant: "a", node: "item-1", body: "row" });
      await createAgentComment(fx.store, { mockup: "cart-options", variant: "a", body: "whole" });

      await writeMockup(fx.store, { mockup: "cart-options", variant: "a", mode: "replace", html: `<section id="cart"><li>Tea</li></section>` });
      let roots = await list(fx, { mockup: "cart-options" });
      expect(roots.find((c) => c.body === "row")).toMatchObject({ detached: true });
      expect(roots.find((c) => c.body === "whole")).not.toHaveProperty("detached");
      expect((await list(fx, { status: "detached" })).map((c) => c.body)).toEqual(["row"]);

      await writeMockup(fx.store, { mockup: "cart-options", variant: "a", mode: "replace", html: `<section id="cart"><li id="item-1">Tea</li></section>` });
      roots = await list(fx, { mockup: "cart-options" });
      expect(roots.find((c) => c.body === "row")).not.toHaveProperty("detached");
    });

    it("survives patch_html", async () => {
      await createAgentComment(fx.store, { mockup: "cart-options", variant: "a", node: "item-1", body: "row" });
      await patchHtml(fx.store, {
        target: { kind: "node", node: "mockup:cart-options#a.item-1" },
        operation: "replace",
        html_aug: `<li id="item-1">Green tea</li>`,
      } as never);
      const [root] = await list(fx, { mockup: "cart-options" });
      expect(root).toMatchObject({ node: "mockup:cart-options#a.item-1" });
      expect(root).not.toHaveProperty("detached");
    });

    it("lists the threads of a deleted variant and a deleted mockup as detached, whole-variant ones included", async () => {
      await createAgentComment(fx.store, { mockup: "cart-options", variant: "a", node: "item-1", body: "row" });
      await createAgentComment(fx.store, { mockup: "cart-options", variant: "b", body: "whole b" });

      await deleteMockupEntity(fx.store, "cart-options", "b");
      expect((await list(fx, { status: "detached" })).map((c) => c.body)).toEqual(["whole b"]);

      await deleteMockupEntity(fx.store, "cart-options");
      expect((await list(fx, { status: "detached" })).map((c) => c.body)).toEqual(["row", "whole b"]);
    });

    it("keeps threads on the mockup when a variant is promoted, and gives the screen none", async () => {
      await createAgentComment(fx.store, { mockup: "cart-options", variant: "a", node: "item-1", body: "row" });
      await promoteMockup(fx.store, { mockup: "cart-options", variant: "a", screen: "cart" });
      expect(await list(fx, { screen: "cart" })).toEqual([]);
      expect(await list(fx, { mockup: "cart-options" })).toEqual([expect.objectContaining({ body: "row" })]);
    });

    it("treats a name that cannot address a file as detached instead of reading outside the project", async () => {
      await fx.store.appendComment(JSON.stringify({ ...LINE, id: "cmt_evil", mockup: "..", variant: "x", node_id: "mockup:..#x.a" }));
      expect(await list(fx, { status: "detached" })).toEqual([expect.objectContaining({ id: "cmt_evil", detached: true })]);
    });
  });

  describe("reply_comment", () => {
    it("re-anchors within the mockup, by ref (other variant included) or bare id", async () => {
      const { comment_id } = await createAgentComment(fx.store, { mockup: "cart-options", variant: "a", node: "item-1", body: "row" });

      let res = await replyComment(fx.store, { comment_id, reanchor: "cart" });
      expect(res.node).toBe("mockup:cart-options#a.cart");

      await writeMockup(fx.store, { mockup: "cart-options", variant: "b", mode: "replace", html: `<div id="other">x</div>` });
      res = await replyComment(fx.store, { comment_id, reanchor: "mockup:cart-options#b.other", body: "moved" });
      expect(res.node).toBe("mockup:cart-options#b.other");

      expect(await list(fx, { mockup: "cart-options", variant: "b" })).toEqual([
        expect.objectContaining({ mockup: "cart-options", variant: "b", node: "mockup:cart-options#b.other" }),
      ]);
      expect(await list(fx, { mockup: "cart-options", variant: "a" })).toEqual([]);
    });

    it("refuses a derived id, a screen ref and a re-anchor across kinds", async () => {
      const mock = await createAgentComment(fx.store, { mockup: "cart-options", variant: "a", node: "item-1", body: "row" });
      const screen = await createAgentComment(fx.store, { screen: "home", node: "card-goal", body: "goal" });

      expect((await rejects(replyComment(fx.store, { comment_id: mock.comment_id, reanchor: "n2" }))).code).toBe("not_found");
      expect((await rejects(replyComment(fx.store, { comment_id: mock.comment_id, reanchor: "home.card-goal" }))).code).toBe("validation_failed");
      expect((await rejects(replyComment(fx.store, { comment_id: screen.comment_id, reanchor: "mockup:cart-options#a.item-1" }))).code).toBe("validation_failed");
    });

    it("answers, resolves and reopens a mockup thread like a screen thread", async () => {
      const { comment_id } = await createAgentComment(fx.store, { mockup: "cart-options", variant: "a", node: "item-1", body: "row" });
      await replyComment(fx.store, { comment_id, body: "fixed", resolve: true });
      expect(await list(fx, { mockup: "cart-options" })).toEqual([]);
      const resolved = await list(fx, { mockup: "cart-options", status: "resolved" });
      expect(resolved[0]).toMatchObject({ mockup: "cart-options", variant: "a", status: "resolved", node: "mockup:cart-options#a.item-1" });
      await replyComment(fx.store, { comment_id, reopen: true });
      expect(await list(fx, { mockup: "cart-options" })).toHaveLength(1);
    });
  });

  describe("the browser's createComment / applyThreadAction", () => {
    it("starts a mockup root and a reply that inherits the thread", async () => {
      const root = await createComment(fx.store, { mockup: "cart-options", variant: "a", node_id: "item-1", text: "heavy" });
      expect(root).toMatchObject({ mockup: "cart-options", variant: "a", node_id: "mockup:cart-options#a.item-1", author: "human" });
      expect(root).not.toHaveProperty("screen");
      const reply = await createComment(fx.store, { screen: "ignored", parent_id: root.id, text: "still" });
      expect(reply).toMatchObject({ mockup: "cart-options", variant: "a", node_id: "mockup:cart-options#a.item-1", parent_id: root.id });
      expect(reply).not.toHaveProperty("screen");
    });

    it("re-anchors a mockup thread and refuses a screen anchor", async () => {
      const root = await createComment(fx.store, { mockup: "cart-options", variant: "a", node_id: "item-1", text: "heavy" });
      await applyThreadAction(fx.store, { comment_id: root.id, action: "reanchor", anchor: { mockup: "cart-options", variant: "a", node_id: "mockup:cart-options#a.cart" } });
      expect((await list(fx))[0]).toMatchObject({ node: "mockup:cart-options#a.cart" });
      const err = await rejects(applyThreadAction(fx.store, { comment_id: root.id, action: "reanchor", anchor: { screen: "home", node_id: "home.card-goal" } }));
      expect(err.code).toBe("validation_failed");
    });
  });

  describe("counts", () => {
    beforeEach(async () => {
      await createAgentComment(fx.store, { screen: "home", node: "card-goal", body: "screen" });
      await createAgentComment(fx.store, { mockup: "cart-options", variant: "a", node: "item-1", body: "one" });
      await createAgentComment(fx.store, { mockup: "cart-options", variant: "a", body: "two" });
    });

    it("get_project counts screen and mockup threads in the summary, and the mockup only when it has some", async () => {
      expect((await getProject(fx.store, {})).open_comment_count).toBe(3);
      await writeMockup(fx.store, { mockup: "quiet", variant: "a", mode: "create", html: `<p>x</p>` });
      const tree = await getProject(fx.store, { view: "tree" });
      expect(tree.mockups).toEqual([
        { mockup: "cart-options", variant_count: 2, tags: [], open_comment_count: 2 },
        { mockup: "quiet", variant_count: 1, tags: [] },
      ]);
      expect((tree.screens as Array<{ open_comment_count: number }>)[0]!.open_comment_count).toBe(1);
    });

    it("get_mockup carries the count per variant, omitted at 0, in both views", async () => {
      const summary = (await getMockup(fx.store, { mockup: "cart-options" })).variants as Array<Record<string, unknown>>;
      expect(summary.map((v) => v.open_comment_count)).toEqual([2, undefined]);
      expect(summary[1]).not.toHaveProperty("open_comment_count");
      const full = (await getMockup(fx.store, { mockup: "cart-options", view: "full" })).variants as Array<Record<string, unknown>>;
      expect(full[0]).toMatchObject({ open_comment_count: 2 });
      expect(full[1]).not.toHaveProperty("open_comment_count");

      const [first] = await list(fx, { mockup: "cart-options" });
      await replyComment(fx.store, { comment_id: first!.id, resolve: true });
      expect(((await getMockup(fx.store, { mockup: "cart-options" })).variants as Array<Record<string, unknown>>)[0]).toMatchObject({ open_comment_count: 1 });
    });

    it("leaves get_screen and find_nodes has_comments on screens", async () => {
      const found = await findNodes(fx.store, { where: [{ kind: "has_comments" }] });
      expect((found.nodes as Array<{ node: string }>).map((n) => n.node)).toEqual(["home.card-goal"]);
    });
  });
});
