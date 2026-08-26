import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initProject } from "../init/init-project.js";
import { FsStore } from "../store/index.js";
import { writeHtml, patchHtml, setTokens } from "./writes.js";

const execFileAsync = promisify(execFile);

async function gitLog(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["log", "--format=%s"], { cwd: dir });
  return stdout.trim().split("\n").reverse(); // oldest first
}

/**
 * End-to-end acceptance test for the PRD's audit-log claim ("git log shows
 * one commit per write op with a readable message"): a fresh project with
 * the `init` default (autoCommit: true) run through the real tool layer,
 * not just git.ts in isolation (see src/store/git.test.ts for that).
 */
describe("git auto-commit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-autocommit-e2e-"));
    await initProject(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("commits once per write op, each message naming the tool and its target", async () => {
    const store = new FsStore(dir);

    const write = await writeHtml(store, {
      screen: "home",
      mode: "create",
      title: "Home",
      html_aug: `<section id="n1" style="padding: 16px"><h1 id="n2">Hi</h1></section>`,
    });
    expect(write.commit).toBeTypeOf("string");

    const patch = await patchHtml(store, {
      target: { kind: "node", node: "home.n2" },
      operation: "set_attr",
      attr: { name: "data-section", value: "hero" },
    });
    expect(patch.commit).toBeTypeOf("string");

    const tokens = await setTokens(store, {
      tokens: { "color.primary": "#3366ff" },
      mode: "patch",
    });
    expect(tokens.commit).toBeTypeOf("string");

    const messages = await gitLog(dir);
    expect(messages).toEqual(["write_html: home", "patch_html: home", "set_tokens: color.primary"]);

    // Every commit is a distinct, real commit — not the same SHA reused.
    const shas = new Set([write.commit, patch.commit, tokens.commit]);
    expect(shas.size).toBe(3);
  });
});
