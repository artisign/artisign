import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess, ExecFileException } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  setupArtisignHome,
  setupProject,
  type ArtisignHomeFixture,
} from "../tools/test-fixtures.js";

// These tests exercise the built CLI binary as a real detached process
// (start/stop/status only make sense across process boundaries), so they
// need dist/cli/index.js — build it once up front rather than depending on
// test run order relative to `npm run build`.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliEntry = join(repoRoot, "dist/cli/index.js");

type CliResult = { stdout: string; stderr: string; code: number };

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliEntry, ...args], (err, stdout, stderr) => {
      const exception = err as ExecFileException | null;
      const code = typeof exception?.code === "number" ? exception.code : 0;
      resolve({ stdout, stderr, code });
    });
  });
}

/** Resolves with the child's first line of stdout — `serve` runs in the foreground. */
function firstStdoutLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline !== -1) resolve(buffer.slice(0, newline));
    });
    child.on("error", reject);
    child.on("exit", () => reject(new Error(`serve exited before printing: ${buffer}`)));
  });
}

describe("CLI lifecycle", () => {
  let artisignHome: ArtisignHomeFixture;

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      execFile("npm", ["run", "build"], { cwd: repoRoot }, (err) => (err ? reject(err) : resolve()));
    });
  }, 60_000);

  beforeEach(async () => {
    artisignHome = await setupArtisignHome();
  });

  afterEach(async () => {
    // Best-effort: don't leak a detached daemon if a test failed mid-way.
    await runCli(["stop"]);
    await artisignHome.cleanup();
  });

  it("status reports not running when there is no daemon", async () => {
    const result = await runCli(["status"]);
    expect(result.stdout.trim()).toBe("not running");
    expect(result.code).toBe(1);
  });

  it("stop is a no-op when there is no daemon", async () => {
    const result = await runCli(["stop"]);
    expect(result.stdout.trim()).toBe("no daemon running");
    expect(result.code).toBe(0);
  });

  it("start -> status -> stop roundtrip", async () => {
    const start = await runCli(["start", "--port", "0"]);
    expect(start.code).toBe(0);
    expect(start.stdout).toMatch(/artisign running on http:\/\/127\.0\.0\.1:\d+/);

    const status = await runCli(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/artisign running \(pid \d+, port \d+\)/);

    const stop = await runCli(["stop"]);
    expect(stop.code).toBe(0);
    expect(stop.stdout.trim()).toBe("artisign stopped");

    const afterStop = await runCli(["status"]);
    expect(afterStop.stdout.trim()).toBe("not running");
  }, 20_000);

  it("serve honours --port instead of taking it for a project directory", async () => {
    const project = await setupProject();
    const child = spawn(process.execPath, [cliEntry, "serve", "--port", "0", project.dir]);

    try {
      const line = await firstStdoutLine(child);
      const port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(line)?.[1]);
      expect(Number.isInteger(port)).toBe(true);
      expect(port).not.toBe(4711);

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.ok).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await project.cleanup();
    }
  }, 20_000);

  it("serve rejects an unknown option without starting a daemon", async () => {
    const result = await runCli(["serve", "--prot", "4799", "."]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown option: --prot");

    const status = await runCli(["status"]);
    expect(status.stdout.trim()).toBe("not running");
  });

  it("start is idempotent — a second start reports the already-running daemon", async () => {
    const first = await runCli(["start", "--port", "0"]);
    expect(first.code).toBe(0);

    const second = await runCli(["start", "--port", "0"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/already running on http:\/\/127\.0\.0\.1:\d+/);

    await runCli(["stop"]);
  }, 20_000);
});
