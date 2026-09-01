# Artisign

An artificial artisan for UI design: agents build screens, a design system keeps them consistent.

Local-first UX design tool for AI agents. Agents design through MCP, the human reviews in the browser, state lives in plain files.

One Node process on `127.0.0.1`. No database, no accounts, no hosting.

**Status:** Beta (`0.9.0`) — CLI, store, parser/model, the 23-tool MCP surface, browser preview with live reload/flows/comments, the design system (tokens, variants, drift warnings, `promote_to_system`), and packaging are all implemented. Artisign designs its own browser preview — see [Designed with itself](#designed-with-itself).

## Why

1. **Consistency across screens** — the design system is first-class; screens store refs, never inline values
2. **Token efficiency** — tiered reads, field selection, diff mode on writes
3. **Flows as first-class** — click routes are data, not documentation
4. **Render determinism** — the preview renders the source, so preview equals output by construction

## Install

Node.js ≥ 20.19, on **macOS or Linux**. **Windows is not supported** — the store's atomic writes (write temp file, then `rename`) and its path handling have never been verified there, so the tool is not shipped for it. `package.json` declares this via `os`, which makes `npm install` refuse the platform rather than fail somewhere later.

**Two ways to run it, and the choice matters.** `npx artisign` fetches the package on first use and needs no setup — the fastest way to try it, and enough for everything except the two screenshot tools. Installing it into a directory of your own is the other path, and the one to pick if you want screenshots:

```bash
mkdir artisign && cd artisign
npm install artisign
```

The commands below are written as `npx artisign`. With a local install, run `./node_modules/.bin/artisign` instead — or `npm install -g artisign` and just `artisign`.

**Canonical quickstart.** The local install, from an empty directory to a connected agent. Start the daemon before registering the MCP server — the HTTP registration below runs against an already-running daemon:

```bash
mkdir artisign && cd artisign
npm install artisign
./node_modules/.bin/artisign start ./my-project
claude mcp add --transport http artisign "http://127.0.0.1:4711/mcp?project=/absolute/path/to/my-project"
```

The first two lines repeat the install above on purpose: the point of this block is that nothing has to be assembled from elsewhere. On the npx path, drop them and start with `npx artisign start ./my-project` instead — the screenshot tools are then unavailable, as described below.

**Optional: screenshots.** `get_screenshot` and `inspect_node` need a real browser, which is intentionally not bundled (`npx artisign` stays light without it). Playwright is an **optional peer dependency** — npm neither installs it nor its ~150 MB of browser binaries unless you ask for them. Run this **in the same directory you installed `artisign` into**:

```bash
npm install playwright && npx playwright install chromium
```

`artisign` imports Playwright dynamically, so Node resolves it from the tree `artisign` itself lives in: installing Playwright into your design project has no effect, and no placement works at all while `artisign` runs from npx's cache. The npx path and the screenshot tools are mutually exclusive — that is the one thing the two install options above actually decide. If Playwright isn't installed, both tools fail with the install command in the error message rather than crashing the server; every other tool works without it.

**Register the MCP server.**

Claude Desktop — stdio, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "artisign": {
      "command": "npx",
      "args": ["artisign", "mcp", "/absolute/path/to/my-project"]
    }
  }
}
```

Claude Code — stdio:

```bash
claude mcp add artisign -- npx artisign mcp /absolute/path/to/my-project
```

Recommended — against the running daemon (`npx artisign start`), streamable HTTP instead of spawning a second process. Bake the project into the URL, one stable entry per coding project:

```bash
claude mcp add --transport http artisign "http://127.0.0.1:4711/mcp?project=/absolute/path/to/my-project"
```

The `?project=` parameter scopes every tool call to that project (auto-opening it on first use), so several coding projects can share one daemon without ever restarting it. Without the parameter, calls go to the project currently active in the browser UI. `init_project` works even while no project is open.

**Privacy.** Artisign collects nothing — no telemetry, no account, no server beyond the local one it runs, no update check. Two things reach the network, neither of them about you: `import_html` fetches whatever URL you hand it, and the first render of a project fetches the font families named in your tokens — plus the Material Symbols Rounded icon font, always — from Google Fonts, then caches them locally (see [Fonts & icons](#fonts--icons)).

## Quickstart

First run, in this order:

```bash
npx artisign init ./my-project    # scaffold an empty project
npx artisign start ./my-project   # start the daemon in the background and open the project
npx artisign status               # pid, port, open projects
# then open http://127.0.0.1:4711
```

The remaining commands, for reference — this block is a catalogue, not a sequence:

```bash
npx artisign serve ./my-project   # foreground daemon (development); opens the project on start
npx artisign mcp ./my-project     # stdio MCP server for Claude Desktop / Claude Code
npx artisign stop                 # stop the daemon
```

`artisign --help` lists the flags each command accepts.

The daemon is **multi-project**: it runs permanently on `127.0.0.1:4711` and can hold several projects open at once. Open or create projects from the browser UI (project picker in the topbar), or let agents address any project directly via the MCP URL — no restart when you switch projects. The port comes from `~/.artisign/config.json` or `--port N` on `start` and `serve` (a `settings.port` in a project's `artisign.json` is deprecated and ignored).

Daemon-level state — that config plus the `daemon.lock` holding the running pid and port — lives in `~/.artisign`. Set `ARTISIGN_HOME` to move it somewhere else; that, together with `--port`, is what lets a second daemon run fully isolated from the first, which is worth doing before you try anything destructive against projects you care about.

## The 23 tools

| Bucket | Tool | Does |
|---|---|---|
| Reads | `get_guide` | The design methodology guide (`docs/agent-guide.md`), on demand. |
| Reads | `get_project` | Screen list, design-system pointer, counts. Tiered, cold-start read. |
| Reads | `get_screen` | One screen with comment/flow indicators. Tiered + field selection. |
| Reads | `get_node` | Subtree of one node, addressed as `<screen>.<node-id>`. Tiered + field selection. |
| Reads | `get_design_system` | Tokens, components (with variants), and patterns. |
| Reads | `find_nodes` | Where-query across screens (style ref, component ref, variant, comments, text, flow). |
| Reads | `list_comments` | Open/resolved comments, filtered by screen or node. |
| Reads | `get_mockup` | A mockup's variants — raw HTML, outside the ref model. |
| Writes | `write_html` | Create or fully replace a screen from augmented HTML. |
| Writes | `patch_html` | Surgical patch by node ref or CSS selector: replace, insert, delete, set attr. |
| Writes | `update_refs` | Change a node's token/component/variant bindings without a full HTML parse. |
| Writes | `set_tokens` | Design-system token mutation — one call re-resolves every bound screen. |
| Writes | `set_flow` | Mutate a flow edge in `flows.json` without touching any screen file. |
| Writes | `set_meta` | Screen notes/tags, design-system idea/decisions, component/pattern usage — the handoff contract. |
| Writes | `write_mockup` | Create or revise one variant of a mockup — raw HTML, outside the design system. |
| Lifecycle | `init_project` | Scaffold a project directory: empty, from HTML, or from a Stitch export URL. |
| Lifecycle | `import_html` | Incremental HTML ingest into an existing project, with content-hash dedup. |
| Lifecycle | `promote_to_system` | Lift an inline value or a repeated element into a token, component, or pattern. |
| Lifecycle | `promote_mockup` | Copy a chosen mockup variant into a new, design-system-bound screen (the mockup stays). |
| Lifecycle | `delete_entity` | Delete a screen, component, pattern, or mockup; refuses a component still referenced by a screen. |
| Comments | `reply_comment` | Answer a comment and optionally resolve it. |
| Visual review | `get_screenshot` | Screenshots a rendered screen (or one node), or one mockup variant, as a PNG — the write → screenshot → adjust loop. |
| Visual review | `inspect_node` | Computed box and styles of one node as text — cheaper than vision for geometry questions. |

### The write → screenshot → adjust loop

`get_screenshot` renders a screen (or, given `node`, crops to one element) exactly the way the browser preview does — same parse, same `renderScreen` — and returns a PNG, so an agent can see what a write actually produced instead of only inspecting markup. Typical use: `write_html`/`patch_html`, then `get_screenshot` to review, then adjust.

It needs Playwright — see the optional dependency in [Install](#install) above.

`scale` (default `1`) is the screenshot's device scale factor — `1x` is enough for most visual review; go higher only when pixel-level detail matters, since a larger image costs more tokens once it reaches a model.

## An Artisign project on disk

```
<project>/
├── artisign.json                 # name, version, settings (autoCommit)
├── design-system/
│   ├── tokens.json               # color / spacing / typography / radius / shadow / motion
│   ├── components/<name>.html    # component + variants
│   └── patterns/<name>.html      # layout + interaction patterns
├── screens/<name>.html           # augmented HTML, one file per screen
├── mockups/<name>/mockup.json    # design explorations: variant titles/descriptions, outside the ref model
├── mockups/<name>/<variant>.html # raw HTML per variant, written verbatim
├── assets/                       # local images, referenced as assets/<path>
├── flows.json                    # click routes between screens
├── comments.jsonl                # append-only, anchored to node ids
└── .artisign/                    # derived cache, gitignored — safe to delete, rebuilt on next `serve`
```

Screens are augmented HTML — `$name` in `class` is a component ref, `$name` in `style` values is a token ref:

```html
<button id="btn-login" class="$btn-primary" data-variant="hover"
        style="padding-inline: $spacing.md" data-flow-target="dashboard">
  Log in
