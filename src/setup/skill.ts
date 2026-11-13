import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../store/atomic-write.js";
import { CLIENTS, type Client, type ClientEnv } from "./clients.js";

const SKILL_NAME = "artisign";

// `skills/` sits next to `dist/` and `src/`, one level under the package root (see package.json "files") — the same
// relative-path trick as `AGENT_GUIDE_URL` in `src/tools/guide.ts`, so it resolves from `src/setup/` and `dist/setup/`.
const SKILL_URL = new URL("../../skills/artisign/SKILL.md", import.meta.url);

/** The shipped `SKILL.md`. */
export async function readSkill(): Promise<string> {
  return readFile(SKILL_URL, "utf8");
}

export type SkillStatus = "installed" | "outdated" | "missing" | "unsupported";

/** Where the skill lives for `client`, or undefined when the tool has no skills folder. The folder is always `<skillsDir>/artisign`. */
export function skillFile(client: Client, env: ClientEnv): string | undefined {
  return client.skillsDir === undefined ? undefined : join(client.skillsDir(env), SKILL_NAME, "SKILL.md");
}

/** `installed` = the file equals `content`; `outdated` = it exists but differs; `missing` = no file; `unsupported` = the tool has no skills folder. */
export async function skillStatus(client: Client, env: ClientEnv, content: string): Promise<{ status: SkillStatus; path?: string }> {
  const path = skillFile(client, env);
  if (path === undefined) return { status: "unsupported" };
  try {
    return { status: (await readFile(path, "utf8")) === content ? "installed" : "outdated", path };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", path };
    throw err;
  }
}

/** Writes `<skillsDir>/artisign/SKILL.md` atomically and nothing else. Returns its path. */
export async function installSkill(client: Client, env: ClientEnv, content: string): Promise<string> {
  const path = skillFile(client, env);
  if (path === undefined) throw new Error(`${client.name} has no skills folder`);
  await atomicWrite(path, content);
  return path;
}

/** Removes the `artisign` skill folder (and only it). True when there was one. */
export async function removeSkill(client: Client, env: ClientEnv): Promise<boolean> {
  if (client.skillsDir === undefined) return false;
  const dir = join(client.skillsDir(env), SKILL_NAME);
  const present = await access(dir).then(
    () => true,
    () => false,
  );
  await rm(dir, { recursive: true, force: true });
  return present;
}

export type SkillResult = { name: string; status: "done" | "failed"; error?: string };

/** `update`: rewrites the skill where it is already installed and outdated; installs it nowhere new. */
export async function refreshSkills(env: ClientEnv, clients: Client[] = CLIENTS): Promise<SkillResult[]> {
  const results: SkillResult[] = [];
  let content: string;
  try {
    content = await readSkill();
  } catch (err) {
    return [{ name: "artisign skill", status: "failed", error: err instanceof Error ? err.message : String(err) }];
  }
  for (const client of clients) {
    try {
      if ((await skillStatus(client, env, content)).status !== "outdated") continue;
      await installSkill(client, env, content);
      results.push({ name: client.name, status: "done" });
    } catch (err) {
      results.push({ name: client.name, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** `setup --remove`: removes the skill folder from every client that has one. */
export async function removeSkills(env: ClientEnv, clients: Client[] = CLIENTS): Promise<SkillResult[]> {
  const results: SkillResult[] = [];
  for (const client of clients) {
    try {
      if (await removeSkill(client, env)) results.push({ name: client.name, status: "done" });
    } catch (err) {
      results.push({ name: client.name, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
