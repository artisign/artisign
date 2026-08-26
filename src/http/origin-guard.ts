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

/** `application/json`, ignoring any `; charset=...` suffix. */
export function hasJsonContentType(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.split(";")[0]!.trim() === "application/json";
}
