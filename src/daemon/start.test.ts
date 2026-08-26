import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/init-project.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, DaemonAlreadyRunningError, type DaemonHandle } from "./start.js";
import { writeLock } from "./lock.js";

describe("startDaemon", () => {
  let dir: string;
  let artisignHomeFixture: ArtisignHomeFixture;
  let artisignHome: string;
  let daemon: DaemonHandle | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-daemon-"));
    await initProject(dir);
    // A private ARTISIGN_HOME per test so the global daemon lock never collides
    // with another test file's daemon running in parallel, and so a real
    // ~/.artisign is never touched.
    artisignHomeFixture = await setupArtisignHome();
    artisignHome = artisignHomeFixture.home;
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await artisignHomeFixture.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves a GET /health endpoint on an OS-assigned port", async () => {
    daemon = await startDaemon({ port: 0, projects: [dir] });
    expect(daemon.port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("serves the placeholder preview page on other routes", async () => {
    daemon = await startDaemon({ port: 0, projects: [dir] });

    const res = await fetch(`http://127.0.0.1:${daemon.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Artisign");
  });

  it("starts with no project open: health + static preview OK, project-dependent routes 503", async () => {
    daemon = await startDaemon({ port: 0 });

    const health = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(health.status).toBe(200);

    // The empty-state UI has to load from somewhere — static
    // preview files are exempt from the no_project guard.
    const preview = await fetch(`http://127.0.0.1:${daemon.port}/`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toContain("text/html");

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/screens`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: "no_project", message: "no project open" });
  });

  it("writes a global daemon.lock file with pid and the actually-bound port", async () => {
    daemon = await startDaemon({ port: 0, projects: [dir] });

    const lock = JSON.parse(await readFile(join(artisignHome, "daemon.lock"), "utf-8"));
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(daemon.port);
  });

  it("refuses to start a second daemon while one is running", async () => {
    daemon = await startDaemon({ port: 0, projects: [dir] });

    await expect(startDaemon({ port: 0, projects: [dir] })).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it("removes the lock file on stop", async () => {
    daemon = await startDaemon({ port: 0, projects: [dir] });
    await daemon.stop();
    daemon = undefined;

    await expect(readFile(join(artisignHome, "daemon.lock"), "utf-8")).rejects.toThrow();
  });

  it("ignores a stale lock left by a dead process", async () => {
    // PID unlikely to be in use; process.kill(pid, 0) on it throws ESRCH.
    await writeLock({ pid: 999999, port: 4711 });

    daemon = await startDaemon({ port: 0, projects: [dir] });
    const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(res.status).toBe(200);
  });

  it("starts even when .artisign/ was deleted (derived cache, must rebuild as a no-op)", async () => {
    await rm(join(dir, ".artisign"), { recursive: true, force: true });

    daemon = await startDaemon({ port: 0, projects: [dir] });
    const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(res.status).toBe(200);
  });

  it("allows starting again after a clean stop", async () => {
    const first = await startDaemon({ port: 0, projects: [dir] });
    await first.stop();

    daemon = await startDaemon({ port: 0, projects: [dir] });
    const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(res.status).toBe(200);
  });

  it("closes an already-opened project's watcher/SSE hub when a later project fails to open", async () => {
    const badDir = await mkdtemp(join(tmpdir(), "artisign-daemon-invalid-"));

    await expect(startDaemon({ port: 0, projects: [dir, badDir] })).rejects.toThrow();

    // Let chokidar finish its initial scan before making the external edit —
    // same reasoning as the live-index test below.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(join(dir, "screens", "home.html"), `<div id="n1"></div>`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // If the first project's watcher had leaked (not stopped by the failed
    // startDaemon's cleanup), this edit would have rebuilt .artisign/index.json
    // to include the new screen.
    const raw = await readFile(join(dir, ".artisign", "index.json"), "utf-8");
    const index = JSON.parse(raw);
    expect(index.screens.home).toBeUndefined();

    await rm(badDir, { recursive: true, force: true });
  });

  it("a project with an artisign.json missing settings is refused cleanly, naming the path, with no TypeError", async () => {
    const badDir = await mkdtemp(join(tmpdir(), "artisign-daemon-no-settings-"));
    await initProject(badDir);
    await writeFile(join(badDir, "artisign.json"), JSON.stringify({ name: "no-settings" }));

    await expect(startDaemon({ port: 0, projects: [dir, badDir] })).rejects.toThrow(join(badDir, "artisign.json"));

    // The good project's watcher must still have been torn down cleanly —
    // same leak check as review fix 1's test above.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(join(dir, "screens", "home.html"), `<div id="n1"></div>`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const raw = await readFile(join(dir, ".artisign", "index.json"), "utf-8");
    expect(JSON.parse(raw).screens.home).toBeUndefined();

    await rm(badDir, { recursive: true, force: true });
  });

  it("resolves the port from the global config when no explicit port is given", async () => {
    // Grab an OS-assigned free port first so the assertion can prove the
    // daemon bound the configured port, not DEFAULT_PORT.
    const probe = createNetServer();
    const freePort = await new Promise<number>((res) => {
      probe.listen(0, "127.0.0.1", () => {
        res((probe.address() as AddressInfo).port);
      });
    });
    await new Promise<void>((res) => probe.close(() => res()));
    await writeFile(join(artisignHome, "config.json"), `${JSON.stringify({ port: freePort })}\n`);

    daemon = await startDaemon({ projects: [dir] });
    expect(daemon.port).toBe(freePort);
    const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(res.status).toBe(200);
  });

  it("builds .artisign/index.json on start and keeps it live via live-index wiring", async () => {
    // initProject() (in beforeEach) already scaffolds screens/.
    await writeFile(join(dir, "screens", "home.html"), `<div id="n1"></div>`);

    daemon = await startDaemon({ port: 0, projects: [dir] });

    const initialIndex = JSON.parse(await readFile(join(dir, ".artisign", "index.json"), "utf-8"));
    expect(initialIndex.screens.home?.nodeCount).toBe(1);

    // Let chokidar finish its initial scan before making the external edit
    // (same pattern as src/store/watcher.test.ts / model/live-index.test.ts)
    // — under a loaded test run, with many other real fs watchers active in
    // parallel, that scan can take a moment, and an edit racing ahead of it
    // is silently missed rather than queued.
    await new Promise((resolve) => setTimeout(resolve, 200));

    await writeFile(join(dir, "screens", "home.html"), `<div id="n1"><span id="n2"></span></div>`);

    const start = Date.now();
    await new Promise<void>((resolve, reject) => {
      const interval = setInterval(async () => {
        const raw = await readFile(join(dir, ".artisign", "index.json"), "utf-8").catch(() => "{}");
        const index = JSON.parse(raw);
        if (index.screens?.home?.nodeCount === 2) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 4000) {
          clearInterval(interval);
          reject(new Error("index was not refreshed after external edit"));
        }
      }, 20);
    });
  }, 10000);
});
