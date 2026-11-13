import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENTS, claudeCode, claudeDesktop, codex, cursor, defaultClientEnv, opencode, vscode, type ClientEnv } from "./clients.js";
import { installSkill, readSkill, refreshSkills, removeSkill, removeSkills, skillFile, skillStatus } from "./skill.js";
import { runSetup, type SetupDeps } from "../cli/setup.js";

let root: string;
let home: string;
let skill: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "artisign-skill-"));
  home = join(root, "home");
  await mkdir(home, { recursive: true });
  skill = await readSkill();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const env = (vars: NodeJS.ProcessEnv = {}): ClientEnv => ({ ...defaultClientEnv(), home, platform: "darwin", pathEnv: join(root, "bin"), vars });
const skillMd = (client: typeof cursor): string => skillFile(client, env()) as string;

describe("the shipped skill", () => {
  it("is the artisign skill with its frontmatter", () => {
    expect(skill).toMatch(/^---\nname: artisign\n/);
  });
});

describe("skill locations", () => {
  it("are the documented user folders; Claude Desktop has none", () => {
    expect(skillFile(claudeCode, env())).toBe(join(home, ".claude", "skills", "artisign", "SKILL.md"));
    expect(skillFile(cursor, env())).toBe(join(home, ".cursor", "skills", "artisign", "SKILL.md"));
    expect(skillFile(codex, env())).toBe(join(home, ".agents", "skills", "artisign", "SKILL.md"));
    expect(skillFile(opencode, env())).toBe(join(home, ".config", "opencode", "skills", "artisign", "SKILL.md"));
    expect(skillFile(vscode, env())).toBe(join(home, ".copilot", "skills", "artisign", "SKILL.md"));
    expect(skillFile(claudeDesktop, env())).toBeUndefined();
  });
});

describe("skillStatus / installSkill / removeSkill", () => {
  it("walks missing -> installed -> outdated -> installed, writing only <dir>/artisign/SKILL.md", async () => {
    expect((await skillStatus(cursor, env(), skill)).status).toBe("missing");
    await installSkill(cursor, env(), skill);
    expect((await skillStatus(cursor, env(), skill)).status).toBe("installed");
    expect(await readdir(join(home, ".cursor"))).toEqual(["skills"]);
    expect(await readdir(join(home, ".cursor", "skills", "artisign"))).toEqual(["SKILL.md"]);

    await writeFile(skillMd(cursor), "edited\n");
    expect((await skillStatus(cursor, env(), skill)).status).toBe("outdated");
    await installSkill(cursor, env(), skill);
    expect(await readFile(skillMd(cursor), "utf8")).toBe(skill);
  });

  it("is unsupported where the tool has no skills folder", async () => {
    expect(await skillStatus(claudeDesktop, env(), skill)).toEqual({ status: "unsupported" });
    await expect(installSkill(claudeDesktop, env(), skill)).rejects.toThrow(/no skills folder/);
  });

  it("removeSkill deletes the artisign folder and leaves sibling skills alone", async () => {
    await mkdir(join(home, ".cursor", "skills", "other"), { recursive: true });
    await writeFile(join(home, ".cursor", "skills", "other", "SKILL.md"), "mine");
    await installSkill(cursor, env(), skill);
    expect(await removeSkill(cursor, env())).toBe(true);
    expect(await readdir(join(home, ".cursor", "skills"))).toEqual(["other"]);
    expect(await removeSkill(cursor, env())).toBe(false);
  });
});

describe("refreshSkills / removeSkills", () => {
  it("refreshes outdated skills only and installs none that are missing", async () => {
    await installSkill(cursor, env(), "old text\n");
    await installSkill(opencode, env(), skill);
    const results = await refreshSkills(env(), CLIENTS);
    expect(results).toEqual([{ name: "Cursor", status: "done" }]);
    expect(await readFile(skillMd(cursor), "utf8")).toBe(skill);
    await expect(stat(join(home, ".claude", "skills"))).rejects.toThrow();
  });

  it("removeSkills reports the tools that had one", async () => {
    await installSkill(cursor, env(), skill);
    expect(await removeSkills(env(), CLIENTS)).toEqual([{ name: "Cursor", status: "done" }]);
  });
});

