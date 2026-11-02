import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsStore } from "../store/index.js";
import { initProject } from "../init/init-project.js";

export type ProjectFixture = {
  dir: string;
  store: FsStore;
  cleanup: () => Promise<void>;
};

/** Scaffolds a fresh temp project (autoCommit disabled, so tests don't need git and run fast). */
export async function setupProject(): Promise<ProjectFixture> {
  const dir = await mkdtemp(join(tmpdir(), "artisign-tools-"));
  await initProject(dir);
  const store = new FsStore(dir);

  const config = await store.readArtisignConfig();
  config.settings.autoCommit = false;
  await store.writeArtisignConfig(config);

  return {
    dir,
    store,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Approximates token count as chars/4 — the same estimation convention
 * Tool-Palette-Budgets.md itself uses for design targets ("expect +/-10-15%
 * drift to the actual tokenizer"; real measurement is a separate M2/M6 eval
 * harness, not a unit test concern).
 */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export type GitConfigFixture = {
  cleanup: () => Promise<void>;
};

// Everything git consults for an author/committer identity besides the
// config files: `EMAIL` is its last resort before auto-detection.
const GIT_IDENTITY_ENV = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
];

/**
 * Makes git see exactly `identity` — or none at all — for the duration of a
 * test, whatever the developer's or CI's own `~/.gitconfig` and environment
 * say: the global config is swapped for a private temp file, the system
 * config disabled, and the identity environment variables cleared.
 * `user.useConfigOnly` keeps git from inventing `login@hostname` on a host
 * whose name happens to pass as a mail domain, so "no identity" means the
 * same thing on every machine. Call `cleanup()` in `afterEach`.
 */
export async function setupGitConfig(
  identity: { name?: string; email?: string } | null,
): Promise<GitConfigFixture> {
  const dir = await mkdtemp(join(tmpdir(), "artisign-gitconfig-"));
  const file = join(dir, "gitconfig");
  const user =
    (identity?.name === undefined ? "" : `\tname = ${identity.name}\n`) +
    (identity?.email === undefined ? "" : `\temail = ${identity.email}\n`);
  await writeFile(file, `[user]\n\tuseConfigOnly = true\n${user}`);

  const saved = new Map<string, string | undefined>();
  for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", ...GIT_IDENTITY_ENV])
    saved.set(name, process.env[name]);
  for (const name of GIT_IDENTITY_ENV) delete process.env[name];
  process.env.GIT_CONFIG_GLOBAL = file;
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  return {
    cleanup: async () => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export type ArtisignHomeFixture = {
  home: string;
  cleanup: () => Promise<void>;
};

/**
 * Points `$ARTISIGN_HOME` (src/daemon/global-config.ts) at a private temp
 * directory for the duration of a test — daemon-level state (global config,
 * daemon.lock) must never touch a developer's real `~/.artisign`, and two
 * daemon-starting test files running in parallel must not collide on the
 * same global lock. Call `cleanup()` in `afterEach` — it restores the
 * environment variable and removes the temp directory.
 */
export async function setupArtisignHome(): Promise<ArtisignHomeFixture> {
  const home = await mkdtemp(join(tmpdir(), "artisign-home-"));
  process.env.ARTISIGN_HOME = home;

  return {
    home,
    cleanup: async () => {
      delete process.env.ARTISIGN_HOME;
      await rm(home, { recursive: true, force: true });
    },
  };
}
