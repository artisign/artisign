# Contributing

Thanks for the interest — but right now Artisign does not accept external code
contributions. Pull requests are closed without review.

The reason is licensing, not gatekeeping. Artisign is AGPL-3.0-only, and the
author is currently its sole copyright holder. Accepting outside patches would
split that ownership and remove the option to license the code differently
later. Until that is settled properly (via a DCO or CLA), the door stays shut.

## What is welcome

- **Bug reports.** Open an issue with the version, your OS, what you did, and
  what happened instead.
- **Feature ideas.** Open an issue and describe the design problem you hit. The
  problem is more useful than a proposed solution.
- **Questions about the tool.** Also an issue.

## How issues are handled

Public issues are the intake, not the backlog. The maintainer plans in a
private tracker; an issue that is going to be worked on is picked up there,
and the public issue is linked and closed when the fix or feature ships. An
issue that stays open has not been dismissed — it has not been scheduled.

## Developer setup

For working on Artisign itself (the maintainer, or a fork):

```bash
npm ci
npm test
```

To use the checkout instead of a globally installed `artisign`, run
`./artisign-dev.sh start [dir...]`: it builds, stops whichever Artisign is
running (both share `~/.artisign/` and port 4711), and starts this build in the
background. `./artisign-dev.sh stop` and `./artisign-dev.sh status` do what they
say.

The browser-backed suites (`get_screenshot`, `inspect_node`) drive whatever
supported browser is installed — Chrome, Edge, Brave, Chromium or Firefox —
and skip themselves when there is none; every other test runs. To test one
protocol in particular, pin the browser: `ARTISIGN_BROWSER=/path/to/firefox
npm test` exercises the WebDriver BiDi adapter, a Chromium-family path the
CDP one. CI runs both (see `.github/workflows/ci.yml`).

## Releasing

For the maintainer, cutting a release:

- `npm version <level>` bumps `package.json`.
- `server.json` carries the version twice — the top-level `version` and
  `packages[0].version` — and both are bumped in the same commit. The release
  workflow fails the build if either drifts from `package.json`.
- Update the CHANGELOG's `## [Unreleased]` section into a dated version
  section, and the README's status line.
- Push the `v*` tag. The Release workflow builds, tests, creates the GitHub
  Release and publishes to npm with provenance.
- Once npm has the new version, run `mcp-publisher publish` to update the
  entry at registry.modelcontextprotocol.io — deliberately manual, not part
  of CI.

## Forking

The AGPL gives you every right it promises: fork it, modify it, run it, offer it
as a network service — as long as you publish your modified source under the
AGPL too (see §13). One limit outside the license: "Artisign", its logo and its
domains are not part of the grant. Give your fork its own name.
