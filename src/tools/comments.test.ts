import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { replyComment, createComment, generateCommentId, readCommentRecordsWithStats } from "./comments.js";
import { listComments, getProject, getScreen } from "./reads.js";
import { ToolError } from "./types.js";

describe("generateCommentId", () => {
  it("has enough entropy that ~200 ids don't collide", () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateCommentId()));
    expect(ids.size).toBe(200);
    expect(generateCommentId()).toMatch(/^cmt_[0-9a-f]{16}$/);
  });
});

describe("readCommentRecordsWithStats", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  it("skips an unparsable line instead of throwing, and counts it — comments.jsonl is human-editable by design, one bad line must not take down the whole tool layer", async () => {
    await fx.store.appendComment(
      JSON.stringify({ id: "cmt_ok", parent_id: null, screen: "home", node_id: null, author: "human", text: "fine", resolved: false, ts: "2026-01-01T00:00:00.000Z" }),
    );
    await fx.store.appendComment("{ not: valid json");

    const { records, skippedMalformedLines } = await readCommentRecordsWithStats(fx.store);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe("cmt_ok");
    expect(skippedMalformedLines).toBe(1);
  });

  it("get_project/get_screen don't 500 when comments.jsonl has a malformed line", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    await fx.store.appendComment("this is not json");

    await expect(getProject(fx.store, { view: "tree" })).resolves.toBeTruthy();
    await expect(getScreen(fx.store, { screen: "home" })).resolves.toBeTruthy();
  });
});

describe("reply_comment", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.appendComment(
      JSON.stringify({
        id: "cmt_a1",
        parent_id: null,
        screen: "home",
        node_id: "home.n1",
        author: "human",
        text: "please fix the color",
        resolved: false,
        ts: "2026-01-01T00:00:00.000Z",
      }),
    );
  });
  afterEach(() => fx.cleanup());

  it("appends a reply and leaves the thread open by default", async () => {
    const res = await replyComment(fx.store, { comment_id: "cmt_a1", body: "on it" });
    expect(res.comment_id).toBe("cmt_a1");
    expect(res.status).toBe("open");
    expect(res.path).toBe("comments.jsonl");

    const list = await listComments(fx.store, { status: "any", include_replies: true });
    const comments = list.comments as Array<{ id: string; body: string; author: string }>;
    expect(comments).toHaveLength(2);
    expect(comments[1]).toMatchObject({ body: "on it", author: "agent" });
  });

  it("resolves the thread when resolve is true", async () => {
    const res = await replyComment(fx.store, { comment_id: "cmt_a1", body: "fixed", resolve: true });
    expect(res.status).toBe("resolved");

    const openList = await listComments(fx.store, { status: "open" });
    expect(openList.comments).toEqual([]);
  });

  it("throws not_found for an unknown comment id", async () => {
    await expect(replyComment(fx.store, { comment_id: "cmt_missing", body: "x" })).rejects.toThrow(ToolError);
  });

  // list_comments hands an agent reply ids just as readily as root
  // ids, so rejecting one of them splits the id space between the two tools.
  it("accepts a reply's id and attaches the answer to that reply's thread root", async () => {
    await fx.store.appendComment(
      JSON.stringify({
        id: "cmt_a2",
        parent_id: "cmt_a1",
        screen: "home",
        node_id: "home.n1",
        author: "human",
        text: "and the spacing too",
        resolved: false,
        ts: "2026-01-01T00:01:00.000Z",
      }),
    );

    const res = await replyComment(fx.store, { comment_id: "cmt_a2", body: "on both" });
    expect(res.comment_id).toBe("cmt_a1");

    const list = await listComments(fx.store, { status: "any", include_replies: true });
    const comments = list.comments as Array<{ id: string; parent_id: string | null; body: string }>;
    expect(comments).toHaveLength(3);
    expect(comments[2]).toMatchObject({ parent_id: "cmt_a1", body: "on both" });
  });

  it("resolves the whole thread when given a reply's id and resolve: true", async () => {
    await fx.store.appendComment(
      JSON.stringify({
        id: "cmt_a2",
        parent_id: "cmt_a1",
        screen: "home",
        node_id: "home.n1",
        author: "human",
        text: "and the spacing too",
        resolved: false,
        ts: "2026-01-01T00:01:00.000Z",
      }),
    );

    const res = await replyComment(fx.store, { comment_id: "cmt_a2", body: "done", resolve: true });
    expect(res).toMatchObject({ comment_id: "cmt_a1", status: "resolved" });
    expect((await listComments(fx.store, { status: "open" })).comments).toEqual([]);
  });
});