</button>
```

Everything is human-readable and diffable. With `autoCommit` on (the `init` default), every write op becomes one git commit named after the tool and its target (`write_html: dashboard`, `set_tokens: color.primary`, ...) — that is the audit log.

## Browser preview

Served at `http://127.0.0.1:<port>` once the daemon is running — plain ES modules, no build step:

- **Project picker** — switch between open projects in the topbar; open an existing folder or create a new project through an in-app folder browser (no restart needed). With nothing open, an empty state offers both actions plus recent projects.
- **Screens** — sidebar screen list, rendered source (preview = output, by construction)
- **Flow mode** — click an element with `data-flow-target` to jump to the screen it points at
- **Comment mode** — click an element to anchor a comment; appended to `comments.jsonl`, picked up by `list_comments` / answered via `reply_comment`
- **Design System** — token swatches by bucket, every component with every variant rendered side by side
- Live reload over SSE — any file change on disk shows up in the browser within ~200 ms

## Deterministic render baseline

Every rendered surface — screens pane, Design System variants, and (later) `get_screenshot` — wraps the rendered fragment in the same small baseline document, so what an agent designs is what renders everywhere, pixel for pixel. The guarantee: `box-sizing: border-box` on every element, zero `body` margin, antialiased text. A screen root declared `width: 390px` with padding measures exactly 390px — no implicit UA margin or box-model surprise to account for.

