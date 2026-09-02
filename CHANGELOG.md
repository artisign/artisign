# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.10.0] - 2026-09-02

Six fixes from the backlog, in the renderer, the Playwright setup and the
validation of variant names. The first three change what an existing project
renders: markup that was silently discarded now reaches the output, so a screen
that was built around the old behaviour is worth a look after upgrading.

### Added

- `ARTISIGN_PLAYWRIGHT_DIR` names a directory whose `node_modules/playwright`
  is used for `get_screenshot` and `inspect_node`. Playwright can now live
  anywhere — a dedicated `~/.artisign-playwright`, say — instead of only in the
  tree Artisign itself was installed into, which is also what makes the
  screenshot tools usable when Artisign runs from npx's cache. (CHR-576)

### Fixed

- Attributes authored on a component instance reach the expanded root instead
  of being dropped: plain attributes such as `href`, `aria-*` and `target`, the
  instance's own `style` including token refs, and extra classes. The instance
  wins over the definition on a conflict; `style` and `class` accumulate, with
  the instance's declarations last so they win the inline cascade. The
  definition's root tag still wins. Every linked component previously rendered
  as a link to nowhere. (CHR-583)
- A component instance filling another component's slot is now expanded —
  with its own variant, nested slots and instance attributes — instead of
  falling through to the plain-element path, where its `$ref` leaked into the
  rendered HTML as a literal class. Ids authored inside a slot fill survive
  into the render and round-trip through the file; an id-less fill instance
  gets one under the expansion it fills. A cycle that runs through a
  template's own slot fill is guarded like direct nesting, while the same
  component nested through a screen-authored fill is treated as nesting.
  Unresolved refs inside slot content are reported like their top-level
  counterparts. (CHR-581)
- The README's canonical instance example — a component ref with its own
  `style`, a variant and a flow target on one element — is now a regression
  test, and README and agent guide state what an instance contributes and
  the precedence when it conflicts with the definition. (CHR-582)
- `get_screenshot` / `inspect_node`: the "Playwright is not installed" error
  names a command that works in a checkout (`npm install --no-save
  playwright`) and the directory route above. A partial or broken install (a
  half-reaped symlink, a module without `chromium.launch`) produces the same
  clean, actionable error instead of a raw `TypeError`, and says that a repair
  needs a daemon restart. Developer setup is documented in CONTRIBUTING.
  (CHR-576)
- The manual Chromium fallback launch passes `--no-sandbox` and
  `--disable-dev-shm-usage`, mirroring Playwright's own defaults, so it no
  longer dies on sandboxed Linux hosts — the environments it exists for. The
  two fallback suites run on CI again. (CHR-562)
- Variant names are validated at both doors: `promote_to_system` rejects a
  name containing `:`, `#`, `.`, `"`, `<`, `>`, `&` or whitespace before the
  definition file is assembled, and `write_html` rejects a definition whose
  `data-variant` carries one, both with `validation_failed`. Closes the
  markup-injection case where an interpolated quote wrote templates the
  caller never asked for. (CHR-556)
- The MCP server reports the installed package version rather than a second,
  hand-maintained copy of it — which this release would have left at `0.9.0`.

## [0.9.0] - 2026-08-26

First public release of Artisign, as a beta. Everything below is new because
nothing was public before; the version says 0.9 because the tool palette is not
yet under an API-stability promise.

### Added

- The CLI and the daemon on `127.0.0.1`: `init`, `start`, `serve`, `status`,
  `stop`, and a project registry that serves several projects at once.
- The MCP server over stdio and streamable HTTP, exposing the 23-tool palette.
- The file store: augmented HTML per screen, JSON tokens, atomic writes, a
  filesystem watcher, and optional auto-commit per write.
- The design system: tokens, components with variants, patterns, ref drift
  warnings and `promote_to_system`.
- The browser preview: screen list, sandboxed render, live reload over SSE,
  flow mode, comment threads and the design-system view.
- `get_screenshot` and `inspect_node` for the agent's own review loop, backed
  by Playwright as an optional peer dependency.
