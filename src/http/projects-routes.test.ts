import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/init-project.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";
import { FsStore } from "../store/index.js";

async function getJson(port: number, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function postJson(port: number, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("/api/projects*", () => {
  let dir: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle | undefined;
  let scratch: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-projects-api-"));
    await initProject(dir);
    artisignHome = await setupArtisignHome();
    scratch = [];
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await artisignHome.cleanup();
    await rm(dir, { recursive: true, force: true });
    await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("GET /api/projects returns {active, open, recent}", async () => {
    daemon = await startDaemon({ port: 0, projects: [dir] });

    const { status, json } = await getJson(daemon.port, "/api/projects");

    expect(status).toBe(200);
    expect(json.active).toBe(dir);
    expect(json.open).toEqual([{ root: dir, name: expect.any(String) }]);
    expect(json.recent).toContain(dir);
  });

  it("GET /api/projects never 500s even when a directory in recentProjects has an invalid artisign.json", async () => {
    const broken = await mkdtemp(join(tmpdir(), "artisign-projects-broken-"));
    scratch.push(broken);
    await initProject(broken);
    await writeFile(join(broken, "artisign.json"), "null");
    daemon = await startDaemon({ port: 0, projects: [dir] });

    // open()ing the broken project must be refused cleanly, not silently
    // added to the registry, and never crash the daemon.
    await expect(postJson(daemon.port, "/api/projects/open", { dir: broken })).resolves.toMatchObject({ status: 400 });

    const { status, json } = await getJson(daemon.port, "/api/projects");
    expect(status).toBe(200);
    expect((json.open as Array<{ root: string }>).map((p) => p.root)).not.toContain(broken);
  });

  it("GET /api/projects still returns correctly when an open project's artisign.json becomes invalid after opening", async () => {
    daemon = await startDaemon({ port: 0, projects: [dir] });
    const before = await getJson(daemon.port, "/api/projects");
    const nameBefore = (before.json.open as Array<{ root: string; name: string }>).find((p) => p.root === dir)?.name;

    await writeFile(join(dir, "artisign.json"), "not json");
    // Let the debounced watcher's re-read attempt (and its swallowed
    // failure) run before asserting — same debounce window used elsewhere.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const { status, json } = await getJson(daemon.port, "/api/projects");
    expect(status).toBe(200);
    expect((json.open as Array<{ root: string; name: string }>).find((p) => p.root === dir)?.name).toBe(nameBefore);
  });

  it("GET /api/projects evicts a project whose directory was deleted, never 500s", async () => {
    const fresh = join(await mkdtemp(join(tmpdir(), "artisign-projects-evict-")), "new-project");
    scratch.push(fresh);
    daemon = await startDaemon({ port: 0, projects: [dir] });

    await postJson(daemon.port, "/api/projects/init", { dir: fresh });
    expect((await getJson(daemon.port, "/api/projects")).json.active).toBe(fresh);

    await rm(fresh, { recursive: true, force: true });

    // Poll rather than a fixed sleep — same 4000ms budget as the sibling
    // eviction tests in src/daemon/project-registry.test.ts. A fixed
    // 400ms only just covers watcher debounce (100ms) + readArtisignConfig +
    // evict() -> close() -> index.stop() on an idle test, and is flaky
    // under a loaded CI runner or a rebuild still in flight.
    const start = Date.now();
    let status = 0;
    let json: Record<string, unknown> = {};
    while (Date.now() - start < 4000) {
      ({ status, json } = await getJson(daemon.port, "/api/projects"));
      expect(status).toBe(200);
      if (!(json.open as Array<{ root: string }>).map((p) => p.root).includes(fresh)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect((json.open as Array<{ root: string }>).map((p) => p.root)).not.toContain(fresh);
    expect(json.active).toBe(dir);
  }, 10000);

  it("works with zero projects open: active is null, open is empty", async () => {
    daemon = await startDaemon({ port: 0 });

    const { status, json } = await getJson(daemon.port, "/api/projects");

    expect(status).toBe(200);
    expect(json).toEqual({ active: null, open: [], recent: [] });
  });

  it("POST /api/projects/open opens and activates an existing project", async () => {
    const other = await mkdtemp(join(tmpdir(), "artisign-projects-open-"));
    scratch.push(other);
    await initProject(other);
    daemon = await startDaemon({ port: 0, projects: [dir] });

    const { status, json } = await postJson(daemon.port, "/api/projects/open", { dir: other });

    expect(status).toBe(200);
    expect(json.active).toBe(other);
    expect((json.open as Array<{ root: string }>).map((p) => p.root).sort()).toEqual([dir, other].sort());
  });

  it("POST /api/projects/open 400s for a directory that isn't a project", async () => {
    const notAProject = await mkdtemp(join(tmpdir(), "artisign-projects-invalid-"));
    scratch.push(notAProject);
    daemon = await startDaemon({ port: 0, projects: [dir] });

    const { status, json } = await postJson(daemon.port, "/api/projects/open", { dir: notAProject });

    expect(status).toBe(400);
    expect(json.code).toBe("validation_failed");
    expect(json.message).toContain(notAProject);
  });

  it("POST /api/projects/init scaffolds, opens and activates a new project", async () => {
    const fresh = join(await mkdtemp(join(tmpdir(), "artisign-projects-init-")), "new-project");
    scratch.push(fresh);
    daemon = await startDaemon({ port: 0, projects: [dir] });

    const { status, json } = await postJson(daemon.port, "/api/projects/init", { dir: fresh, name: "My New Project" });

    expect(status).toBe(200);
    expect(json.active).toBe(fresh);
    await expect(access(join(fresh, "artisign.json"))).resolves.toBeUndefined();
    expect((json.open as Array<{ root: string; name: string }>).find((p) => p.root === fresh)?.name).toBe(
      "My New Project",
    );
  });

  it("POST /api/projects/init produces a project identical to init_project's own scaffold, git commit included", async () => {
    const fresh = join(await mkdtemp(join(tmpdir(), "artisign-projects-init-commit-")), "new-project");
    scratch.push(fresh);
    daemon = await startDaemon({ port: 0, projects: [dir] });

    const { status } = await postJson(daemon.port, "/api/projects/init", { dir: fresh });
    expect(status).toBe(200);

    const store = new FsStore(fresh);
    // initProjectTool's own scaffold list (artisign.json, tokens.json, flows.json,
    // comments.jsonl, .gitignore) — every one of these must exist exactly
    // the way an agent's init_project call would produce it.
    await expect(access(join(fresh, "artisign.json"))).resolves.toBeUndefined();
    await expect(access(join(fresh, "design-system", "tokens.json"))).resolves.toBeUndefined();
    await expect(access(join(fresh, "flows.json"))).resolves.toBeUndefined();
    await expect(access(join(fresh, "comments.jsonl"))).resolves.toBeUndefined();
    await expect(access(join(fresh, ".gitignore"))).resolves.toBeUndefined();
    const head = await store.headCommit();
    expect(head.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("POST /api/projects/init returns a structured error (not an opaque 500) when the scaffold fails", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "artisign-projects-init-fail-"));
    scratch.push(fresh);
    // Pre-create "design-system" as a plain file so init's
    // mkdir("design-system/components", { recursive: true }) fails with
    // ENOTDIR — a stand-in for any scaffold-step I/O failure.
    await writeFile(join(fresh, "design-system"), "");
    daemon = await startDaemon({ port: 0, projects: [dir] });

    const { status, json } = await postJson(daemon.port, "/api/projects/init", { dir: fresh });

    expect(status).toBe(500);
    expect(json.code).toBe("io_error");
    // Must carry the actual failure, not failSafe's generic fallback text.
    expect(json.message).not.toBe("internal server error");
    expect(json.message).toMatch(/ENOTDIR|design-system/i);
    // The failed scaffold must not have become the active project.
    const list = await getJson(daemon.port, "/api/projects");
    expect(list.json.active).toBe(dir);
    expect((list.json.open as Array<{ root: string }>).map((p) => p.root)).not.toContain(fresh);
  });

  it("POST /api/projects/init 409s when artisign.json already exists at dir", async () => {
    daemon = await startDaemon({ port: 0, projects: [dir] });

    const { status, json } = await postJson(daemon.port, "/api/projects/init", { dir });

    expect(status).toBe(409);
    expect(json.code).toBe("conflict");
  });

  it("POST /api/projects/activate switches the active project", async () => {
    const other = await mkdtemp(join(tmpdir(), "artisign-projects-activate-"));
    scratch.push(other);
    await initProject(other);
    daemon = await startDaemon({ port: 0, projects: [dir, other] });
    expect((await getJson(daemon.port, "/api/projects")).json.active).toBe(dir);

    const { status, json } = await postJson(daemon.port, "/api/projects/activate", { root: other });

    expect(status).toBe(200);
    expect(json.active).toBe(other);
  });

  it("POST /api/projects/activate 400s for a project that isn't open", async () => {
    const notOpen = await mkdtemp(join(tmpdir(), "artisign-projects-not-open-"));
    scratch.push(notOpen);
    await initProject(notOpen);
    daemon = await startDaemon({ port: 0, projects: [dir] });

    const { status, json } = await postJson(daemon.port, "/api/projects/activate", { root: notOpen });

    expect(status).toBe(400);
    expect(json.code).toBe("validation_failed");
  });

  it("rejects a cross-origin request to /api/projects", async () => {
    daemon = await startDaemon({ port: 0, projects: [dir] });

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/projects`, {
      headers: { origin: "https://evil.example" },
    });

    expect(res.status).toBe(403);
  });

  it("the init_project tool (called via /api/tools/*) registers the new project without a daemon restart", async () => {
    const fresh = join(await mkdtemp(join(tmpdir(), "artisign-projects-init-tool-")), "agent-created");
    scratch.push(fresh);
    daemon = await startDaemon({ port: 0, projects: [dir] });

    const toolRes = await postJson(daemon.port, "/api/tools/init_project", { dir: fresh, seed: { kind: "empty" } });
    expect(toolRes.status).toBe(200);

    const { json } = await getJson(daemon.port, "/api/projects");
    expect((json.open as Array<{ root: string }>).map((p) => p.root)).toContain(fresh);
  });
});
