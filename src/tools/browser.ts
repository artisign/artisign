// Shared Playwright lifecycle for tools that need a headless render:
// `get_screenshot` and `inspect_node`. Extracted
// out of screenshot.ts so the browser-launch/fallback logic has exactly one
// implementation.

import { spawn } from "node:child_process";
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
const defaultImportPlaywright: ImportPlaywright = () => import(PLAYWRIGHT_MODULE) as Promise<PlaywrightModule>;

let importPlaywright: ImportPlaywright = defaultImportPlaywright;

export function __setPlaywrightImportForTests(fn: ImportPlaywright | undefined): void {
  importPlaywright = fn ?? defaultImportPlaywright;
}

const DEVTOOLS_LISTENING_PATTERN = /DevTools listening on (ws:\/\/\S+)/;
const MANUAL_LAUNCH_TIMEOUT_MS = 15_000;

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
  const child = spawn(pw.chromium.executablePath(), ["--headless=new", "--remote-debugging-port=0"], {
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

async function launchBrowser(): Promise<Browser> {
  let pw: PlaywrightModule;
  try {
    pw = await importPlaywright();
  } catch {
    throw new ToolError(
      "io_error",
      "Playwright is not installed. Run: npm install playwright && npx playwright install chromium",
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
          "Run: npm install playwright && npx playwright install chromium",
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
