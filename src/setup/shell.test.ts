import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { quoteCmdArg, spawnPlan } from "./shell.js";

describe("quoteCmdArg", () => {
  it("leaves plain words alone", () => expect(quoteCmdArg("artisign@latest")).toBe("artisign@latest"));
  it("quotes spaces and operators", () => {
    expect(quoteCmdArg("C:\\Users\\First Last\\npm.cmd")).toBe('"C:\\Users\\First Last\\npm.cmd"');
    expect(quoteCmdArg("a&b")).toBe('"a&b"');
    expect(quoteCmdArg("")).toBe('""');
  });
  it("doubles a trailing backslash inside the quotes", () => expect(quoteCmdArg("C:\\a b\\")).toBe('"C:\\a b\\\\"'));
  it("rejects what cmd.exe would expand or break out with", () => {
    for (const bad of ['a"b', "%PATH%", "a!b", "a\nb"]) expect(() => quoteCmdArg(bad)).toThrow(/safely/);
  });
});

describe("spawnPlan", () => {
  it("runs a .cmd through a shell on Windows with every part quoted", () => {
    expect(spawnPlan("C:\\Program Files\\nodejs\\npm.cmd", ["install", "-g", "artisign@latest"], "win32")).toEqual({
      command: '"C:\\Program Files\\nodejs\\npm.cmd" install -g artisign@latest',
      args: [],
      shell: true,
    });
  });
  it("passes no args array with a shell (Node 24 warns DEP0190 for any)", () => {
    const plan = spawnPlan("claude.cmd", ["mcp", "add", "my server"], "win32");
    expect(plan).toEqual({ command: 'claude.cmd mcp add "my server"', args: [], shell: true });
  });
  it("runs an .exe directly on Windows", () => expect(spawnPlan("C:\\x\\claude.exe", ["a b"], "win32")).toEqual({ command: "C:\\x\\claude.exe", args: ["a b"], shell: false }));
  it("changes nothing elsewhere", () => expect(spawnPlan("npm", ["a b"], "darwin")).toEqual({ command: "npm", args: ["a b"], shell: false }));
});

describe("DEP0190", () => {
  it("a shell spawn with a command line and no args array raises no deprecation warning", () => {
    const script = 'require("node:child_process").spawn("echo hi", [], { shell: true, stdio: "ignore" }).on("close", (c) => process.exit(c))';
    const r = spawnSync(process.execPath, ["--throw-deprecation", "-e", script], { encoding: "utf8" });
    expect(r.stderr).not.toContain("DEP0190");
    expect(r.status).toBe(0);
  });
});
