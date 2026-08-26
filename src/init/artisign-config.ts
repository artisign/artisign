export type ArtisignSettings = {
  autoCommit: boolean;
  /** @deprecated The daemon's port is no longer read from here — see src/daemon/global-config.ts. Kept for schema tolerance with existing projects. */
  port?: number;
};

export type ArtisignConfig = {
  name: string;
  version: string;
  settings: ArtisignSettings;
};

export const DEFAULT_PORT = 4711;

/** Project config filename. */
export const CONFIG_FILENAME = "artisign.json";
/** Derived cache directory, relative to a project root. */
export const CACHE_DIR = ".artisign";

export function defaultConfig(name: string): ArtisignConfig {
  return {
    name,
    version: "0.1.0",
    settings: {
      autoCommit: true,
    },
  };
}
