# Artisign

An artificial artisan for UI design: agents build screens, a design system keeps them consistent.

Local-first UX design tool for AI agents. Agents design through MCP, the human reviews in the browser, state lives in plain files.

One Node process on `127.0.0.1`. No database, no accounts, no hosting.

**Status:** Stable (`2.0.0`) — CLI, store, parser/model, the 25-tool MCP surface, browser preview with live reload/flows/comments, screen variants with side-by-side compare, the design system (tokens, variants, drift warnings, `promote_to_system`), and packaging are all implemented. Artisign designs its own browser preview — see [Designed with itself](#designed-with-itself).

## Why

1. **Consistency across screens** — the design system is first-class; screens store refs, never inline values
2. **Token efficiency** — tiered reads, field selection, diff mode on writes
3. **Flows as first-class** — click routes are data, not documentation
4. **Render determinism** — the preview renders the source, so preview equals output by construction

## Install

**Requirements.** Node.js ≥ 22.4 on **macOS or Linux** — Windows is not supported (the store's atomic writes and path handling have never been verified there, so `package.json` makes `npm install` refuse the platform). For screenshots, a browser that is already installed: Chrome, Edge, Brave, Chromium or Firefox — see **Screenshots** below.

```bash
npm install -g artisign
artisign
```

1. `npm install -g artisign` — once.
2. `artisign` — starts Artisign's background process (the *daemon*), opens the preview in your browser and, on first run, offers to connect your AI tool. After connecting, quit and reopen the AI tool so it picks up the new entry.
3. Ask your AI tool to create or open a project: *"Create an Artisign project in ~/work/acme"*. The project folder (and any missing parent folders) is created for you; the AI tool passes an absolute path, since Artisign does not expand `~` itself. Writes are committed to git automatically (`autoCommit`, on by default) — Artisign runs `git init` in the project on the first write, needs `git` installed for that, and skips the commit rather than fail when it is missing or the folder sits inside another repo.

**Check it works.** Ask your AI tool *"List my Artisign projects"* — it calls `list_projects` and the project you just created appears, and in the preview's project picker too.

**Two copies, one version.** The global install is the `artisign` command you type. Your AI tool's entry runs the same version, pinned, through `npx` (downloaded once on its first launch) as a small stdio bridge; `artisign update` keeps the two in step. Whichever starts first — you with `artisign`, or the bridge when your AI tool connects — starts the daemon; both use the same `~/.artisign` and port, so there is only ever one. The daemon inherits the environment of the process that started it: to make a variable such as `ARTISIGN_BROWSER` stick, run `artisign` from your shell before your AI tool does (`artisign stop` first if it is already running); putting it in the entry's `env` also works, but `artisign setup` rewrites entries, so add it again after an update.

**Updating.** Run `artisign update` (also `artisign --update`). It installs the latest version with `npm install -g artisign@latest`, re-pins the `artisign` entries in your AI tools to it and restarts a running Artisign of an older version with its open projects. Then quit and reopen your AI tool, so it launches the re-pinned entry. It does nothing when you are already on the latest version, and never uses `sudo`. Nothing is updated automatically: `artisign` checks the npm registry for a newer release at most once a day and prints one line (`New version x.y.z — run artisign update`) when there is one. Set `ARTISIGN_NO_UPDATE_CHECK=1` to turn that off.

**Troubleshooting.**

- **`EACCES` on `npm install -g`** — npm cannot write to its global folder. Never fix this with `sudo`. Use a Node you own (for example through [nvm](https://github.com/nvm-sh/nvm)), or point npm at a folder in your home: `npm config set prefix ~/.npm-global`, then add `~/.npm-global/bin` to your `PATH`.
- **nvm** — a global install belongs to one Node version. After switching versions, run `npm install -g artisign` and `artisign setup` again.
- **pnpm, bun or yarn** — install with `pnpm add -g artisign`, `bun add -g artisign` or `yarn global add artisign`; update with the same command and `@latest` (`artisign update` only *prints* that command for these installs, it does not run it). Then run `artisign setup` to connect your AI tool and re-pin its entries.

**Screenshots.** `get_screenshot` and `inspect_node` render in a real browser — one that is already on your machine. Artisign finds Chrome, Edge, Brave, Chromium or Firefox by itself (in that order) and drives it headless through the browser's own remote protocol: the Chrome DevTools Protocol for the Chromium family, WebDriver BiDi for Firefox. Nothing to install, no Playwright, no browser download.

- **Pick a browser explicitly** with `ARTISIGN_BROWSER=/path/to/browser` in the environment of the process that runs the daemon. The name decides the protocol: a path containing `firefox` is driven over BiDi, anything else over CDP.
- **Cross-browser check.** Both tools take an optional `browser` input (`"chrome"`, `"edge"`, `"brave"`, `"chromium"`, `"firefox"`), and every result names the browser and version that rendered it — so an agent can check the same screen in a second installed browser before calling it done.
- **Each launch uses a fresh, throwaway profile** in `~/artisign-browser-profiles/`, removed when the browser closes. It lives under your home directory, not `/tmp`, because a Snap- or Flatpak-packaged Firefox cannot see `/tmp`.
- **No browser installed** (a bare server or container): both tools fail with the fix in the error message; every other tool works without one. Installing `chromium` or `firefox-esr` from the distribution's packages is enough.

**Privacy.** Artisign collects nothing — no telemetry, no account, no server beyond the local one it runs. These requests reach the network, none of them about you, and that is the complete list: the update check (at most once a day) asks `registry.npmjs.org` for the latest version and sends nothing else; `artisign update` runs `npm`, and the `npx` in your AI tool's entry fetches the pinned version from npm, both talking to the npm registry; `import_html` fetches whatever URL you hand it; and the first render of a project fetches the font families named in your tokens — plus the Material Symbols Rounded icon font, always (a copy shipped with the package is the fallback when that fails) — from Google Fonts, then caches them locally (see [Fonts & icons](#fonts--icons)). Everything else stays on `127.0.0.1`.

## Quickstart

`artisign` on its own is `artisign start`. It starts the background process, opens `http://127.0.0.1:<port>/` in your browser once it is healthy — also when it was already running — and, the first time, offers (once, in a terminal and outside CI) to connect the AI tools it finds. Answering no is remembered; `artisign setup` works any time. Pass `--no-open` (or set `ARTISIGN_NO_OPEN=1`) to skip the browser; it is skipped anyway when `CI` is set or stdout is not a terminal, and when no browser can be opened the URL is printed and that is all. `serve`, `mcp`, `status`, `stop` and `init` never open a browser.

Then ask your AI tool for a project. Or do it yourself:

```bash
artisign init ./my-project    # scaffold an empty project
artisign start ./my-project   # start (or reuse) the background process with it open
artisign status               # pid, port, open projects
```

The remaining commands, for reference — this block is a catalogue, not a sequence:

```bash
artisign serve ./my-project   # foreground (development); opens the project on start
artisign stop                 # stop the background process
artisign help [command]       # also: artisign <command> --help
```

Artisign is **multi-project**: one process on `127.0.0.1:4711` holds several projects open at once. Open or create projects from the browser UI (project picker in the topbar), or let agents address any project by name or path in the `project` input of each tool call — `list_projects` shows the names. No restart when you switch.

## Advanced

**Connecting an AI tool.** `artisign setup` connects Claude Code, Claude Desktop, Cursor, Codex CLI, VS Code and opencode. For each one it finds, it asks, then writes a user-level entry named `artisign` that runs `npx -y artisign@<version> mcp`, pinned to the version that ran setup; other entries and settings are left untouched. Claude Code is driven through its own `claude mcp` CLI and Codex CLI through `codex mcp add/remove` (it honours `CODEX_HOME`) when those are on your `PATH`; GUI clients (Claude Desktop, Cursor, VS Code) get the `npx` found on your `PATH`, as an absolute path, because they do not inherit your shell's. A config file that holds comments or trailing commas is never rewritten — setup prints the entry to add by hand instead — and a symlinked config is written through. `--yes` connects every tool found without asking (the only way to run without a terminal); `artisign setup --remove` removes exactly the `artisign` entries. Run it again after an update to re-pin (`artisign update` does so for you). Quit and reopen the AI tool after setup, so it picks up the entry.

**Manual entry.** If you don't run setup, add the same stdio server to your AI tool by hand, pinned to the version you installed (`artisign --version`). A terminal client (Claude Code, Codex CLI, opencode) can use plain `npx`:

```bash
claude mcp add --scope user --transport stdio artisign -- npx -y artisign@<version> mcp
```

A GUI client (Claude Desktop, Cursor, VS Code) does not inherit your shell's `PATH`, so give it the absolute path of your `npx` (`which npx`) and a `PATH` that starts with its directory — this is what setup writes. For Claude Desktop, in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "artisign": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "artisign@<version>", "mcp"],
      "env": { "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" }
    }
  }
}
```

Replace `/opt/homebrew/bin` with the directory `which npx` shows. Quit and reopen the client afterwards.

`artisign mcp` is a stdio bridge: it forwards every MCP message to the running background process and starts it if it is not running, so it is the same backend whichever client connects. It takes no project directory — the project is named in each tool call.

**State and ports.** The port comes from `~/.artisign/config.json` or `--port N` on `start` and `serve` (a `settings.port` in a project's `artisign.json` is deprecated and ignored). Daemon-level state — that config plus the `daemon.lock` holding the running pid and port — lives in `~/.artisign`. Set `ARTISIGN_HOME` to move it somewhere else; that, together with `--port`, is what lets a second daemon run fully isolated from the first, which is worth doing before you try anything destructive against projects you care about.

**Just trying it.** `npx artisign` runs it once without installing.

## The 25 tools

Every tool except `list_projects`, `init_project` and `get_guide` takes a required `project` input: a known project's name (as `list_projects` returns it) or an absolute path to a project folder. There is no implicit "current project" for agents.

| Bucket | Tool | Does |
|---|---|---|
| Reads | `get_guide` | The design methodology guide (`docs/agent-guide.md`), on demand. |
| Reads | `get_project` | Screen list, design-system pointer, counts. Tiered, cold-start read; `tree` also carries each screen's `viewport` (`{ width, height, declared }` — the frame it renders at, 390×844 when the root declares no px width) and each variant screen's `variant_of`/`variant_kind`. |
| Reads | `get_screen` | One screen with comment/flow indicators. Tiered + field selection; `full` adds its direct `variants` and `reached_from`. |
| Reads | `get_node` | Subtree of one node, addressed as `<screen>.<node-id>`. Tiered + field selection. |
| Reads | `get_design_system` | Tokens, components (with variants and the default variant's slot names), and patterns. `tree` carries every token value, grouped by bucket. |
| Reads | `find_nodes` | Where-query across screens (style ref, component ref, variant, comments, text, flow). |
| Reads | `list_comments` | Open/resolved comments, filtered by screen or node. |
| Reads | `get_mockup` | A mockup's variants — raw HTML, outside the ref model. |
| Writes | `write_html` | Create or fully replace a screen from augmented HTML. |
| Writes | `patch_html` | Surgical patch by node ref or CSS selector: replace, insert, delete, set attr. |
| Writes | `update_refs` | Change a node's token/component/variant bindings without a full HTML parse. |
| Writes | `set_tokens` | Design-system token mutation — one call re-resolves every bound screen. |
| Writes | `set_flow` | Mutate a flow edge in `flows.json` without touching any screen file. |
| Writes | `set_meta` | Screen notes/tags and `variant_of`/`variant_kind`, design-system idea/decisions, component/pattern usage, a tag's own notes — the handoff contract. |
| Writes | `write_mockup` | Create or revise one variant of a mockup — raw HTML, outside the design system. |
| Writes | `set_board_state` | Read or mutate the Board's shared filter, pinned screens and expanded variant clusters — daemon memory only. |
| Lifecycle | `list_projects` | Every project the daemon has opened or created, as `{ name, root, open }`; works with no project open. |
| Lifecycle | `init_project` | Scaffold a project directory: empty, from HTML, or from a Stitch export URL. Returns `project`, the name to pass in later calls. |
| Lifecycle | `import_html` | Incremental HTML ingest into an existing project, with content-hash dedup. |
| Lifecycle | `promote_to_system` | Lift an inline value or a repeated element into a token, component, or pattern. |
| Lifecycle | `promote_mockup` | Copy a chosen mockup variant into a new, design-system-bound screen (the mockup stays). |
| Lifecycle | `delete_entity` | Delete a screen, component, pattern, or mockup; refuses a component still referenced by a screen, and a screen that still has variants (`has_variants`) unless `cascade: true` deletes the whole subtree. |
| Comments | `reply_comment` | Answer a comment and optionally resolve it. |
| Visual review | `get_screenshot` | Screenshots a rendered screen (or one node), or one mockup variant, as a PNG — the write → screenshot → adjust loop. |
| Visual review | `inspect_node` | Computed box and styles of one node as text — cheaper than vision for geometry questions. |

### The write → screenshot → adjust loop

`get_screenshot` renders a screen (or, given `node`, crops to one element) exactly the way the browser preview does — same parse, same `renderScreen` — and returns a PNG, so an agent can see what a write actually produced instead of only inspecting markup. Typical use: `write_html`/`patch_html`, then `get_screenshot` to review, then adjust.

It renders in a browser already installed on the machine, and the result names which one — see **Screenshots** under [Install](#install) above. Pass `browser` to check the same screen in another installed browser.

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
├── screens/<name>.meta.json      # notes, tags, and variant_of/variant_kind when the screen is a variant
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

What an instance contributes is exactly what it writes: the component ref picks
the definition, `data-variant` picks the template, its children fill the slots,
and every other attribute on the element — `style`, extra classes, `href`,
`aria-*`, `data-flow-target` — lands on the expanded root. The instance wins
over the definition on a conflict; `style` and `class` accumulate, with the
instance's declarations last so they win the inline cascade. Only the tag is
the definition's call. The example above therefore renders the hover template
with `padding-inline: 16px` on top of whatever the definition sets.

Everything is human-readable and diffable. With `autoCommit` on (the `init` default), every write op becomes one git commit named after the tool and its target (`write_html: dashboard`, `set_tokens: color.primary`, ...) — that is the audit log.

## Browser preview

Served at `http://127.0.0.1:<port>` once the daemon is running — plain ES modules, no build step:

- **Project picker** — switch between open projects in the topbar; open an existing folder or create a new project through an in-app folder browser, which can also make a new folder (no restart needed). With nothing open, an empty state offers both actions, recent projects, and a ready-made prompt for your AI tool ("Create an Artisign project in ~/work/acme").
- **Screens** — sidebar screen tree, rendered source (preview = output, by construction). Variants nest under their parent with a kind icon (state, overlay, step) and tag chips; expand state is kept per browser, and pinning a group row pins its whole subtree
- **Variant context** — a screen that is a variant, or has variants, shows a breadcrumb above the canvas and a variant tree map beside it; the inspector lists the flow sources a screen is "Also reached from"
- **Compare** — `Single | Compare · N` in the screen view puts the family's main screen (the locked reference) and 1–3 of its variants side by side in 2–4 columns, with a diff overlay marking nodes added, changed and removed against the reference. Nodes are matched by authored `id` only; below 25 % shared authored ids that column shows no diff, only a banner saying the diff is unavailable
- **Board** — every screen laid out as a tile on one scrollable surface, with flow edges drawn between them (toggleable), a 5%–200% zoom slider (Fit all, 100%, or Ctrl/Cmd+wheel/pinch to zoom around the cursor), and the sidebar's shared filter plus any screen pinned onto the board regardless of the filter, so a flow is something you see rather than something you reconstruct. A screen with variants is drawn as a cluster — a frame around the main screen with thumbnails of its variants — that expands into one column per depth (about 8 tiles per depth, then "+N more"); which clusters are open is shared between tabs and agents via `set_board_state`, and a per-browser Clusters On/Off toggle switches back to flat tiles
- **Elements panel** — the selected screen's nodes listed by the id an agent addresses them with
- **Notes panel** — the screen's own notes plus any tag notes that apply to it, both rendered as Markdown
- **Flow mode** — click an element with `data-flow-target` to jump to the screen it points at
- **Comment mode** — click an element to anchor a comment; appended to `comments.jsonl`, picked up by `list_comments` / answered via `reply_comment`
- **Design System** — token swatches by bucket, every component with every variant rendered side by side
- **Mockup view** — a mockup's variants rendered live, side by side in columns, each with its title and description
- **Follow mode** — off by default; the topbar's Follow toggle (three states: off / Following / Follow paused) makes the preview track a live agent session's own MCP tool calls, switching the view/selection to whatever it touches and briefly outlining the affected nodes (solid teal for a read, dashed violet + wash for a write, or a dashed border + "Updated" badge around the whole screen after `write_html`). Every tool call also lands in the right panel's new Activity tab (last 50, in-memory, newest first) regardless of follow's own state. Human navigation — a screen/tab click, clicking an entry in the Activity feed, or opening comment/inspect mode — pauses it; only the toggle's own "Resume" un-pauses it
- Live reload over SSE — any file change on disk shows up in the browser within ~200 ms

## Deterministic render baseline

Every rendered surface — screens pane, Design System variants, and `get_screenshot` — wraps the rendered fragment in the same small baseline document, so what an agent designs is what renders everywhere, pixel for pixel. The guarantee: `box-sizing: border-box` on every element, zero `body` margin, antialiased text. A screen root declared `width: 390px` with padding measures exactly 390px — no implicit UA margin or box-model surprise to account for.

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

The reference stays portable in the source file. At render time it resolves two ways, the same split webfonts use: a page loaded over HTTP (the preview iframe, `/api/render/*`) gets it rewritten to `/api/assets/<path>?project=<path>` unconditionally, tagged with the project it was rendered from so a subresource request out of an iframe's `srcdoc` still resolves against the right project even with several open at once — a path that doesn't resolve to a file under `assets/` still gets the URL, and 404s there, rather than being checked against the filesystem twice; a headless render with no HTTP base URL (`get_screenshot`, `inspect_node`) gets it inlined as a `data:` URI instead, and there an unresolvable path is left as-is. Either way, the browser's own broken-image handling makes the problem visible rather than the image silently vanishing.

## Repo structure

```
src/cli/            CLI entry point — init, start, stop, status, serve, mcp, setup, update, help
src/daemon/          daemon lifecycle — project registry, global config/lock (~/.artisign)
src/init/            project scaffolding (init) and artisign.json
src/store/           Store interface, FsStore, watcher, atomic writes, git auto-commit
src/model/           HTML parser, canonical ref model, index
src/tools/           the 25 tools (reads, writes, lifecycle, comments, visual review)
src/mcp/             MCP server (streamable HTTP) and the stdio bridge to it
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
artisign serve design
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
