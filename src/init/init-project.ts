import { mkdir, writeFile } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { defaultConfig, CONFIG_FILENAME, CACHE_DIR } from "./artisign-config.js";
import { ensureCacheGitignore } from "../store/index.js";

const EMPTY_TOKENS = {
  color: {},
  spacing: {},
  typography: {},
  radius: {},
  shadow: {},
  motion: {},
};

const GITIGNORE_CONTENT = "# derived cache, rebuildable from source\n.artisign/\n";

export async function initProject(dir: string): Promise<void> {
  const projectDir = resolve(dir);
  const name = basename(projectDir);

  await mkdir(join(projectDir, "design-system", "components"), { recursive: true });
  await mkdir(join(projectDir, "design-system", "patterns"), { recursive: true });
  await mkdir(join(projectDir, "screens"), { recursive: true });
  await mkdir(join(projectDir, "mockups"), { recursive: true });
  await mkdir(join(projectDir, "assets"), { recursive: true });
  await mkdir(join(projectDir, CACHE_DIR), { recursive: true });
  await ensureCacheGitignore(projectDir);

  await writeFile(
    join(projectDir, CONFIG_FILENAME),
    `${JSON.stringify(defaultConfig(name), null, 2)}\n`,
  );
  await writeFile(
    join(projectDir, "design-system", "tokens.json"),
    `${JSON.stringify(EMPTY_TOKENS, null, 2)}\n`,
  );
  await writeFile(join(projectDir, "flows.json"), "[]\n");
  await writeFile(join(projectDir, "comments.jsonl"), "");
  await writeFile(join(projectDir, ".gitignore"), GITIGNORE_CONTENT);
}