## Fonts & icons

Any font family named in `design-system/tokens.json`'s `typography` bucket (e.g. `"600 24px/1.2 'Plus Jakarta Sans', sans-serif"`) is fetched once from Google Fonts as woff2 and cached under `.artisign/fonts/` — offline-first after the first `serve`. A fetch failure (no network, unknown family) is silent: the render falls back to the system font, it never blocks.

Icons are Material Symbols Rounded, always cached alongside your typography fonts, used via ligature names:

```html
<span class="icon">close</span>
```

Never substitute a Unicode glyph for an icon — the `.icon` class and the ligature name are what make the rendered result deterministic.

## Images

Drop a local image into a project's `assets/` folder (subfolders are fine) and reference it as a project-relative path, `assets/<path>`, in an `src` attribute or a CSS `url()`:

```html
<img src="assets/hero.png">
<div style="background-image: url(assets/icons/logo.svg)"></div>
```

The reference stays portable in the source file. At render time it resolves two ways, the same split webfonts use: a page loaded over HTTP (the preview iframe, `/api/render/*`) gets it rewritten to `/api/assets/<path>`; a headless render with no HTTP base URL (`get_screenshot`, `inspect_node`) gets it inlined as a `data:` URI instead. A path that doesn't resolve to a file under `assets/` is left as-is, so the browser's own broken-image handling makes the problem visible rather than the image silently vanishing.

