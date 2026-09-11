# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.11.0] - 2026-09-11

Three changes an agent notices and one a human does. Component slot fills stop
being a blind spot for the read tools, the rule that trips most people writing
their first component now reaches them before they write it, and the prose
fields in the preview — screen notes, component usage, the design-system idea
and its decision bodies — render as Markdown instead of one flat paragraph.
Tag-level notes give a feature spec one home instead of a copy in every screen
that belongs to it.

### Added

- `set_meta` takes a `tag` target: `{kind:"tag", tag:"chr-244"}` with `notes`,
  stored as `tags/<tag>.meta.json`. A spec spanning several screens is written
  once against its ticket tag instead of duplicated into each screen's notes.
  `get_project {tags:[…]}` returns those notes exactly once, and `get_screen`
  at `view:"full"` carries them beside the screen's own under `tag_notes`. The
  tool surface stays at 23 — this is a target, not a tool. (CHR-596)
- The preview renders `notes`, component and pattern `usage`, the design-system
  `idea` and decision bodies, and mockup descriptions as Markdown — headings,
  lists, tables, inline and fenced code, links. The renderer builds DOM nodes
  and never parses an HTML string, so markup in a note can only ever become
  text; a link renders as an anchor only for http(s), mailto, `/` or `#`.
  (CHR-596)
- `get_node` reports a component instance's slot fills under `slots` at
  `view:"full"`, keyed by slot name, each carrying the id that fill actually
  gets in the render. `find_nodes` matches inside fills and marks such a match
  `addressable: false` with `inside` pointing at the enclosing instance.
  Fill content stays out of the flat node map, so it remains readable but not
  patchable by node ref — the tool descriptions and the agent guide now say so.
  (CHR-584)

### Changed

- `write_html` and `patch_html` state the rule that a definition must never
  style its own `data-slot` element. It was only in the server instructions and
  the agent guide before, neither of which an agent is guaranteed to read
  before its first component — the rule tripped 3 of 5 components in a real
  dogfooding run. The image-filling case gets one documented form instead of an
  undocumented attribute workaround. (CHR-578)

### Fixed

- The Markdown renderer no longer hangs on a list item that opens a block while
  indented, and no longer italicises the middle of `data_flow_target` or
  `2 * 3 * 4`. Found in review before release. (CHR-596)

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
