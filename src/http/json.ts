import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Every write goes through one of these routes and lands in an append-only
// (comments.jsonl) or git-committed (screens/tokens/etc.) file — an
// unbounded body is both a memory-exhaustion vector (buffered fully before
// parsing) and, once committed, a permanent multi-hundred-MB blob in the
// project's history. 256KB comfortably covers real tool inputs/comments.
const MAX_BODY_BYTES = 256 * 1024;

export class PayloadTooLargeError extends Error {}

/**
 * Reads and JSON-parses a request body; `{}` for an empty body. Rejects
 * with `PayloadTooLargeError` once the body exceeds `MAX_BODY_BYTES` (and
 * stops reading further), or a plain `Error` on invalid JSON — callers
 * decide how to report each.
 */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        settled = true;
        // Deliberately not req.destroy(): killing the socket before the
        // caller has written a response races the client's fetch and
        // surfaces as a raw connection-reset instead of our 413. Just stop
        // buffering — the remaining bytes are read and discarded, not
        // retained, so this still bounds memory, which is what matters for
        // a single-writer localhost tool (per ADR-001's threat model).
        reject(new PayloadTooLargeError(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
