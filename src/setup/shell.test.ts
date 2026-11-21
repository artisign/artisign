import { describe, it, expect } from "vitest";
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
      command: '"C:\\Program Files\\nodejs\\npm.cmd"',
      args: ["install", "-g", "artisign@latest"],
      shell: true,
    });
  });
  it("runs an .exe directly on Windows", () => expect(spawnPlan("C:\\x\\claude.exe", ["a b"], "win32")).toEqual({ command: "C:\\x\\claude.exe", args: ["a b"], shell: false }));
  it("changes nothing elsewhere", () => expect(spawnPlan("npm", ["a b"], "darwin")).toEqual({ command: "npm", args: ["a b"], shell: false }));
});
