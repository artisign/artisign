# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.1] - 2026-09-21

A packaging release with no behaviour change: npm version metadata is
immutable, and the `mcpName` field that proves we own the package has to sit
on a published version before the official MCP registry will accept a
listing. 1.0.0 predates the field, so the listing needs this release to point
at.

### Added

- A `server.json` at the repo root and a matching `mcpName` field in
  `package.json` prepare Artisign for listing on the official MCP registry —
  the registry verifies npm package ownership by reading `mcpName` back off
  the published package metadata, which is why the two files carry it in
  lockstep. The registry listing itself is a manual `mcp-publisher publish`
  after the npm release ships, not part of this change. (CHR-663)

## [1.0.0] - 2026-09-18

The version number is the news: every milestone from the PRD is implemented, so
Artisign stops calling itself beta. What it takes to get there in this release
is the board becoming a review surface the agent and the human share — filter,
pins, zoom, and a presentation the agent can put on — plus follow mode, which
lets the human watch an agent work in the preview rather than reload to find out
what changed. Two new signals help an agent keep a design system coherent: a
reuse metric it can ask for, and a warning when it hand-builds something that
already exists. Four fixes close the multi-project correctness gaps that surfaced
once a daemon could hold several projects open at once.

### Added

- The board's filter and pinned screens live in daemon memory, one store per open
  project, and are written through a new tool, `set_board_state` — the same one
  tool for agents over MCP and for the browser. Every reader renders from the
  `board_state` SSE broadcast, so two tabs and an agent never drift apart, and
  `GET /api/board-state` serves the initial paint. Board state is deliberately
  daemon state, not project state: nothing of it reaches the project folder. The
  tool surface goes from 23 to 24. (CHR-624, ADR-005)
- A board toolbar: a continuous 5-200 % zoom slider with step buttons and a live
  readout, `Fit all` and `100 %` as quick jumps, and a toggle that hides the flow
  edges. Ctrl/Cmd + wheel and pinch zoom around the cursor; zoom and the edge
  toggle persist per browser. Fit all is exact, so every tile is guaranteed
  inside the viewport — a real 186-screen project needs about 7.6 %, which is why
  the floor is 5 % rather than the designed 10 %. (CHR-623)
- An agent can present screens: a `board_state` change that came from an agent
  switches the open browser to the Board tab and names, in a dismissible banner,
  how many screens are on display. A change made by a human behaves exactly as
  before. (CHR-625)
- Follow mode: a topbar toggle, off by default and persisted per browser, makes
  the preview follow the agent — the view and selection move to what the agent
  touched and the affected nodes are highlighted briefly. An Activity tab beside
  Elements lists the last 50 calls and navigates on click, whether or not follow
  is on. Human navigation, comment mode and inspect mode pause following.
  (CHR-631)
- Every MCP tool call now emits one `activity` SSE event, derived from the tool
  name, its input and the handler's own response. Emission runs in a `finally`
  and can neither fail a call nor alter its response; the browser's own
  `/api/tools` path never goes through it. (CHR-630, ADR-005)
- `get_project` takes `fields:["reuse"]`: component and token coverage per screen
  and project-wide, the two as a combined score, unused components and tokens,
  and the ten screens with the lowest reuse. Project figures are the mean over
  screens, so one large screen cannot dominate. It costs nothing when not asked
  for; measured at 442 tokens against a 600 budget. (CHR-637)
- `write_html` and `patch_html` return `repeated_pattern` warnings when an ad-hoc
  element's full declaration set already occurs on another screen or matches a
  component root — the second occurrence of a pattern is exactly where it should
  be promoted. One warning per distinct pattern, capped at 8. (CHR-635)

### Changed

- `get_design_system` at `view:"tree"` now carries token values, grouped per
  bucket into one compact string, and every component's slot names beside its
  variants and usage. **Breaking:** `tree.tokens` was a `{path, kind}[]` list
  without values. On a 186-screen project the tree measures 8,974 tokens against
  a 10,000 budget, versus 70,042 for `full` — the agent guide now steers agents
  to `tree` before their first write. (CHR-636)
- The README documents the Board, Elements and Notes views and the mockup
  surface. (CHR-648)

### Fixed

- Drift warnings cover tracking, size and shorthand values, which previously
  passed unnoticed. (CHR-634)
- The project registry keys an open project by its real path, so a symlink and
  its target no longer produce two handles for one folder — two watchers, two SSE
  hubs and two board states, with an agent pinning screens the human's browser
  never saw. (CHR-650)
- Every project-scoped call the preview makes names its project instead of
  relying on the daemon-wide active-project fallback, which could answer a
  request with a different project than the tab was showing. (CHR-651)
- A rendered screen's asset and font URLs name the project they were rendered
  from. They reach the iframes as `srcdoc`, so their subresource requests hit the
  same daemon-wide fallback: a tab on project A could be served project B's image
  bytes, silently. `get_screenshot` and `inspect_node` inline their assets and
  were never affected. (CHR-653)
- A click in the activity feed pauses following, the way a sidebar click or a tab
  switch already did. Without it the view was pulled back to the agent's target
  on the next call, right after the human clicked something to look at. (CHR-652)

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
