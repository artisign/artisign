import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => { on(event: "error", listener: () => void): unknown; unref(): void };

/** The platform's own "open this URL" command — built-ins only, no dependency. */
export function openerCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", '""', url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Opens `url` in the default browser: detached, stdio ignored, so the CLI neither waits for nor is held up by the
 * browser. A missing opener (no xdg-open on a server, say) is reported on the child's `error` event, not thrown —
 * that is swallowed here, because the URL has already been printed and the CLI exits 0 either way.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform, spawn: SpawnFn = nodeSpawn as SpawnFn): void {
  const { command, args } = openerCommand(url, platform);
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: platform === "win32" });
  child.on("error", () => {});
  child.unref();
}
