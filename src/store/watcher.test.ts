import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FSWatcher } from "chokidar";
import { watchProject } from "./watcher.js";
import type { ProjectChangeEvent } from "./types.js";

// Delegates to the real chokidar.watch for every test — captures the
// resulting FSWatcher (a real EventEmitter) so the error-guard test below
// can emit a genuine "error" event on it, which is otherwise impractical to
// trigger reliably from real filesystem activity across platforms.
let capturedWatcher: FSWatcher | undefined;
vi.mock("chokidar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chokidar")>();
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) => {
      capturedWatcher = actual.watch(...args);
      return capturedWatcher;
    },
  };
});

function waitFor(events: ProjectChangeEvent[], predicate: (e: ProjectChangeEvent) => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (events.some(predicate)) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`timed out waiting for event after ${timeoutMs}ms`));
      }
    }, 10);
  });
}

describe("watchProject", () => {
  let dir: string;
  let unwatch: (() => void) | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-watch-"));
    await mkdir(join(dir, "screens"), { recursive: true });
    await mkdir(join(dir, ".artisign"), { recursive: true });
  });

  afterEach(async () => {
    unwatch?.();
    await rm(dir, { recursive: true, force: true });
  });

  it("detects an external screen edit within ~200ms", async () => {
    await writeFile(join(dir, "screens", "home.html"), "<div id=\"n1\"></div>");
    const events: ProjectChangeEvent[] = [];
    unwatch = watchProject(dir, (event) => events.push(event));

    // Let chokidar finish its initial scan before making the edit.
    await new Promise((resolve) => setTimeout(resolve, 150));

    await writeFile(join(dir, "screens", "home.html"), "<div id=\"n1\">changed</div>");

    await waitFor(events, (e) => e.category === "screen" && e.path.includes("home.html"), 500);
  });

  it("categorizes screens/*.meta.json as \"screen\"", async () => {
    const events: ProjectChangeEvent[] = [];
    unwatch = watchProject(dir, (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 150));

    await writeFile(join(dir, "screens", "home.meta.json"), "{}");

    await waitFor(events, (e) => e.path.includes("home.meta.json"), 500);
    expect(events.find((e) => e.path.includes("home.meta.json"))?.category).toBe("screen");
  });

  it("categorizes mockups/<name>/mockup.json and mockups/<name>/<variant>.html as \"mockup\"", async () => {
    await mkdir(join(dir, "mockups", "assign-caregiver"), { recursive: true });
    const events: ProjectChangeEvent[] = [];
    unwatch = watchProject(dir, (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 150));

    await writeFile(join(dir, "mockups", "assign-caregiver", "mockup.json"), "{}");
    await writeFile(join(dir, "mockups", "assign-caregiver", "a.html"), "<div></div>");

    await waitFor(events, (e) => e.path.includes("mockup.json"), 500);
    await waitFor(events, (e) => e.path.includes("a.html"), 500);
    expect(events.find((e) => e.path.includes("mockup.json"))?.category).toBe("mockup");
    expect(events.find((e) => e.path.includes("a.html"))?.category).toBe("mockup");
  });

  it("emits a \"mockup\" event when a new mockups/<name>/ subdirectory is created live, even before any file lands in it", async () => {
    const events: ProjectChangeEvent[] = [];
    unwatch = watchProject(dir, (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 150));

    await mkdir(join(dir, "mockups", "assign-caregiver"), { recursive: true });

    await waitFor(events, (e) => e.path.includes("assign-caregiver"), 500);
    expect(events.find((e) => e.path.includes("assign-caregiver"))?.category).toBe("mockup");
  });

  it("categorizes assets/<path> as \"asset\"", async () => {
    await mkdir(join(dir, "assets"), { recursive: true });
    const events: ProjectChangeEvent[] = [];
    unwatch = watchProject(dir, (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 150));

    await writeFile(join(dir, "assets", "hero.png"), "not-really-a-png");

    await waitFor(events, (e) => e.path.includes("hero.png"), 500);
    expect(events.find((e) => e.path.includes("hero.png"))?.category).toBe("asset");
  });

  it("categorizes design-system/meta.json as \"design_system_meta\"", async () => {
    await mkdir(join(dir, "design-system"), { recursive: true });
    const events: ProjectChangeEvent[] = [];
    unwatch = watchProject(dir, (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 150));

    await writeFile(join(dir, "design-system", "meta.json"), "{}");

    await waitFor(events, (e) => e.category === "design_system_meta", 500);
  });

  it("an emitted watcher error is logged, not thrown", async () => {
    unwatch = watchProject(dir, () => {});
    await new Promise((resolve) => setTimeout(resolve, 150));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Without this the optional chaining below would make the test pass
    // vacuously if the chokidar mock ever stopped capturing the instance.
    expect(capturedWatcher).toBeDefined();
    // An unhandled "error" event on an EventEmitter throws synchronously —
    // this call itself would fail the test if watchProject registered no
    // listener for it.
    expect(() => capturedWatcher?.emit("error", new Error("boom"))).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("watcher error"), "boom");
    errorSpy.mockRestore();
  });

  it("ignores changes inside .artisign/", async () => {
    const events: ProjectChangeEvent[] = [];
    unwatch = watchProject(dir, (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 150));

    await writeFile(join(dir, ".artisign", "index.json"), "{}");
    await writeFile(join(dir, "screens", "home.html"), "<div id=\"n1\"></div>");

    await waitFor(events, (e) => e.path.includes("home.html"), 500);
    expect(events.some((e) => e.path.startsWith(".artisign"))).toBe(false);
  });
});
