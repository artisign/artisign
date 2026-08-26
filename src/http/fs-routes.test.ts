import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/init-project.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";

async function getJson(port: number, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/fs/dirs", () => {
  let root: string;
  let dir: string;
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "artisign-fs-dirs-"));
    dir = await mkdtemp(join(tmpdir(), "artisign-fs-dirs-project-"));
    await initProject(dir);
    artisignHome = await setupArtisignHome();
    daemon = await startDaemon({ port: 0, projects: [dir] });
  });

  afterEach(async () => {
    await daemon.stop();
    await artisignHome.cleanup();
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  it("lists directories, badges the one containing artisign.json, and skips hidden dirs and files", async () => {
    await mkdir(join(root, "plain-folder"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "a-file.txt"), "x");
    const project = join(root, "a-project");
    await mkdir(project);
    await writeFile(join(project, "artisign.json"), "{}");

    const { status, json } = await getJson(daemon.port, `/api/fs/dirs?path=${encodeURIComponent(root)}`);

    expect(status).toBe(200);
    expect(json.path).toBe(root);
    expect(json.home).toEqual(expect.any(String));
    const entries = json.entries as { name: string; path: string; isArtisignProject: boolean }[];
    expect(entries.map((e) => e.name)).toEqual(["a-project", "plain-folder"]);
    expect(entries.find((e) => e.name === "a-project")).toEqual({
      name: "a-project",
      path: project,
      isArtisignProject: true,
    });
    expect(entries.find((e) => e.name === "plain-folder")?.isArtisignProject).toBe(false);
  });

  it("follows symlinked directories, badges them, and ignores link cycles and file links", async () => {
    const target = join(root, "target");
    await mkdir(target);
    await writeFile(join(target, "artisign.json"), "{}");
    await writeFile(join(root, "a-file.txt"), "x");
    await symlink(target, join(root, "linked-project"));
    await symlink(join(root, "a-file.txt"), join(root, "link-to-file"));
    // A self-referential link: `stat` rejects with ELOOP rather than hanging.
    await symlink(join(root, "loop"), join(root, "loop"));

    const { status, json } = await getJson(daemon.port, `/api/fs/dirs?path=${encodeURIComponent(root)}`);

    expect(status).toBe(200);
    const entries = json.entries as { name: string; path: string; isArtisignProject: boolean }[];
    expect(entries.map((e) => e.name)).toEqual(["linked-project", "target"]);
    // The link is followed for the artisign.json probe too, so it browses
    // like the real directory — that is the whole point of the workaround it
    // enables.
    expect(entries.find((e) => e.name === "linked-project")?.isArtisignProject).toBe(true);
  });

  it("400s for a relative path", async () => {
    const { status, json } = await getJson(daemon.port, "/api/fs/dirs?path=relative/dir");

    expect(status).toBe(400);
    expect(json.code).toBe("validation_failed");
  });

  it("defaults to the home directory when path is omitted", async () => {
    const { status, json } = await getJson(daemon.port, "/api/fs/dirs");

    expect(status).toBe(200);
    expect(json.path).toBe(json.home);
  });

  it("404s for a nonexistent directory", async () => {
    const { status, json } = await getJson(daemon.port, `/api/fs/dirs?path=${encodeURIComponent(join(root, "nope"))}`);

    expect(status).toBe(404);
    expect(json.code).toBe("not_found");
  });

  it("404s when path is a file, not a directory", async () => {
    const file = join(root, "a-file.txt");
    await writeFile(file, "x");

    const { status, json } = await getJson(daemon.port, `/api/fs/dirs?path=${encodeURIComponent(file)}`);

    expect(status).toBe(404);
    expect(json.code).toBe("not_found");
  });

  it("works with zero projects open — project-independent like /api/projects", async () => {
    await daemon.stop();
    daemon = await startDaemon({ port: 0 });

    const { status } = await getJson(daemon.port, `/api/fs/dirs?path=${encodeURIComponent(root)}`);

    expect(status).toBe(200);
  });

  it("rejects a cross-origin request", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/fs/dirs?path=${encodeURIComponent(root)}`, {
      headers: { origin: "https://evil.example" },
    });

    expect(res.status).toBe(403);
  });
});
