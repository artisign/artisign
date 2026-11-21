/**
 * Spawning on Windows. npm, npx, claude and codex are `.cmd` shims there, and since Node 20 (CVE-2024-27980) a `.cmd` or
 * `.bat` is refused without `shell: true`. With a shell, Node joins the command and its arguments into one line for
 * `cmd.exe` unescaped, so every part is quoted here — and an argument that cannot be quoted safely is rejected, never guessed at.
 */

export type SpawnPlan = { command: string; args: string[]; shell: boolean };

const SAFE = /^[A-Za-z0-9_\-.:\\/@=+,]+$/;
/** Inside double quotes `cmd.exe` still expands `%VAR%` and `!VAR!`, and a `"` or a line break ends the quoting. */
const UNQUOTABLE = /["%!\r\n]/;

/** One word for a `cmd.exe` command line: plain when it is safe, in double quotes when it holds spaces or operators. */
export function quoteCmdArg(arg: string): string {
  if (arg !== "" && SAFE.test(arg)) return arg;
  if (UNQUOTABLE.test(arg)) throw new Error(`cannot pass ${JSON.stringify(arg)} through cmd.exe safely`);
  // A trailing backslash would escape the closing quote for the child's argument parser.
  return `"${arg.replace(/\\+$/, (m) => m + m)}"`;
}

/** Whether `command` is a Windows batch file that only runs through `cmd.exe`. */
export const isWindowsBatch = (command: string, platform: NodeJS.Platform): boolean =>
  platform === "win32" && /\.(cmd|bat)$/i.test(command);

/**
 * How to start `command`: unchanged everywhere except for a `.cmd`/`.bat` on Windows, which runs through a shell as one
 * already-quoted command line with no args array — Node joins args with `shell: true` unescaped anyway and, since Node 24,
 * warns about it (DEP0190) on every call.
 */
export function spawnPlan(command: string, args: string[], platform: NodeJS.Platform = process.platform): SpawnPlan {
  if (!isWindowsBatch(command, platform)) return { command, args, shell: false };
  return { command: [command, ...args].map(quoteCmdArg).join(" "), args: [], shell: true };
}
