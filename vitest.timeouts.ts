// Test timeouts, defined once. The Windows runner is slower (process spawn,
// file system), so its values are higher; macOS and Linux keep vitest's default.
const isWindows = process.platform === "win32";

/** Per-test and per-hook timeout (vitest's default is 5000 ms). */
export const TEST_TIMEOUT_MS = isWindows ? 20_000 : 5_000;

/** For tests that deliberately get more than the default (daemon start, registry, many projects). */
export const LONG_TEST_TIMEOUT_MS = isWindows ? 30_000 : 10_000;

/** Propagation budget for a file event reaching an SSE client (watcher latency is much higher on Windows). */
export const SSE_EVENT_BUDGET_MS = isWindows ? 5_000 : 1_000;
