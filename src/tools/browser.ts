// Built-in browser driver for the tools that need a real render:
// `get_screenshot` and `inspect_node` (CHR-807 / ADR-007). No Playwright, no
// library and no browser download: it drives a browser that is already
// installed on the machine — Chromium-family browsers over the Chrome
// DevTools Protocol, Firefox over WebDriver BiDi — through Node's built-in
// WebSocket. Artisign still has exactly one document renderer
// (`renderScreenDocument`); the browser only lays out and captures it.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ToolError } from "./types.js";

export type BoundingBox = { x: number; y: number; width: number; height: number };
export type Viewport = { width: number; height: number };

export type Page = {
  /** Replaces the page's document with `html` and resolves once it has loaded and its fonts are ready. */
  setContent(html: string): Promise<void>;
  /** Evaluates a JS expression in the page (awaiting a returned promise) and returns its JSON-serializable value. */
  evaluate(expression: string): Promise<unknown>;
  /** A PNG of the viewport, of `clip` (document coordinates, CSS px), or of the whole document. */
  screenshot(options?: { clip?: BoundingBox; fullPage?: boolean }): Promise<Buffer>;
  setViewportSize(size: Viewport): Promise<void>;
};
export type BrowserContext = {
  newPage(): Promise<Page>;
  close(): Promise<void>;
};
export type Browser = {
  /** Browser name and version, e.g. "Chrome 141.0.7390.54" — reported with every capture. */
  name: string;
  newContext(options: { viewport: Viewport; deviceScaleFactor: number }): Promise<BrowserContext>;
  close(): Promise<void>;
};

export const BROWSER_KINDS = ["chrome", "edge", "brave", "chromium", "firefox"] as const;
export type BrowserKind = (typeof BROWSER_KINDS)[number];

/** Environment variable naming a browser executable that is used instead of the discovered one. */
export const BROWSER_ENV = "ARTISIGN_BROWSER";

const LABELS: Record<BrowserKind, string> = {
  chrome: "Chrome",
  edge: "Edge",
  brave: "Brave",
  chromium: "Chromium",
  firefox: "Firefox",
};

/**
 * Where each browser lives, in discovery order: Chromium-family first (closest
 * to what most people review the preview in), Firefox last — on many Linux
 * desktops the only browser there is. macOS: app bundles in /Applications or
 * ~/Applications. Linux: executables on PATH.
 */
const MAC_APPS: Record<BrowserKind, string> = {
  chrome: "Google Chrome.app/Contents/MacOS/Google Chrome",
  edge: "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  brave: "Brave Browser.app/Contents/MacOS/Brave Browser",
  chromium: "Chromium.app/Contents/MacOS/Chromium",
  firefox: "Firefox.app/Contents/MacOS/firefox",
};
const LINUX_BINARIES: Record<BrowserKind, string[]> = {
  chrome: ["google-chrome", "google-chrome-stable"],
  edge: ["microsoft-edge", "microsoft-edge-stable"],
  brave: ["brave-browser", "brave"],
  chromium: ["chromium", "chromium-browser"],
  firefox: ["firefox", "firefox-esr"],
};

export type InstalledBrowser = { kind: BrowserKind; executable: string };

export type DiscoveryOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
};

/** The kind an arbitrary executable path most likely is — decides CDP vs. BiDi for `ARTISIGN_BROWSER`. */
export function kindFromExecutable(executable: string): BrowserKind {
  const name = basename(executable).toLowerCase();
  if (name.includes("firefox")) return "firefox";
  if (name.includes("edge")) return "edge";
  if (name.includes("brave")) return "brave";
  if (name.includes("chromium")) return "chromium";
  return "chrome";
}

/** Every supported browser found on this machine, in discovery order. Pure apart from `exists`. */
export function discoverBrowsers(options: DiscoveryOptions = {}): InstalledBrowser[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const exists = options.exists ?? existsSync;

  const found: InstalledBrowser[] = [];
  for (const kind of BROWSER_KINDS) {
    const candidates =
      platform === "darwin"
        ? [join("/Applications", MAC_APPS[kind]), join(home, "Applications", MAC_APPS[kind])]
        : (env.PATH ?? "")
            .split(delimiter)
            .filter(Boolean)
            .flatMap((dir) => LINUX_BINARIES[kind].map((bin) => join(dir, bin)));
    const executable = candidates.find(exists);
    if (executable) found.push({ kind, executable });
  }
  return found;
}

