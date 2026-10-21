import { describe, it, expect, vi } from "vitest";
import { createBridge, type BridgeDeps } from "./bridge.js";

const enc = new TextEncoder();

function sse(...messages: unknown[]): Response {
  const body = messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join("");
  // Two chunks, split mid-event, to prove the parser buffers across chunks.
  const cut = Math.floor(body.length / 2);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(body.slice(0, cut)));
      c.enqueue(enc.encode(body.slice(cut)));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const health = (version: string): Response => Response.json({ status: "ok", version });

function setup(
  route: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ports = [4711],
) {
  const out: string[] = [];
  const warnings: string[] = [];
  const queue = [...ports];
  const ensureDaemon = vi.fn(async () => ({
    port: queue.length > 1 ? (queue.shift() as number) : (queue[0] as number),
  }));
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    route(String(input), init),
  );
  const deps: BridgeDeps = {
    ensureDaemon,
    fetch: fetchMock as unknown as typeof fetch,
    write: (l) => out.push(l),
    warn: (l) => warnings.push(l),
    version: "2.0.0",
  };
  return { bridge: createBridge(deps), out, warnings, ensureDaemon, fetchMock };
}

const call = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("bridge forwarding", () => {
  it("POSTs the message to /mcp with the streamable-HTTP headers and relays the SSE answer line by line", async () => {
    const { bridge, out, fetchMock } = setup((url) =>
      url.endsWith("/health")
        ? health("2.0.0")
        : sse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    );
    await bridge.handleMessage(JSON.stringify(call));
    const post = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/mcp"));
    expect(post?.[1]?.method).toBe("POST");
    expect(post?.[1]?.body).toBe(JSON.stringify(call));
    expect(post?.[1]?.headers).toMatchObject({ accept: "application/json, text/event-stream" });
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", id: 1, result: { tools: [] } },
    ]);
  });

  it("relays a plain JSON answer and writes nothing for a 202 notification", async () => {
    const json = setup((url) =>
      url.endsWith("/health")
        ? health("2.0.0")
        : Response.json({ jsonrpc: "2.0", id: 1, result: {} }),
    );
    await json.bridge.handleMessage(JSON.stringify(call));
    expect(json.out).toEqual([JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })]);

    const note = setup((url) =>
      url.endsWith("/health") ? health("2.0.0") : new Response(null, { status: 202 }),
    );
    await note.bridge.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(note.out).toEqual([]);
    expect(note.warnings).toEqual([]);
  });

  it("looks the daemon up once and reuses it for later messages", async () => {
    const { bridge, ensureDaemon } = setup((url) =>
      url.endsWith("/health") ? health("2.0.0") : sse({ jsonrpc: "2.0", id: 1, result: {} }),
    );
    await bridge.handleMessage(JSON.stringify(call));
    await bridge.handleMessage(JSON.stringify(call));
    expect(ensureDaemon).toHaveBeenCalledTimes(1);
  });
});

describe("bridge auto-start and recovery", () => {
  it("ensures a daemon before the first message goes out", async () => {
    const order: string[] = [];
    const { bridge, ensureDaemon } = setup((url) => {
      order.push(url);
      return url.endsWith("/health") ? health("2.0.0") : sse({ jsonrpc: "2.0", id: 1, result: {} });
    });
    await bridge.handleMessage(JSON.stringify(call));
    expect(ensureDaemon).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["http://127.0.0.1:4711/health", "http://127.0.0.1:4711/mcp"]);
  });

  it("a daemon that went away mid-session is looked up again and the call still succeeds", async () => {
    let calls = 0;
    const { bridge, out, ensureDaemon } = setup(
      (url) => {
        if (url.endsWith("/health")) return health("2.0.0");
        if (url.includes(":4711/")) {
          calls++;
          if (calls > 1) throw new TypeError("fetch failed");
        }
        return sse({ jsonrpc: "2.0", id: 1, result: { n: url } });
      },
      [4711, 4712],
    );
    await bridge.handleMessage(JSON.stringify(call));
    await bridge.handleMessage(JSON.stringify(call));
    expect(ensureDaemon).toHaveBeenCalledTimes(2);
    expect(JSON.parse(out[1] as string).result.n).toBe("http://127.0.0.1:4712/mcp");
  });

  it("answers a request with a JSON-RPC error when the daemon cannot be reached at all", async () => {
    const { bridge, out, warnings } = setup(() => {
      throw new TypeError("fetch failed");
    });
    await bridge.handleMessage(JSON.stringify(call));
    expect(JSON.parse(out[0] as string)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603 },
    });
    expect(warnings).toHaveLength(1);
  });

  it("only warns, without a response line, when a notification cannot be delivered", async () => {
    const { bridge, out, warnings } = setup(() => {
      throw new TypeError("fetch failed");
    });
    await bridge.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(out).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe("bridge version check", () => {
  it("warns once on stderr naming both versions and the fix, then keeps forwarding", async () => {
    const { bridge, out, warnings } = setup((url) =>
      url.endsWith("/health") ? health("1.9.0") : sse({ jsonrpc: "2.0", id: 1, result: {} }),
    );
    await bridge.handleMessage(JSON.stringify(call));
    await bridge.handleMessage(JSON.stringify(call));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1.9.0");
    expect(warnings[0]).toContain("2.0.0");
    expect(warnings[0]).toContain("artisign update");
    expect(warnings[0]).toContain("artisign stop");
    expect(out).toHaveLength(2);
  });

  it("does not warn when the versions match", async () => {
    const { bridge, warnings } = setup((url) =>
      url.endsWith("/health") ? health("2.0.0") : sse({ jsonrpc: "2.0", id: 1, result: {} }),
    );
    await bridge.handleMessage(JSON.stringify(call));
    expect(warnings).toEqual([]);
  });
});

describe("bridge SSE parsing", () => {
  it("relays a 5 MB event split over many chunks, quickly and intact", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { big } })}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = enc.encode(body);
        for (let i = 0; i < bytes.length; i += 16 * 1024) c.enqueue(bytes.slice(i, i + 16 * 1024));
        c.close();
      },
    });
    const { bridge, out } = setup((url) =>
      url.endsWith("/health") ? health("2.0.0") : new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    );
    const started = Date.now();
    await bridge.handleMessage(JSON.stringify(call));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] as string).result.big).toHaveLength(big.length);
  });

  it("finds a separator that straddles two chunks, and several events in one chunk", async () => {
    const text = 'data: {"id":1}\n\ndata: {"id":2}\r\n\r\ndata: {"id":3}\n\n';
    for (const cut of [15, 16, 17, 30, 31]) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(text.slice(0, cut)));
          c.enqueue(enc.encode(text.slice(cut)));
          c.close();
        },
      });
      const { bridge, out } = setup((url) =>
        url.endsWith("/health") ? health("2.0.0") : new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      );
      await bridge.handleMessage(JSON.stringify(call));
      expect(out.map((l) => JSON.parse(l).id)).toEqual([1, 2, 3]);
    }
  });
});

describe("bridge version warning", () => {
  it("is not repeated when the daemon is reconnected with the same version", async () => {
    let fail = true;
    const { bridge, warnings } = setup((url) => {
      if (url.endsWith("/health")) return health("1.9.0");
      if (fail) {
        fail = false;
        throw new TypeError("fetch failed");
      }
      return sse({ jsonrpc: "2.0", id: 1, result: {} });
    });
    await bridge.handleMessage(JSON.stringify(call));
    expect(warnings.filter((w) => w.includes("1.9.0"))).toHaveLength(1);
  });
});

