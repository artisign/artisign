# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.9.x   | ✅        |
| < 0.9   | ❌        |

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
accounts, and sends no telemetry. The only outbound requests are the
`import_html` tool fetching a URL the agent supplies, and Google Fonts: on the
first render of a project the daemon fetches every font family named in its
tokens plus the Material Symbols Rounded icon font, which is requested
unconditionally (a bundled copy is used only if that request fails), and
caches them locally. Reports about behaviour that
requires an attacker to already control the local machine or the MCP client
are still welcome, but they are prioritised accordingly.
