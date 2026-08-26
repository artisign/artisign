import { defineConfig, defaultExclude } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Agent worktrees live under .claude/worktrees and carry full copies of
    // the suite; picking them up double-runs every test and collides on ports.
    exclude: [...defaultExclude, "**/.claude/**"],
  },
});