export const NO_BROWSER_MESSAGE =
  "No supported browser found. Screenshots use a browser that is already installed on this machine — install " +
  `Chrome, Edge, Brave, Chromium or Firefox, or set ${BROWSER_ENV}=<path to a browser executable>.`;

/**
 * Picks the browser for one call: the requested `kind`, else the
 * `ARTISIGN_BROWSER` override, else the first one discovered. An explicit
 * `kind` that matches the override's kind uses the override's executable.
 */
export function selectBrowser(
  kind: BrowserKind | undefined,
  options: DiscoveryOptions = {},
): InstalledBrowser {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const override = env[BROWSER_ENV]?.trim();
  if (override) {
    if (!exists(override)) {
      throw new ToolError(
        "io_error",
        `${BROWSER_ENV}=${override} does not exist. Point it at a browser executable, or unset it.`,
      );
    }
    const overrideKind = kindFromExecutable(override);
    if (kind === undefined || kind === overrideKind)
      return { kind: overrideKind, executable: override };
  }
  const installed = discoverBrowsers(options);
  if (kind === undefined) {
    if (installed.length === 0) throw new ToolError("io_error", NO_BROWSER_MESSAGE);
    return installed[0]!;
  }
  const match = installed.find((b) => b.kind === kind);
  if (!match) {
    const available = installed.map((b) => b.kind).join(", ") || "none";
    throw new ToolError(
      "not_found",
      `browser "${kind}" is not installed on this machine (available: ${available}). Omit browser to use the default.`,
    );
  }
  return match;
}

// ---------------------------------------------------------------------------
// Process launch

/** Every browser process and temp profile still alive — killed/removed synchronously on process exit. */
const liveChildren = new Set<ChildProcess>();
const liveProfiles = new Set<string>();

const LAUNCH_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 30_000;
const CDP_LISTENING_PATTERN = /DevTools listening on (ws:\/\/\S+)/;
const BIDI_LISTENING_PATTERN = /WebDriver BiDi listening on (ws:\/\/\S+)/;

/**
 * Temp profiles live in a non-hidden directory under the home directory, not
 * in /tmp or ~/.artisign: a Snap- or Flatpak-packaged Firefox cannot see
 * either, and its launch then hangs instead of failing.
 */
function profileRoot(): string {
  return join(homedir(), "artisign-browser-profiles");
}

/**
 * Flags for Chromium-family browsers. `--no-sandbox` is deliberate (CHR-562):
 * Chromium's own sandbox needs user namespaces, which sandboxed Linux hosts
 * (CI runners, container-based MCP hosts) do not grant. What the browser
 * renders is the user's own local project, never arbitrary sites.
 * `--disable-dev-shm-usage` keeps the renderer alive where /dev/shm is tiny.
 */
function chromiumArgs(profile: string): string[] {
  return [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--mute-audio",
    "about:blank",
  ];
}

