import type { IncomingMessage } from "node:http";

const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Blocks cross-origin browser requests to the local API/MCP surface. Any
 * webpage the user has open can otherwise issue same-machine fetch() calls
 * to 127.0.0.1 and, without this check, have them executed as this project's
 * agent tools (write_html, etc.) — the browser's CORS preflight doesn't
 * apply to "simple requests" like a text/plain POST, so Origin is the only
 * signal available.
 *
 * A request with no Origin header (curl, an MCP client over HTTP, this
 * project's own tests) is not a browser request and is allowed — Origin is
 * a header browsers attach automatically and scripts cannot forge.
 */
export function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (!ALLOWED_HOSTNAMES.has(originUrl.hostname)) return false;

  // Loopback alone isn't a security boundary — other local processes bind
  // to 127.0.0.1 on different ports too. Require the origin's port to match
  // the port this very request came in on.
  const host = req.headers.host;
  const hostPort = host?.split(":")[1] ?? "";
  return originUrl.port === hostPort;
}

/**
 * Rejects requests whose `Host` header is not a loopback host on the port the
 * request arrived on. This closes the DNS-rebinding read path: after an
 * attacker domain is rebound to 127.0.0.1, the victim's browser issues
 * same-origin GETs to `http://attacker.example:<port>/...`. Such requests
 * carry no `Origin` header, so `isAllowedOrigin` lets them through, yet the
 * page can read the responses (project paths, designs, `/events`). The
 * browser always sends the attacker's hostname in `Host`, and a script cannot
 * override it, so checking it before any routing blocks the attack.
 *
 * The port is compared with `req.socket.localPort` (the port the connection
 * really came in on), not with anything the client claims. A missing or
 * unparseable `Host` is rejected. IPv6 hosts arrive bracketed (`[::1]:4711`).
 */
export function isAllowedHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const parsed = parseHostHeader(host);
  if (!parsed) return false;
  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) return false;
  const localPort = req.socket.localPort;
  return localPort !== undefined && parsed.port === String(localPort);
}

function parseHostHeader(host: string): { hostname: string; port: string } | null {
  const match = /^(?:\[([0-9a-fA-F:]+)\]|([^:[\]/\s]+))(?::(\d{1,5}))?$/.exec(host);
  if (!match) return null;
  return { hostname: (match[1] ?? match[2]!).toLowerCase(), port: match[3] ?? "80" };
}

/** `application/json`, ignoring any `; charset=...` suffix. */
export function hasJsonContentType(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.split(";")[0]!.trim() === "application/json";
}
