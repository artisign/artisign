import { readSkill } from "../setup/skill.js";

/** `artisign skill`: prints SKILL.md to stdout, unchanged, so it can be read (or piped) before it is installed. */
export async function runSkill(): Promise<number> {
  process.stdout.write(await readSkill());
  return 0;
}