/** Prefs that keep a fresh Firefox profile from opening first-run or update pages. */
const FIREFOX_PREFS = [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("browser.aboutwelcome.enabled", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
  'user_pref("app.update.disabledForTesting", true);',
  // Light content regardless of the OS theme (0 = dark, 1 = light), matching the Chromium path.
  'user_pref("layout.css.prefers-color-scheme.content-override", 1);',
  'user_pref("ui.systemUsesDarkTheme", 0);',
].join("\n");

/**
 * A detached watchdog per browser: once the owning Artisign process is gone
 * — however it went, SIGTERM from an MCP host, SIGKILL or a crash, none of
 * which run an "exit" handler — it kills the browser and removes its
 * profile. Without it a stdio server killed by its host leaves a headless
 * browser running for good. It exits once the browser is closed normally,
 * or once it has cleaned up after the owner.
 */
const WATCHDOG_SCRIPT = `
const [owner, browser, profile] = process.argv.slice(1);
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; } };
const timer = setInterval(() => {
  if (alive(owner)) {
    // Closed normally: the owner removes the profile itself.
    if (!alive(browser)) clearInterval(timer);
    return;
  }
  clearInterval(timer);
  try { process.kill(Number(browser)); } catch {}
  setTimeout(() => require("node:fs").rmSync(profile, { recursive: true, force: true }), 2000);
}, 1000);`;

function startWatchdog(browserPid: number, profile: string): void {
  const watchdog = spawn(
    process.execPath,
    ["-e", WATCHDOG_SCRIPT, String(process.pid), String(browserPid), profile],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  watchdog.on("error", () => {}); // best effort — the exit handler and the stale-profile sweep still apply
  watchdog.unref();
}

/**
 * Spawns the browser with a clean 3-fd stdio array (some MCP hosts close
 * fds 3/4, CHR-562) and resolves with the WebSocket URL it prints on stderr.
 * stderr keeps being drained afterwards, so a chatty browser never blocks on
 * a full pipe.
 */
function spawnBrowser(
  executable: string,
  args: string[],
  pattern: RegExp,
  profile: string,
): Promise<{ child: ChildProcess; wsUrl: string }> {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  liveChildren.add(child);
  child.on("exit", () => liveChildren.delete(child));
  if (child.pid !== undefined) startWatchdog(child.pid, profile);
  child.stdout?.resume();
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error("timed out waiting for the browser to print its WebSocket endpoint"));
    }, LAUNCH_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = pattern.exec(output);
      if (match) {
        cleanup();
        child.stderr?.resume();
        resolve({ child, wsUrl: match[1]! });
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(
        new Error(
          `exited with code ${code} before printing its WebSocket endpoint${output ? `: ${output.trim().slice(-300)}` : ""}`,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stderr?.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

/** Kills `child` and resolves once it has exited (or after 5s), so its profile directory is no longer written to. */
function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

/**
 * Profile directories are named `<pid>-<uuid>`. A process that died without
 * its exit handler finishing (SIGKILL, crash) leaves its directory behind;
 * the next launch removes every directory whose owning process is gone.
 */
async function sweepStaleProfiles(root: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const pid = Number(entry.split("-")[0]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue; // still alive — not ours to remove
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") continue;
    }
    await rm(join(root, entry), { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// JSON-over-WebSocket transport, shared by both protocols

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

class Connection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
    ws.addEventListener("close", () => this.failAll(new Error("browser connection closed")));
  }

  static open(url: string): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Connection(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)), {
        once: true,
      });
    });
  }

  send(message: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `browser did not answer ${String(message.method)} within ${COMMAND_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, ...message }));
    });
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(data: string): void {
    const msg = JSON.parse(data) as {
      id?: number;
      result?: unknown;
      error?: unknown;
      message?: unknown;
    };
    if (msg.id === undefined) return; // an event — nothing here subscribes to any
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error !== undefined) {
      // CDP: { error: { message } }; BiDi: { error: "<code>", message }.
      const detail =
        typeof msg.error === "object" && msg.error !== null
          ? (msg.error as { message?: string }).message
          : `${String(msg.error)}: ${String(msg.message ?? "")}`;
      entry.reject(new Error(detail ?? "browser command failed"));
    } else {
      entry.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * Replaces the document in place and waits for `load` (images) and
 * `document.fonts.ready` — the same readiness `page.setContent` +
 * `document.fonts.ready` gave before. One script for both protocols.
 */
function setContentScript(html: string): string {
  return `(async () => {
    document.open();
    document.write(${JSON.stringify(html)});
    document.close();
    if (document.readyState !== "complete") await new Promise((r) => window.addEventListener("load", r, { once: true }));
    await document.fonts.ready;
  })()`;
}

const DOCUMENT_SIZE_SCRIPT =
  "({ width: Math.max(document.documentElement.scrollWidth, window.innerWidth), height: Math.max(document.documentElement.scrollHeight, window.innerHeight) })";

// ---------------------------------------------------------------------------
// Chromium family — Chrome DevTools Protocol

async function launchCdp(installed: InstalledBrowser, profile: string): Promise<Browser> {
  const { child, wsUrl } = await spawnBrowser(
    installed.executable,
    chromiumArgs(profile),
    CDP_LISTENING_PATTERN,
    profile,
  );
  const conn = await Connection.open(wsUrl);
  const cdp = (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> =>
    conn.send({ method, params, ...(sessionId ? { sessionId } : {}) }) as Promise<
      Record<string, unknown>
    >;

  const version = (await cdp("Browser.getVersion")) as { product?: string };
  const versionNumber = version.product?.split("/")[1] ?? "";

  return {
    name: `${LABELS[installed.kind]} ${versionNumber}`.trim(),
    async newContext({ viewport, deviceScaleFactor }) {
      const { browserContextId } = (await cdp("Target.createBrowserContext", {
        disposeOnDetach: true,
      })) as { browserContextId: string };
      return {
        async newPage() {
          const { targetId } = (await cdp("Target.createTarget", {
            url: "about:blank",
            browserContextId,
          })) as { targetId: string };
          const { sessionId } = (await cdp("Target.attachToTarget", {
            targetId,
            flatten: true,
          })) as { sessionId: string };
          let current = viewport;
          const setMetrics = (size: Viewport): Promise<unknown> =>
            cdp(
              "Emulation.setDeviceMetricsOverride",
              { width: size.width, height: size.height, deviceScaleFactor, mobile: false },
              sessionId,
            );
          await setMetrics(current);
          // Render light regardless of the OS theme, as the preview baseline
          // does — a dark OS otherwise paints the blank canvas dark.
          await cdp(
            "Emulation.setEmulatedMedia",
            { features: [{ name: "prefers-color-scheme", value: "light" }] },
            sessionId,
          );

          const evaluate = async (expression: string): Promise<unknown> => {
            const res = (await cdp(
              "Runtime.evaluate",
              { expression, awaitPromise: true, returnByValue: true },
              sessionId,
            )) as {
              result?: { value?: unknown };
              exceptionDetails?: { text?: string; exception?: { description?: string } };
            };
            if (res.exceptionDetails) {
              throw new Error(
                res.exceptionDetails.exception?.description ??
                  res.exceptionDetails.text ??
                  "evaluation failed",
              );
            }
            return res.result?.value;
          };

          return {
            setContent: async (html) => {
              await evaluate(setContentScript(html));
            },
            evaluate,
            async screenshot(options = {}) {
              let clip = options.clip;
              if (options.fullPage) {
                const size = (await evaluate(DOCUMENT_SIZE_SCRIPT)) as Viewport;
                clip = { x: 0, y: 0, width: size.width, height: size.height };
              }
              const params: Record<string, unknown> = { format: "png" };
              // `scale` is on top of the device scale factor, so 1 keeps the
              // output at clip x deviceScaleFactor — same as the viewport case.
              if (clip)
                Object.assign(params, { clip: { ...clip, scale: 1 }, captureBeyondViewport: true });
              const { data } = (await cdp("Page.captureScreenshot", params, sessionId)) as {
                data: string;
              };
              return Buffer.from(data, "base64");
            },
            async setViewportSize(size) {
              current = size;
              await setMetrics(size);
            },
          };
        },
        async close() {
          await cdp("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
        },
      };
    },
    async close() {
      await cdp("Browser.close").catch(() => {});
      conn.close();
      await killAndWait(child);
    },
  };
}

// ---------------------------------------------------------------------------
// Firefox — WebDriver BiDi

type RemoteValue = { type: string; value?: unknown };

/** Turns a BiDi RemoteValue back into a plain JS value (only the shapes the tools' scripts return). */
export function fromRemoteValue(rv: RemoteValue): unknown {
  switch (rv.type) {
    case "undefined":
    case "null":
      return rv.type === "null" ? null : undefined;
    case "string":
    case "boolean":
      return rv.value;
    case "number":
      return typeof rv.value === "number" ? rv.value : Number(rv.value);
    case "array":
      return ((rv.value as RemoteValue[]) ?? []).map(fromRemoteValue);
    case "object":
      return Object.fromEntries(
        ((rv.value as [string | RemoteValue, RemoteValue][]) ?? []).map(([k, v]) => [
          String(typeof k === "string" ? k : fromRemoteValue(k)),
          fromRemoteValue(v),
        ]),
      );
    default:
      return rv.value;
  }
}

async function launchBidi(installed: InstalledBrowser, profile: string): Promise<Browser> {
  await writeFile(join(profile, "user.js"), FIREFOX_PREFS);
  const { child, wsUrl } = await spawnBrowser(
    installed.executable,
    ["--headless", "--remote-debugging-port=0", "--no-remote", "--profile", profile, "about:blank"],
    BIDI_LISTENING_PATTERN,
    profile,
  );
  const conn = await Connection.open(`${wsUrl}/session`);
  const bidi = (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> =>
    conn.send({ method, params }) as Promise<Record<string, unknown>>;

  const session = (await bidi("session.new", { capabilities: {} })) as {
    capabilities?: { browserVersion?: string };
  };

  return {
    name: `${LABELS[installed.kind]} ${session.capabilities?.browserVersion ?? ""}`.trim(),
    async newContext({ viewport, deviceScaleFactor }) {
      const { userContext } = (await bidi("browser.createUserContext")) as { userContext: string };
      return {
        async newPage() {
          const { context } = (await bidi("browsingContext.create", {
            type: "tab",
            userContext,
          })) as { context: string };
          const setViewport = (size: Viewport): Promise<unknown> =>
            bidi("browsingContext.setViewport", {
              context,
              viewport: size,
              devicePixelRatio: deviceScaleFactor,
            });
          await setViewport(viewport);

          const evaluate = async (expression: string): Promise<unknown> => {
            const res = (await bidi("script.evaluate", {
              expression,
              target: { context },
              awaitPromise: true,
              resultOwnership: "none",
            })) as {
              type: "success" | "exception";
              result?: RemoteValue;
              exceptionDetails?: { text?: string };
            };
            if (res.type === "exception")
              throw new Error(res.exceptionDetails?.text ?? "evaluation failed");
            return res.result ? fromRemoteValue(res.result) : undefined;
          };

          return {
            setContent: async (html) => {
              await evaluate(setContentScript(html));
            },
            evaluate,
            async screenshot(options = {}) {
              const params: Record<string, unknown> = {
                context,
                origin: options.fullPage || options.clip ? "document" : "viewport",
              };
              if (options.clip) params.clip = { type: "box", ...options.clip };
              const { data } = (await bidi("browsingContext.captureScreenshot", params)) as {
                data: string;
              };
              return Buffer.from(data, "base64");
            },
            async setViewportSize(size) {
              await setViewport(size);
            },
          };
        },
        async close() {
          await bidi("browser.removeUserContext", { userContext }).catch(() => {});
        },
      };
    },
    async close() {
      await bidi("browser.close").catch(() => {});
      conn.close();
      await killAndWait(child);
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle

async function launch(installed: InstalledBrowser): Promise<Browser> {
  await sweepStaleProfiles(profileRoot());
  const profile = join(profileRoot(), `${process.pid}-${randomUUID()}`);
  await mkdir(profile, { recursive: true });
  liveProfiles.add(profile);
  const removeProfile = async (): Promise<void> => {
    liveProfiles.delete(profile);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  let browser: Browser;
  try {
    browser =
      installed.kind === "firefox"
        ? await launchBidi(installed, profile)
        : await launchCdp(installed, profile);
  } catch (err) {
    await removeProfile();
    const message = err instanceof Error ? err.message : String(err);
    throw new ToolError(
      "io_error",
      `Could not start ${LABELS[installed.kind]} (${installed.executable}): ${message}. ` +
        `Pass another installed browser via the browser input, or set ${BROWSER_ENV}=<path to a browser executable>.`,
    );
  }
  return {
    ...browser,
    close: async () => {
      try {
        await browser.close();
      } finally {
        await removeProfile();
      }
    },
  };
}

type Launcher = (installed: InstalledBrowser) => Promise<Browser>;
let launcher: Launcher = launch;
let select: (kind: BrowserKind | undefined) => InstalledBrowser = (kind) => selectBrowser(kind);

/** One running browser per executable, launched on first use and reused for every later call. */
const browsers = new Map<string, Promise<Browser>>();

export async function getBrowser(kind?: BrowserKind): Promise<Browser> {
  const installed = select(kind);
  let pending = browsers.get(installed.executable);
  if (!pending) {
    pending = launcher(installed);
    browsers.set(installed.executable, pending);
  }
  try {
    return await pending;
  } catch (err) {
    // Don't cache a failed launch — the next call retries from scratch.
    browsers.delete(installed.executable);
    throw err;
  }
}

/** Test-only: replace browser selection and/or launch. `undefined` restores the real one. */
export function __setBrowserForTests(
  options:
    { select?: (kind: BrowserKind | undefined) => InstalledBrowser; launch?: Launcher } | undefined,
): void {
  select = options?.select ?? ((kind) => selectBrowser(kind));
  launcher = options?.launch ?? launch;
}

/** Test-only: close every cached browser so the next call launches afresh. */
export async function __resetBrowserForTests(): Promise<void> {
  const prior = [...browsers.values()];
  browsers.clear();
  await Promise.all(prior.map((p) => p.then((b) => b.close()).catch(() => {})));
}

process.on("exit", () => {
  // An "exit" handler can't await a polite Browser.close — kill and clean up synchronously instead.
  for (const child of liveChildren) child.kill();
  for (const profile of liveProfiles) {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // Best effort: a locked file only leaves a stray profile directory behind.
    }
  }
});
