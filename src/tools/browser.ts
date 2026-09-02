// Shared Playwright lifecycle for tools that need a headless render:
// `get_screenshot` and `inspect_node`. Extracted
// out of screenshot.ts so the browser-launch/fallback logic has exactly one
// implementation.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ToolError } from "./types.js";

export type PWBoundingBox = { x: number; y: number; width: number; height: number };
export type PWLocator = {
  first(): PWLocator;
  count(): Promise<number>;
  boundingBox(): Promise<PWBoundingBox | null>;
};
export type PWPage = {
  setContent(html: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options?: { clip?: PWBoundingBox; fullPage?: boolean }): Promise<Buffer>;
  locator(selector: string): PWLocator;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
};
export type PWContext = {
  newPage(): Promise<PWPage>;
  close(): Promise<void>;
};
export type Browser = {
  newContext(options: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<PWContext>;
  close(): Promise<void>;
};
type PlaywrightModule = {
  chromium: {
    launch(): Promise<Browser>;
    // Only needed by the fd-3/4-avoiding fallback below.
    executablePath(): string;
    connectOverCDP(wsEndpoint: string): Promise<Browser>;
  };
};
type ImportPlaywright = () => Promise<PlaywrightModule>;

// A non-literal specifier keeps TS from trying (and failing) to resolve
// playwright's own module/type declarations at compile time — the whole
// point of the lazy import.
const PLAYWRIGHT_MODULE = "playwright";

/** Environment variable naming a directory whose `node_modules/playwright` is used instead of the one next to Artisign. */
export const PLAYWRIGHT_DIR_ENV = "ARTISIGN_PLAYWRIGHT_DIR";

/**
 * Where `playwright` gets imported from. By default the specifier `"playwright"`,
 * resolved by Node from the tree Artisign itself lives in — which is why an
 * install into the *design project* is never seen, and why nothing at all
 * works while Artisign runs from npx's cache (CHR-576). With
 * `ARTISIGN_PLAYWRIGHT_DIR` set, the module is resolved from that directory's
 * own `node_modules` instead, so Playwright can live anywhere — a dedicated
 * `~/.artisign-playwright`, say — without touching the repo's lockfile and
 * regardless of how Artisign was installed.
 *
 * Resolving with `createRequire` from the directory (rather than importing a
 * hand-built path) honours the package's own `exports`/`main` and gives a
 * clean, nameable failure when the directory has no Playwright in it.
 */
export function resolvePlaywrightSpecifier(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env[PLAYWRIGHT_DIR_ENV]?.trim();
  if (!dir) return PLAYWRIGHT_MODULE;
  try {
    return pathToFileURL(createRequire(join(dir, "package.json")).resolve(PLAYWRIGHT_MODULE)).href;
  } catch {
    throw new ToolError(
      "io_error",
      `${PLAYWRIGHT_DIR_ENV}=${dir} does not contain an installed Playwright (no node_modules/playwright there). ` +
        `Run in that directory: npm install playwright && npx playwright install chromium — or unset ${PLAYWRIGHT_DIR_ENV}.`,
    );
  }
}

const defaultImportPlaywright: ImportPlaywright = () => import(resolvePlaywrightSpecifier()) as Promise<PlaywrightModule>;

let importPlaywright: ImportPlaywright = defaultImportPlaywright;

export function __setPlaywrightImportForTests(fn: ImportPlaywright | undefined): void {
  importPlaywright = fn ?? defaultImportPlaywright;
}

const DEVTOOLS_LISTENING_PATTERN = /DevTools listening on (ws:\/\/\S+)/;
const MANUAL_LAUNCH_TIMEOUT_MS = 15_000;

/**
 * Flags for the manual spawn below. `--no-sandbox` is deliberate (CHR-562):
 * Chromium's own sandbox needs user namespaces, which a sandboxed Linux host
 * (CI runners, container-based MCP hosts) does not grant — the process then
 * dies before printing its DevTools endpoint, and those hosts are precisely
 * the ones this fallback exists for. It drops no boundary the primary path
 * keeps: `pw.chromium.launch()` passes `--no-sandbox` itself unless
 * `chromiumSandbox: true` is requested, and this server never requests it.
 * What the browser renders is the user's own project — local, agent-authored
 * HTML in a `setContent` page — not arbitrary sites, which is why Playwright
 * defaults that way too. `--disable-dev-shm-usage` mirrors the other
 * Playwright default that matters on such hosts, where `/dev/shm` is too
 * small for Chromium's shared memory and the renderer crashes mid-page.
 */
const MANUAL_LAUNCH_ARGS = ["--headless=new", "--remote-debugging-port=0", "--no-sandbox", "--disable-dev-shm-usage"];

/**
 * Fallback launch path: `pw.chromium.launch()` always asks Node to open a
 * 5-fd stdio array for the browser process (fds 3/4 carry Playwright's own
 * pipe transport to Chromium's `--remote-debugging-pipe`). Some MCP hosts
 * spawn this server through a sandbox wrapper that restricts/closes extra
 * fds, which makes that launch fail with `spawn EBADF` — not reproducible
 * locally, but real in dogfooding. Spawning Chromium ourselves
 * with an explicit, clean 3-fd stdio array and talking to it over a
 * websocket (parsed from stderr) instead structurally avoids fds 3/4.
 */
async function launchBrowserManually(pw: PlaywrightModule): Promise<Browser> {
  const child = spawn(pw.chromium.executablePath(), MANUAL_LAUNCH_ARGS, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const wsEndpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for Chromium to print its DevTools websocket endpoint"));
    }, MANUAL_LAUNCH_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = DEVTOOLS_LISTENING_PATTERN.exec(output);
      if (match) {
        cleanup();
        resolve(match[1]!);
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Chromium exited with code ${code} before printing its DevTools websocket endpoint`));
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

  let browser: Browser;
  try {
    browser = await pw.chromium.connectOverCDP(wsEndpoint);
  } catch (err) {
    child.kill();
    throw err;
  }
  return {
    newContext: (options) => browser.newContext(options),
    // connectOverCDP() only disconnects on close() — we own this process
    // (we spawned it), so close it ourselves too.
    close: async () => {
      try {
        await browser.close();
      } finally {
        child.kill();
      }
    },
  };
}

/**
 * The install command that actually works in a checkout of this repo, and in
 * a project that installed `artisign` locally. Playwright is an *optional
 * peer* dependency, so it has to be asked for by name; `--no-save` keeps
 * `package.json` and the lockfile out of it, which is the point of the
 * optional-peer decision. Named once here so the three failure messages
 * below cannot drift apart.
 */
export const PLAYWRIGHT_INSTALL_HINT =
  "in the directory Artisign is installed in, run: npm install --no-save playwright && npx playwright install chromium " +
  `— or install it in any directory and point ${PLAYWRIGHT_DIR_ENV} at that directory (see README, 'Optional: screenshots')`;

export const PLAYWRIGHT_MISSING_MESSAGE = `Playwright is not installed. To install it, ${PLAYWRIGHT_INSTALL_HINT}.`;

/**
 * Resolvability is not usability: a half-reaped symlink or a partial copy
 * still imports — as a module with no `chromium`, or a `chromium` with no
 * `launch` — and without this check that surfaces as a raw TypeError
 * (`Cannot read properties of undefined (reading 'launch')`) from deep inside
 * the launch path, which is the outcome the missing-module message exists to
 * prevent (CHR-576). Everything the launch path touches is checked here.
 */
function describeUnusablePlaywright(pw: unknown): string | undefined {
  const mod = pw as Partial<PlaywrightModule> | null | undefined;
  const chromium = mod?.chromium as Partial<PlaywrightModule["chromium"]> | undefined;
  if (!chromium || typeof chromium !== "object") return "the module exports no `chromium`";
  for (const fn of ["launch", "executablePath", "connectOverCDP"] as const) {
    if (typeof chromium[fn] !== "function") return `\`chromium.${fn}\` is not a function`;
  }
  return undefined;
}

async function launchBrowser(): Promise<Browser> {
  let pw: PlaywrightModule;
  try {
    pw = await importPlaywright();
  } catch (err) {
    // A bad ARTISIGN_PLAYWRIGHT_DIR already carries its own remedy.
    if (err instanceof ToolError) throw err;
    // Node does not cache a failed module resolution, and a failed launch is
    // not cached below either, so a Playwright installed *after* this error
    // is picked up on the next call — no daemon restart needed for this case.
    throw new ToolError("io_error", PLAYWRIGHT_MISSING_MESSAGE);
  }

  const unusable = describeUnusablePlaywright(pw);
  if (unusable !== undefined) {
    // Unlike the missing case, a successful-but-broken import *is* cached by
    // Node for the life of the process, so a repair only takes effect after a
    // restart. Say so, or the trap is a correct fix that changes nothing.
    throw new ToolError(
      "io_error",
      `Playwright is installed but unusable (${unusable}) — a partial or broken install, or a symlink whose target went away. ` +
        `Reinstall it: ${PLAYWRIGHT_INSTALL_HINT}. Then restart the Artisign daemon: it holds on to the broken module until it is restarted.`,
    );
  }

  try {
    return await pw.chromium.launch();
  } catch (primaryErr) {
    // A missing browser download is its own failure, separate from
    // the fd-3/4 EBADF case the manual fallback exists for. Spawning the
    // executable ourselves would fail for the very same reason and bury the
    // remedy under a second error message, so answer it directly.
    const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    if (primaryMsg.includes("Executable doesn't exist")) {
      throw new ToolError("io_error", "Playwright is installed but its browser is missing. Run: npx playwright install chromium");
    }
    try {
      return await launchBrowserManually(pw);
    } catch (fallbackErr) {
      const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new ToolError(
        "io_error",
        `Chromium launch failed (${primaryMsg}); fallback launch also failed (${fallbackMessage}). ` +
          `If Playwright or its browser is incomplete, reinstall: ${PLAYWRIGHT_INSTALL_HINT}.`,
      );
    }
  }
}

let browserPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) browserPromise = launchBrowser();
  try {
    return await browserPromise;
  } catch (err) {
    // Don't cache a rejected launch — let the next call retry from scratch.
    browserPromise = null;
    throw err;
  }
}

/** Test-only: drop (and close) the cached browser so the next call re-launches, picking up a fresh `__setPlaywrightImportForTests` mock. */
export async function __resetBrowserForTests(): Promise<void> {
  const prior = browserPromise;
  browserPromise = null;
  if (!prior) return;
  await prior.then((browser) => browser.close()).catch(() => {});
}

process.on("exit", () => {
  // Best-effort only: an "exit" handler can't await. On a forced
  // `process.exit()` this may not finish, but it beats leaking silently.
  void browserPromise?.then((browser) => browser.close()).catch(() => {});
});
