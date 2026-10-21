/** One reachable daemon: the port its `/mcp` listens on. */
export type BridgeDaemon = { port: number };

export type BridgeDeps = {
  /** Finds the running daemon or starts one, and waits until it is healthy. */
  ensureDaemon: () => Promise<BridgeDaemon>;
  fetch: typeof fetch;
  /** Writes one MCP message (a single line of JSON) to stdout. */
  write: (line: string) => void;
  /** Diagnostics — stderr only, stdout belongs to MCP. */
  warn: (line: string) => void;
  version: string;
};

type JsonRpcId = string | number | null;

const REQUEST_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

const SEPARATOR = /\r?\n\r?\n/;

/** The `data:` payload of one SSE event, or undefined when it has none. */
function eventData(event: string): string | undefined {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  return data === "" ? undefined : data;
}

/**
 * Incremental SSE splitter. A separator is searched for only in the new text plus the last 3 characters before it (the
 * most a separator can straddle), so a multi-megabyte event arriving in many chunks is scanned once, not once per chunk.
 */
function createSseSplitter(onData: (data: string) => void): (text: string) => void {
  let parts: string[] = [];
  let tail = "";
  return function push(text: string): void {
    const match = SEPARATOR.exec(tail + text);
    if (!match) {
      parts.push(text);
      tail = (tail + text).slice(-3);
      return;
    }
    const full = parts.join("") + text;
    const end = full.length - text.length + (match.index - tail.length);
    const rest = text.slice(match.index + match[0].length - tail.length);
    parts = [];
    tail = "";
    const data = eventData(full.slice(0, end));
    if (data !== undefined) onData(data);
    if (rest !== "") push(rest);
  };
}

/**
 * Forwards MCP messages between stdio and the daemon's stateless streamable-HTTP `/mcp`: each message is one POST, the
 * answer is a JSON body or an SSE stream (202 with no body for notifications and responses). The daemon is looked up
 * lazily and again after a connection failure, so a daemon that stopped or restarted mid-session costs one retry, not
 * the session. The bridge does not look inside messages and knows nothing about projects.
 */
export function createBridge(deps: BridgeDeps): { handleMessage: (line: string) => Promise<void> } {
  let daemon: Promise<BridgeDaemon> | undefined;
  const warnedVersions = new Set<string>();

  const connect = (): Promise<BridgeDaemon> => {
    daemon ??= deps.ensureDaemon().then(
      async (d) => {
        await checkVersion(d);
        return d;
      },
      (err: unknown) => {
        daemon = undefined;
        throw err;
      },
    );
    return daemon;
  };

  const checkVersion = async (d: BridgeDaemon): Promise<void> => {
    try {
      const res = await deps.fetch(`http://127.0.0.1:${d.port}/health`);
      const body = (await res.json()) as { version?: string };
      if (body.version === deps.version || warnedVersions.has(String(body.version))) return;
      warnedVersions.add(String(body.version));
      deps.warn(
        `artisign: the running daemon is ${body.version === undefined ? "an older version" : `v${body.version}`}, ` +
          `this bridge is v${deps.version}. Run \`artisign update\`; if you are already on the latest version, ` +
          "run `artisign stop` and retry.",
      );
    } catch {
      // The POST that follows reports an unreachable daemon.
    }
  };

  const post = async (line: string): Promise<Response> => {
    const { port } = await connect();
    return deps.fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: REQUEST_HEADERS, body: line });
  };

  const relay = async (res: Response): Promise<void> => {
    if (res.status === 202 || res.body === null) return;
    if (!res.headers.get("content-type")?.includes("text/event-stream")) {
      const text = (await res.text()).trim();
      if (text !== "") deps.write(JSON.stringify(JSON.parse(text)));
      return;
    }
    const decoder = new TextDecoder();
    const push = createSseSplitter((data) => deps.write(JSON.stringify(JSON.parse(data))));
    for await (const chunk of res.body) push(decoder.decode(chunk, { stream: true }));
  };

  const fail = (id: JsonRpcId | undefined, message: string): void => {
    deps.warn(`artisign: ${message}`);
    if (id !== undefined) deps.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } }));
  };

  const handleMessage = async (line: string): Promise<void> => {
    if (line.trim() === "") return;
    let id: JsonRpcId | undefined;
    try {
      id = (JSON.parse(line) as { id?: JsonRpcId }).id;
    } catch {
      deps.warn("artisign: ignoring a line on stdin that is not JSON");
      return;
    }
    try {
      let res: Response;
      try {
        res = await post(line);
      } catch {
        // Connection refused or reset: the daemon went away. Look it up (or start it) again, once.
        daemon = undefined;
        res = await post(line);
      }
      if (!res.ok && res.status !== 202) {
        fail(id, `the daemon answered ${res.status} ${(await res.text()).slice(0, 200)}`);
        return;
      }
      await relay(res);
    } catch (err) {
      daemon = undefined;
      fail(id, `could not reach the daemon: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return { handleMessage };
}
