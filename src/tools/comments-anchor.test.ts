import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, estimateTokens, type ProjectFixture } from "./test-fixtures.js";
import { applyThreadAction, createAgentComment, createComment, replyComment } from "./comments.js";
import { findNodes, listComments } from "./reads.js";
import { ToolError } from "./types.js";

type Listed = {
  id: string;
  screen: string;
  node: string | null;
  detached?: boolean;
  status: string;
  author: string;
  agent?: string;
  body: string;
};

async function list(
  fx: ProjectFixture,
  input: Parameters<typeof listComments>[1] = {},
): Promise<Listed[]> {
  return (await listComments(fx.store, input)).comments as Listed[];
}

// CHR-1249 / CHR-1254 — threads anchor to a node id, detach instead of vanishing, and can be moved.
describe("comment anchors", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen(
      "home",
      `<div id="root"><p id="card-goal">Goal</p><p id="card-trigger">Trigger</p></div>`,
    );
  });
  afterEach(() => fx.cleanup());

  it("lists screen, node, author kind and agent identity per thread", async () => {
    await createComment(fx.store, { screen: "home", node_id: "card-goal", text: "clamp it" });
    await createAgentComment(fx.store, {
      screen: "home",
      node: "card-trigger",
      body: "copy too long",
      agent: "ux-agent",
    });

    const threads = await list(fx);
    expect(threads).toHaveLength(2);
    expect(threads[0]).toMatchObject({
      screen: "home",
      node: "home.card-goal",
      author: "human",
      status: "open",
    });
    expect(threads[0]).not.toHaveProperty("agent");
    expect(threads[0]).not.toHaveProperty("detached");
    expect(threads[1]).toMatchObject({
      screen: "home",
      node: "home.card-trigger",
      author: "agent",
      agent: "ux-agent",
    });
  });

  it("keeps a legacy thread without node id working as a screen-level thread", async () => {
    await fx.store.appendComment(
      JSON.stringify({
        id: "cmt_old",
        parent_id: null,
        screen: "home",
        node_id: null,
        author: "human",
        text: "old",
        resolved: false,
        ts: "2026-01-01T00:00:00.000Z",
      }),
    );
    const [thread] = await list(fx);
    expect(thread).toMatchObject({ id: "cmt_old", node: null, status: "open" });
    expect(thread).not.toHaveProperty("detached");
  });

  it("marks a thread detached when a later write removes its node, and never drops it", async () => {
    await createComment(fx.store, { screen: "home", node_id: "card-goal", text: "clamp it" });
    await fx.store.writeScreen("home", `<div id="root"><p id="card-trigger">Trigger</p></div>`);

    const [thread] = await list(fx);
    expect(thread).toMatchObject({ node: "home.card-goal", detached: true, status: "open" });
    expect(await list(fx, { status: "detached" })).toHaveLength(1);

    // The node comes back: attached again (detached is derived on read, never stored).
    await fx.store.writeScreen("home", `<div id="root"><p id="card-goal">Goal</p></div>`);
    expect((await list(fx))[0]).not.toHaveProperty("detached");
    expect(await list(fx, { status: "detached" })).toHaveLength(0);
  });

  it("marks threads detached when their whole screen is gone", async () => {
    await createComment(fx.store, { screen: "home", node_id: "card-goal", text: "clamp it" });
    await fx.store.deleteScreen("home");
    expect((await list(fx))[0]).toMatchObject({ detached: true });
  });

  it("re-anchors a detached thread with reply_comment, by ref or bare id", async () => {
    const created = await createComment(fx.store, {
      screen: "home",
      node_id: "card-goal",
      text: "clamp it",
    });
    await fx.store.writeScreen("home", `<div id="root"><p id="goal-text">Goal</p></div>`);

    const res = await replyComment(
      fx.store,
      { comment_id: created.id, reanchor: "goal-text" },
      "claude-code",
    );
    expect(res.node).toBe("home.goal-text");
    expect(res).not.toHaveProperty("reply_id");

    const [thread] = await list(fx, { include_replies: true });
    expect(thread).toMatchObject({ node: "home.goal-text", status: "open", reply_count: 0 });
    expect(thread).not.toHaveProperty("detached");
    // has_comments follows the new anchor.
    const found = await findNodes(fx.store, { where: [{ kind: "has_comments" }] });
    expect((found.nodes as { node: string }[]).map((m) => m.node)).toEqual(["home.goal-text"]);
  });

  it("refuses to re-anchor to a node that does not exist", async () => {
    const created = await createComment(fx.store, {
      screen: "home",
      node_id: "card-goal",
      text: "clamp it",
    });
    await expect(
      replyComment(fx.store, { comment_id: created.id, reanchor: "home.nope" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("resolves without words, then reopens", async () => {
    const created = await createComment(fx.store, {
      screen: "home",
      node_id: "card-goal",
      text: "clamp it",
    });
    expect((await replyComment(fx.store, { comment_id: created.id, resolve: true })).status).toBe(
      "resolved",
    );
    expect(await list(fx)).toHaveLength(0);
    expect(
      (await list(fx, { status: "resolved", include_replies: true })).map((c) => c.body),
    ).toEqual(["clamp it"]);

    expect((await replyComment(fx.store, { comment_id: created.id, reopen: true })).status).toBe(
      "open",
    );
    expect(await list(fx)).toHaveLength(1);
  });

  it("rejects a call with nothing to do, and resolve together with reopen", async () => {
    const created = await createComment(fx.store, {
      screen: "home",
      node_id: "card-goal",
      text: "clamp it",
    });
    await expect(replyComment(fx.store, { comment_id: created.id })).rejects.toBeInstanceOf(
      ToolError,
    );
    await expect(
      replyComment(fx.store, { comment_id: created.id, resolve: true, reopen: true }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it("stores the agent identity on replies, defaulting to the MCP client name", async () => {
    const created = await createComment(fx.store, {
      screen: "home",
      node_id: "card-goal",
      text: "clamp it",
    });
    await replyComment(fx.store, { comment_id: created.id, body: "done" }, "claude-code");
    await replyComment(
      fx.store,
      { comment_id: created.id, body: "and more", agent: "ux-agent" },
      "claude-code",
    );
    const replies = (await list(fx, { include_replies: true })).slice(1);
    expect(replies.map((r) => r.agent)).toEqual(["claude-code", "ux-agent"]);
  });

  it("deletes a thread from every read with a delete event, keeping the log", async () => {
    const created = await createComment(fx.store, {
      screen: "home",
      node_id: "card-goal",
      text: "clamp it",
    });
    await applyThreadAction(fx.store, { comment_id: created.id, action: "delete" });
    expect(await list(fx, { status: "any" })).toHaveLength(0);
    expect((await fx.store.readComments()).length).toBe(2);
  });

  it("create_comment validates the node and accepts a screen-level thread", async () => {
    await expect(
      createAgentComment(fx.store, { screen: "home", node: "missing", body: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(createAgentComment(fx.store, { screen: "nope", body: "x" })).rejects.toMatchObject(
      { code: "not_found" },
    );
    const res = await createAgentComment(fx.store, { screen: "home", body: "whole screen" });
    expect(res).toMatchObject({ screen: "home", node: null, status: "open" });
  });

  it("stays within the comment tools' token budget for a screen with 20 threads", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `node-${i}`);
    await fx.store.writeScreen(
      "home",
      `<div id="root">${ids.map((id) => `<p id="${id}">x</p>`).join("")}</div>`,
    );
    for (const [i, id] of ids.entries()) {
      if (i % 2 === 0)
        await createComment(fx.store, {
          screen: "home",
          node_id: id,
          text: "Goal text wraps to four lines at 1280 px. Clamp it to two lines?",
        });
      else
        await createAgentComment(fx.store, {
          screen: "home",
          node: id,
          body: "Done as a proposal: 2-line clamp plus More. See P-14.",
          agent: "ux-agent",
        });
    }
    const res = await listComments(fx.store, { screen: "home" });
    expect((res.comments as unknown[]).length).toBe(20);
    expect(estimateTokens(res)).toBeLessThanOrEqual(1_600);
  });
});
