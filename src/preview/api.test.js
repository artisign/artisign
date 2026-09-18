// CHR-651: every project-scoped call in this module must carry the caller's
// own `project` explicitly on the request URL — never rely on the daemon's
// active-project fallback (a real gap with two tabs open on different
// projects). Same idiom as sse.test.js's "includes ?project= in the URL"
// test for connectEvents — one assertion per wrapper on the exact URL
// `fetch` was called with, so a wrapper later reworked to drop the
// parameter fails here, not just in review.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  fetchScreens,
  fetchRender,
  fetchMockups,
  fetchMockupRender,
  fetchTags,
  fetchFlows,
  fetchDesignSystem,
  fetchComments,
  fetchScreenNodes,
  postComment,
  fetchBoardState,
  setBoardState,
  fetchProjects,
  openProject,
  initProject,
  activateProject,
  fetchFsDirs,
} from "./api.js";

const PROJECT = "/Users/example/my-project";
const P = encodeURIComponent(PROJECT);

function okJson(body = {}) {
  return { ok: true, json: async () => body, text: async () => "" };
}

describe("api.js project scoping (CHR-651)", () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it("fetchScreens", async () => {
    globalThis.fetch = vi.fn(async () => okJson({ screens: [] }));
    await fetchScreens(PROJECT);
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/screens?project=${P}`);
  });

  it("fetchRender", async () => {
    globalThis.fetch = vi.fn(async () => okJson());
    await fetchRender("home", PROJECT);
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/render/home?project=${P}`);
  });

  it("fetchMockups", async () => {
    globalThis.fetch = vi.fn(async () => okJson({ mockups: [] }));
    await fetchMockups(PROJECT);
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/mockups?project=${P}`);
  });

  it("fetchMockupRender", async () => {
    globalThis.fetch = vi.fn(async () => okJson());
    await fetchMockupRender("checkout", "v1", PROJECT);
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/render/mockup/checkout/v1?project=${P}`);
  });

  it("fetchTags", async () => {
    globalThis.fetch = vi.fn(async () => okJson({ tags: [] }));
    await fetchTags(PROJECT);
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/tags?project=${P}`);
  });

  it("fetchFlows", async () => {
    globalThis.fetch = vi.fn(async () => okJson({ flows: [] }));
    await fetchFlows(PROJECT);
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/flows?project=${P}`);
  });

  it("fetchDesignSystem", async () => {
    globalThis.fetch = vi.fn(async () => okJson({}));
    await fetchDesignSystem(PROJECT);
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/design-system?project=${P}`);
  });

  it("fetchComments", async () => {
    globalThis.fetch = vi.fn(async () => okJson({ comments: [] }));
    await fetchComments("home", PROJECT);
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/comments?screen=home&project=${P}`);
  });

  it("fetchScreenNodes", async () => {
    globalThis.fetch = vi.fn(async () => okJson({ nodes: [] }));
    await fetchScreenNodes("home", PROJECT);
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/tools/get_screen?project=${P}`, expect.objectContaining({ method: "POST" }));
  });

  it("postComment", async () => {
    globalThis.fetch = vi.fn(async () => okJson());
    await postComment({ screen: "home", node_id: null, text: "hi" }, PROJECT);
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/comments?project=${P}`, expect.objectContaining({ method: "POST" }));
  });

  it("fetchBoardState", async () => {
    globalThis.fetch = vi.fn(async () => okJson({ filter: null, pinned: [] }));
    await fetchBoardState(PROJECT);
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/board-state?project=${P}`);
  });

  it("setBoardState", async () => {
    globalThis.fetch = vi.fn(async () => okJson());
    await setBoardState(PROJECT, { filter: "x" });
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/tools/set_board_state?project=${P}`, expect.objectContaining({ method: "POST" }));
  });

  // Registry calls — daemon-wide by nature (they work with zero projects
  // open), correctly carry no `?project=` at all.
  it("fetchProjects carries no ?project=", async () => {
    globalThis.fetch = vi.fn(async () => okJson({ active: null, open: [], recent: [] }));
    await fetchProjects();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/projects");
  });

  it("openProject carries no ?project=", async () => {
    globalThis.fetch = vi.fn(async () => okJson({}));
    await openProject("/tmp/some-dir");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/projects/open", expect.objectContaining({ method: "POST" }));
  });

  it("initProject carries no ?project=", async () => {
    globalThis.fetch = vi.fn(async () => okJson({}));
    await initProject("/tmp/some-dir");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/projects/init", expect.objectContaining({ method: "POST" }));
  });

  it("activateProject carries no ?project=", async () => {
    globalThis.fetch = vi.fn(async () => okJson({}));
    await activateProject("/tmp/some-dir");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/projects/activate", expect.objectContaining({ method: "POST" }));
  });

  it("fetchFsDirs carries no ?project=", async () => {
    globalThis.fetch = vi.fn(async () => okJson({ path: "/", parent: null, entries: [], home: "/" }));
    await fetchFsDirs();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/fs/dirs");
  });
});
