import { describe, it, expect, vi } from "vitest";
import { runUpdate, runRepin, type UpdateDeps } from "./update.js";

function setup(
  over: Partial<UpdateDeps> & {
    latest?: string;
    installCode?: number;
    installStderr?: string;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const npmCalls: string[] = [];
  const deps: UpdateDeps = {
    currentVersion: "1.0.0",
    entryPath: "/usr/local/lib/node_modules/artisign/dist/cli/index.js",
    npm: vi.fn(async (args: string[]) => {
      npmCalls.push(args.join(" "));
      if (args[0] === "view") return { code: 0, stdout: `${over.latest ?? "2.0.0"}\n`, stderr: "" };
      if (args[0] === "install")
        return { code: over.installCode ?? 0, stdout: "", stderr: over.installStderr ?? "" };
      return { code: 0, stdout: "/usr/local/lib/node_modules\n", stderr: "" };
    }),
    exists: () => true,
    repin: vi.fn(async () => 0),
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    ...over,
  };
  return { deps, out, err, npmCalls };
}

describe("update", () => {
  it("says so and changes nothing when already on the latest version", async () => {
    const { deps, out, npmCalls } = setup({ latest: "1.0.0" });
    expect(await runUpdate(deps)).toBe(0);
    expect(out.join("\n")).toContain("already the latest");
    expect(npmCalls).toEqual(["view artisign version"]);
    expect(deps.repin).not.toHaveBeenCalled();
  });

  it("does not downgrade a build that is ahead of the registry", async () => {
    const { deps, npmCalls } = setup({ latest: "0.9.0" });
    expect(await runUpdate(deps)).toBe(0);
    expect(npmCalls).toEqual(["view artisign version"]);
  });

  it("installs latest globally, then re-pins from the newly installed entry", async () => {
    const { deps, npmCalls } = setup();
    expect(await runUpdate(deps)).toBe(0);
    expect(npmCalls).toEqual(["view artisign version", "install -g artisign@latest", "root -g"]);
    expect(deps.npm).toHaveBeenCalledWith(["install", "-g", "artisign@latest"], true);
    expect(deps.repin).toHaveBeenCalledWith(
      "/usr/local/lib/node_modules/artisign/dist/cli/index.js",
    );
  });

  it("an npm failure other than permissions prints no prefix advice", async () => {
    const { deps, err } = setup({ installCode: 1, installStderr: "npm error code ETARGET" });
    expect(await runUpdate(deps)).toBe(1);
    expect(err).toEqual(["Update failed, nothing was changed."]);
    expect(deps.repin).not.toHaveBeenCalled();
  });

  it("falls back to the running binary's entry when npm's global root does not hold the new version", async () => {
    const { deps } = setup({ exists: () => false });
    expect(await runUpdate(deps)).toBe(0);
    expect(deps.repin).toHaveBeenCalledWith(
      "/usr/local/lib/node_modules/artisign/dist/cli/index.js",
    );
  });

  it("an npm failure (EACCES) gives one message with the fix, exit 1, and re-pins nothing", async () => {
    const { deps, err } = setup({ installCode: 243, installStderr: "npm error code EACCES" });
    expect(await runUpdate(deps)).toBe(1);
    expect(err.join("\n")).toMatch(
      /permission denied[\s\S]*nvm[\s\S]*npm config set prefix[\s\S]*sudo/,
    );
    expect(deps.repin).not.toHaveBeenCalled();
  });

  it("a failed registry lookup is an error and installs nothing", async () => {
    const { deps, npmCalls } = setup({
      npm: vi.fn(async () => ({ code: 1, stdout: "", stderr: "ENOTFOUND" })),
    });
    expect(await runUpdate(deps)).toBe(1);
    expect(deps.npm).toHaveBeenCalledTimes(1);
    expect(npmCalls).toEqual([]);
  });

  it.each([
    [
      "/Users/x/Library/pnpm/global/5/node_modules/artisign/dist/cli/index.js",
      "pnpm add -g artisign@latest",
    ],
    [
      "/Users/x/.bun/install/global/node_modules/artisign/dist/cli/index.js",
      "bun add -g artisign@latest",
    ],
    [
      "/Users/x/.config/yarn/global/node_modules/artisign/dist/cli/index.js",
      "yarn global add artisign@latest",
    ],
  ])(
    "an install by another package manager prints its command and touches nothing (%s)",
    async (entryPath, command) => {
      const { deps, out } = setup({ entryPath });
      expect(await runUpdate(deps)).toBe(0);
      expect(out.join("\n")).toContain(command);
      expect(out.join("\n")).toContain("artisign setup");
      expect(deps.npm).not.toHaveBeenCalled();
    },
  );

  it("run through npx it points to the global install and attempts nothing", async () => {
    const { deps, err } = setup({
      entryPath: "/Users/x/.npm/_npx/abc/node_modules/artisign/dist/cli/index.js",
    });
    expect(await runUpdate(deps)).toBe(1);
    expect(err.join("\n")).toContain("npm install -g artisign");
    expect(deps.npm).not.toHaveBeenCalled();
  });
});

describe("repin", () => {
  const make = (
    results: { name: string; status: "done" | "skipped" | "failed"; error?: string }[],
    restart: "unchanged" | "restarted" | "failed",
  ) => ({
    connect: vi.fn(async () => results),
    restart: vi.fn(async () => restart),
    version: "3.0.0",
    log: vi.fn(),
    error: vi.fn(),
  });

  it("returns 0 when every write succeeded", async () => {
    const d = make([{ name: "Cursor", status: "done" }], "unchanged");
    expect(await runRepin("e", d)).toBe(0);
    expect(d.connect).toHaveBeenCalledWith({ version: "3.0.0", onlyExisting: true });
  });

  it("returns non-zero when any client write failed, and still restarts the daemon", async () => {
    const d = make(
      [
        { name: "Cursor", status: "failed", error: "boom" },
        { name: "Codex CLI", status: "done" },
      ],
      "restarted",
    );
    expect(await runRepin("e", d)).toBe(1);
    expect(d.error).toHaveBeenCalledWith("Cursor: boom");
    expect(d.restart).toHaveBeenCalled();
  });

  it("restarts the daemon without asking its version", async () => {
    const d = make([], "restarted");
    await runRepin("e", d);
    expect(d.restart).toHaveBeenCalledWith("e");
  });

  it("returns non-zero when the old daemon would not stop", async () => {
    expect(await runRepin("e", make([], "failed"))).toBe(1);
  });
});