## Repo structure

```
src/cli/            CLI entry point — init, start, stop, status, serve, mcp
src/daemon/          daemon lifecycle — project registry, global config/lock (~/.artisign)
src/init/            project scaffolding (init) and artisign.json
src/store/           Store interface, FsStore, watcher, atomic writes, git auto-commit
src/model/           HTML parser, canonical ref model, index
src/tools/           the 23 tools (reads, writes, lifecycle, comments, visual review)
src/mcp/             MCP server — stdio + streamable HTTP
src/http/            internal JSON API + SSE, consumed by the preview
src/preview/         browser preview — plain ES modules, no build step
design/              the tool's own UI, designed with the tool (see below)
scripts/             one-off dev tooling, not shipped in the npm package
```

## Designed with itself

Artisign's own browser preview is designed in Artisign. [`design/`](design/) is a real
project in the on-disk format described above — tokens, components, screens, flows — and
it is the source the interface you see at `127.0.0.1:4711` was designed from.

Every token that has a counterpart in the shipped `src/preview/style.css` `:root` block —
all 19 colours, the six spacing steps, `radius.pill` and `shadow.menu` — mirrors it by value
*and* by role name, so those cannot quietly drift apart: change one and the mismatch is
visible in the other. The typography scale and `radius.sm`/`radius.md` have no custom
property behind them, so they are design decisions rather than a mirror. Values with no
counterpart at all stay literal rather than implying a binding that does not exist. Open it
the same way as any other project:

```bash
npx artisign serve design
```

That makes it the largest worked example in the repo, and the honest answer to whether the
tool is good enough to build with — it built this one.

## Development

```bash
npm install
npm run type-check   # tsc --noEmit
npm run lint         # eslint
npm test             # vitest run
npm run build        # compile src/ to dist/
npm run dev -- serve ./my-project   # run the CLI from source via tsx
```

Only `dist/`, `src/preview/` (minus its test files), `assets/` and the two guide documents in `docs/` ship in the published package — see `files` in `package.json`. `prepack` runs the build automatically before `npm pack`/`npm publish`, so the tarball can't ship a stale `dist/`.

## Documentation

| What | Where |
|---|---|
| Design methodology for agents (normative, served by `get_guide`) | [`docs/agent-guide.md`](docs/agent-guide.md) |
| The same workflow long-form, for humans and skill authors | [`docs/design-workflow-tutorial.md`](docs/design-workflow-tutorial.md) |
| The tool's own UI, designed with the tool | [`design/`](design/) — see [Designed with itself](#designed-with-itself) |

## Issues & security

Bug reports, feature ideas and questions go to the
[issue tracker](https://github.com/artisign/artisign/issues) — pick the matching
template. Vulnerabilities go through private reporting instead, never a public
issue: see [`SECURITY.md`](SECURITY.md). Code contributions are currently not
accepted; [`CONTRIBUTING.md`](CONTRIBUTING.md) explains why and what is welcome.

## License

Copyright (C) 2026 Christian Körbs

Artisign is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free Software
Foundation, version 3.

Artisign is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>. The full text is
in [`LICENSE`](LICENSE).

Two things the license does not cover:

- **Your designs are yours.** The AGPL covers Artisign's own source code, not the
  screens, components, tokens or projects you create with it. Files Artisign
  writes into your project folder belong entirely to you.
- **The name is not licensed.** "Artisign", its logo and its domains are not part
  of the AGPL grant. Forks may use the code but need their own name.
