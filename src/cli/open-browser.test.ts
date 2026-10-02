import { describe, it, expect, vi } from "vitest";
import { openBrowser, openerCommand } from "./open-browser.js";

const URL_ = "http://127.0.0.1:4711/";

describe("openerCommand", () => {
  it("uses open on macOS", () => expect(openerCommand(URL_, "darwin")).toEqual({ command: "open", args: [URL_] }));
  it("uses xdg-open on Linux", () => expect(openerCommand(URL_, "linux")).toEqual({ command: "xdg-open", args: [URL_] }));
  it('uses cmd /c start "" on Windows', () => expect(openerCommand(URL_, "win32")).toEqual({ command: "cmd", args: ["/c", "start", '""', URL_] }));
});

describe("openBrowser", () => {
  it("spawns the opener detached with stdio ignored and lets go of it", () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawn = vi.fn(() => child);
    openBrowser(URL_, "darwin", spawn);
    expect(spawn).toHaveBeenCalledWith("open", [URL_], expect.objectContaining({ detached: true, stdio: "ignore" }));
    expect(child.unref).toHaveBeenCalled();
  });

  it("swallows an asynchronous spawn error (no opener installed)", () => {
    const child = { on: vi.fn((_e: string, cb: () => void) => cb()), unref: vi.fn() };
    expect(() => openBrowser(URL_, "linux", vi.fn(() => child))).not.toThrow();
  });
});
