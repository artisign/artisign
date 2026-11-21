import { defineConfig, defaultExclude } from "vitest/config";
import { TEST_TIMEOUT_MS } from "./vitest.timeouts.js";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
    // No test may reach the npm registry: the daemon's update checker reads this.
    env: { ARTISIGN_NO_UPDATE_CHECK: "1" },
    // Agent worktrees live under .claude/worktrees and carry full copies of
    // the suite; picking them up double-runs every test and collides on ports.
    exclude: [...defaultExclude, "**/.claude/**"],
  },
});
