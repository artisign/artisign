import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWithin, pathIdentity, toProjectRelative } from "./paths.js";

describe("toProjectRelative", () => {
  it("converts Windows separators to /", () => {
    expect(toProjectRelative("C:\\Work\\proj", "C:\\Work\\proj\\assets\\a\\b.png", path.win32)).toBe("assets/a/b.png");
    expect(toProjectRelative("C:\\Work\\proj", "C:\\Work\\proj\\screens\\home.html", path.win32)).toBe("screens/home.html");
  });
  it("is case-insensitive on the project prefix for win32", () => {
    expect(toProjectRelative("C:\\Work\\proj", "c:\\work\\proj\\flows.json", path.win32)).toBe("flows.json");
  });
  it("returns the empty string for the root itself", () => {
    expect(toProjectRelative("C:\\Work\\proj", "C:\\Work\\proj", path.win32)).toBe("");
  });
  it("leaves POSIX paths unchanged", () => {
    expect(toProjectRelative("/w/proj", "/w/proj/screens/home.html", path.posix)).toBe("screens/home.html");
  });
});

describe("isWithin", () => {
  it("accepts the root and paths below it (win32)", () => {
    expect(isWithin("C:\\Work\\proj", "C:\\Work\\proj", path.win32)).toBe(true);
    expect(isWithin("C:\\Work\\proj", "c:\\work\\proj\\assets\\x.png", path.win32)).toBe(true);
  });
  it("rejects siblings, parents, traversal and other drives (win32)", () => {
    expect(isWithin("C:\\Work\\proj", "C:\\Work\\proj-other\\x", path.win32)).toBe(false);
    expect(isWithin("C:\\Work\\proj", "C:\\Work", path.win32)).toBe(false);
    expect(isWithin("C:\\Work\\proj", path.win32.resolve("C:\\Work\\proj", "..\\..\\x"), path.win32)).toBe(false);
    expect(isWithin("C:\\Work\\proj", "D:\\Work\\proj\\x", path.win32)).toBe(false);
  });
  it("does not mistake a dot-dot-prefixed name for traversal", () => {
    expect(isWithin("/w/proj", "/w/proj/..hidden/x", path.posix)).toBe(true);
    expect(isWithin("/w/proj", "/w/other", path.posix)).toBe(false);
  });
});

describe("pathIdentity", () => {
  it("lowercases only on win32", () => {
    expect(pathIdentity("C:\\Work\\Proj", "win32")).toBe("c:\\work\\proj");
    expect(pathIdentity("/Work/Proj", "darwin")).toBe("/Work/Proj");
  });
});
