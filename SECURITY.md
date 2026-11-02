# Security Policy

## Supported versions

Only the latest release on npm gets security fixes; update with
`artisign update`.

| Version         | Supported |
| --------------- | --------- |
| Latest release  | ✅        |
| Older releases  | ❌        |

## Reporting a vulnerability

Please report vulnerabilities through **GitHub Private Vulnerability
Reporting**: open the repository's _Security_ tab and click _Report a
vulnerability_, or go directly to

<https://github.com/artisign/artisign/security/advisories/new>

The report is visible only to the maintainer until a fix is published.

**There is no security mailbox.** Mail sent to any address at `artisign.dev`
is not delivered, so do not try `security@artisign.dev` — it goes nowhere.
Reporting requires a GitHub account.

Do **not** open a public issue for a vulnerability.

## What to expect

- An acknowledgement within **72 hours**.
- Coordinated disclosure: the details stay private until a fixed release is
  available, for at most **90 days** after the report unless we agree
  otherwise.
- Credit in the release notes if you want it.

## Scope notes

Artisign is a local tool: the daemon binds only to `127.0.0.1`, keeps no
accounts, and sends no telemetry. Its own outbound requests are the update
check (at most once a day, `registry.npmjs.org`, nothing sent), `artisign
update` and the `npx` entry in your AI tool talking to the npm registry, and
Google Fonts: on the first render of a project the daemon fetches every font
family named in its tokens plus the Material Symbols Rounded icon font, which
is requested unconditionally (a bundled copy is used only if that request
fails), and caches them locally. Artisign does not fetch URLs on an agent's
behalf. A remote `https://` URL written into a screen's own HTML (an image, a
stylesheet) is loaded by the browser that renders it, like any web page.

Screen, component and mockup HTML never runs scripts: the preview iframe is
sandboxed without `allow-scripts`, and every rendered document, including the
headless render of `get_screenshot` and `inspect_node`, carries a
`script-src 'none'` Content Security Policy. `<script>`, `on*` handlers and
`javascript:` URLs stay in the file but do not execute.

Reports about behaviour that
requires an attacker to already control the local machine or the MCP client
are still welcome, but they are prioritised accordingly.