describe("createComment", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await fx.store.writeScreen("home", `<div id="n1"><button id="n2"></button></div>`);
  });
  afterEach(() => fx.cleanup());

  it("creates an open root comment anchored to a node, authored by the human", async () => {
    const comment = await createComment(fx.store, { screen: "home", node_id: "n2", text: "make this bigger" });

    expect(comment).toMatchObject({
      parent_id: null,
      screen: "home",
      node_id: "home.n2",
      author: "human",
      text: "make this bigger",
      resolved: false,
      reply_count: 0,
    });
    expect(comment.id).toMatch(/^cmt_[0-9a-f]{16}$/);
    expect(typeof comment.ts).toBe("string");
  });

  it("allows a screen-level comment with no node", async () => {
    const comment = await createComment(fx.store, { screen: "home", text: "overall looks off" });
    expect(comment.node_id).toBeNull();
  });

  it("a human can resolve their own comment on creation", async () => {
    const comment = await createComment(fx.store, { screen: "home", text: "never mind", resolved: true });
    expect(comment.resolved).toBe(true);
  });

  it("a human can reply to an existing thread via parent_id, inheriting its screen/node", async () => {
    const root = await createComment(fx.store, { screen: "home", node_id: "n2", text: "make this bigger" });
    const reply = await createComment(fx.store, { screen: "ignored", node_id: "ignored", parent_id: root.id, text: "still waiting" });

    expect(reply.parent_id).toBe(root.id);
    expect(reply.screen).toBe("home");
    expect(reply.node_id).toBe("home.n2");

    const list = await listComments(fx.store, { node: "home.n2", include_replies: true });
    expect((list.comments as Array<{ id: string; body: string }>).map((c) => c.body)).toEqual(["make this bigger", "still waiting"]);
  });

  it("throws not_found when replying to a comment id that doesn't exist", async () => {
    await expect(createComment(fx.store, { screen: "home", parent_id: "cmt_missing", text: "x" })).rejects.toThrow(ToolError);
  });

  // Threading is one level deep. A record pointing at a non-root
  // parent is dropped as an orphan by groupThreads, so answering a reply has
  // to re-target the thread root or the comment vanishes from every read.
  it("flattens a reply-to-a-reply onto the thread root instead of nesting it", async () => {
    const root = await createComment(fx.store, { screen: "home", node_id: "n2", text: "make this bigger" });
    const first = await createComment(fx.store, { screen: "home", parent_id: root.id, text: "still waiting" });
    const second = await createComment(fx.store, { screen: "home", parent_id: first.id, text: "any update?" });

    expect(second.parent_id).toBe(root.id);

    const list = await listComments(fx.store, { node: "home.n2", include_replies: true });
    expect((list.comments as Array<{ body: string }>).map((c) => c.body)).toEqual(["make this bigger", "still waiting", "any update?"]);
  });

  it("is readable via list_comments right after creation (the round-trip the acceptance criterion depends on)", async () => {
    const comment = await createComment(fx.store, { screen: "home", node_id: "n2", text: "make this bigger" });
    const list = await listComments(fx.store, { node: "home.n2" });
    expect((list.comments as Array<{ id: string }>).map((c) => c.id)).toEqual([comment.id]);
  });

  it("bumps open_comment_count on get_project (project-wide and per-screen) and get_screen so the agent notices without polling list_comments", async () => {
    await createComment(fx.store, { screen: "home", node_id: "n2", text: "x" });

    const project = await getProject(fx.store, { view: "tree" });
    expect(project.open_comment_count).toBe(1);
    const screens = project.screens as Array<{ screen: string; open_comment_count: number }>;
    expect(screens.find((s) => s.screen === "home")?.open_comment_count).toBe(1);

    const screen = await getScreen(fx.store, { screen: "home" });
    expect(screen.open_comment_count).toBe(1);
  });

  it("an agent can reply to and resolve a human-created comment", async () => {
    const comment = await createComment(fx.store, { screen: "home", node_id: "n2", text: "make this bigger" });
    const reply = await replyComment(fx.store, { comment_id: comment.id, body: "done", resolve: true });
    expect(reply.status).toBe("resolved");

    const project = await getProject(fx.store, {});
    expect(project.open_comment_count).toBe(0);
  });
});