describe("setup: the skill step", () => {
  const make = (over: Partial<SetupDeps> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const d: SetupDeps = {
      env: env(),
      clients: [cursor],
      version: "9.9.9",
      isTTY: true,
      ask: vi.fn(async () => ""),
      restartDaemon: vi.fn(async () => "unchanged" as const),
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      ...over,
    };
    return { d, out, err };
  };
  const installNpx = async (): Promise<void> => {
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin", "npx"), "#!/bin/sh\n", { mode: 0o755 });
  };

  beforeEach(async () => {
    await mkdir(join(home, ".cursor"), { recursive: true });
    await installNpx();
  });

  it("asks per client after the MCP step; Y installs, and a second run changes nothing", async () => {
    const { d, out } = make();
    expect(await runSetup({ cliEntry: "e" }, d)).toBe(0);
    expect(d.ask).toHaveBeenNthCalledWith(1, "Connect Cursor? [Y/n] ");
    expect(d.ask).toHaveBeenNthCalledWith(2, "Install the artisign skill for Cursor? [Y/n/r] ");
    expect(await readFile(skillMd(cursor), "utf8")).toBe(skill);

    const again = make();
    await runSetup({ cliEntry: "e" }, again.d);
    expect(again.d.ask).not.toHaveBeenCalledWith(expect.stringContaining("skill"));
    expect(again.out.join("\n")).toContain("skill in Cursor is up to date");
    expect(out.join("\n")).toContain("Installed the artisign skill for Cursor");
  });

  it("r prints SKILL.md and asks again; n skips", async () => {
    const answers = ["y", "r", "n"];
    const { d, out } = make({ ask: vi.fn(async () => answers.shift() ?? "") });
    await runSetup({ cliEntry: "e" }, d);
    expect(out).toContain(skill.replace(/\n$/, ""));
    expect(d.ask).toHaveBeenCalledTimes(3);
    await expect(stat(skillMd(cursor))).rejects.toThrow();
    expect(out.join("\n")).toContain("Skipped the artisign skill for Cursor");
  });

  it("--yes installs without asking", async () => {
    const { d } = make();
    await runSetup({ cliEntry: "e", yes: true }, d);
    expect(d.ask).not.toHaveBeenCalled();
    expect(await readFile(skillMd(cursor), "utf8")).toBe(skill);
  });

  it("without a TTY and without --yes changes nothing", async () => {
    const { d } = make({ isTTY: false });
    expect(await runSetup({ cliEntry: "e" }, d)).toBe(1);
    await expect(stat(skillMd(cursor))).rejects.toThrow();
  });

  it("--skill runs only the skill step", async () => {
    const { d } = make();
    expect(await runSetup({ cliEntry: "e", skill: true }, d)).toBe(0);
    expect(d.ask).toHaveBeenCalledTimes(1);
    await expect(stat(join(home, ".cursor", "mcp.json"))).rejects.toThrow();
    expect(await readFile(skillMd(cursor), "utf8")).toBe(skill);
  });

  it("--remove removes the skill folder and nothing else; --remove --skill leaves the MCP entry", async () => {
    await runSetup({ cliEntry: "e", yes: true }, make().d);
    await mkdir(join(home, ".cursor", "skills", "other"), { recursive: true });
    const only = make();
    await runSetup({ cliEntry: "e", remove: true, skill: true }, only.d);
    expect(only.out.join("\n")).toContain("Removed the artisign skill from Cursor");
    expect(JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.artisign).toBeDefined();

    await runSetup({ cliEntry: "e", yes: true }, make().d);
    await runSetup({ cliEntry: "e", remove: true }, make().d);
    expect(JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.artisign).toBeUndefined();
    expect(await readdir(join(home, ".cursor", "skills"))).toEqual(["other"]);
  });
});
