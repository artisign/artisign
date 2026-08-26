import { mkdtemp, rm } from "node:fs/promises";
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
