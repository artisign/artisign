# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Renamed the product from "ux-designer" to **Artisign**. This affects the
  npm package name and the CLI command: `npx ux-designer` → `npx artisign`.
- Renamed the MCP server from `ux-designer` to `artisign`.
- Renamed the environment variable `UXD_HOME` to `ARTISIGN_HOME`.
- Renamed the daemon state directory from `~/.ux-designer/` to
  `~/.artisign/`.
- Renamed the project config file `uxd.json` to `artisign.json`.
- Renamed the derived cache directory `.uxd/` to `.artisign/`.
- The derived cache is now self-ignoring: `.artisign/` carries its own
  `.gitignore`, so the index and the font cache stay out of a project's
  git history even when the project's own `.gitignore` predates the
  rename.
- Preview UI browser-storage keys migrate automatically from the `uxd.`
  prefix — no manual action needed.

### Upgrading

None of the renames above have a compatibility fallback. Before upgrading:

1. **Stop the running daemon.** After the upgrade its lock file is looked
   up under `~/.artisign/`, so `artisign stop` can no longer find a daemon
   started by the previous version, and starting a new one fails against
   the still-occupied port.
2. **Rename each project's config file** from `uxd.json` to
   `artisign.json`. A project without `artisign.json` is no longer
   recognised.
3. Optionally delete each project's now-unused `.uxd/` directory. It is a
   derived cache and is rebuilt as `.artisign/` on first use.

The daemon's own state — the recent-projects list and any custom port —
is not carried over from `~/.ux-designer/` and has to be set up again.
