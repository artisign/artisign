import { describe, it, expect } from "vitest";
import { parseStartArgs } from "./args.js";

describe("parseStartArgs", () => {
  it("returns no port and no projects for an empty argv", () => {
    expect(parseStartArgs([])).toEqual({ port: undefined, projects: [] });
  });

  it("parses --port before the project directory", () => {
    expect(parseStartArgs(["--port", "4799", "./proj"])).toEqual({
      port: 4799,
      projects: ["./proj"],
    });
  });

  it("parses --port after the project directory", () => {
    expect(parseStartArgs(["./proj", "--port", "4799"])).toEqual({
      port: 4799,
      projects: ["./proj"],
    });
  });

  it("accepts --port 0 for an OS-assigned port", () => {
    expect(parseStartArgs(["--port", "0"])).toEqual({ port: 0, projects: [] });
  });

  it("collects several project directories", () => {
    expect(parseStartArgs(["a", "b"]).projects).toEqual(["a", "b"]);
  });

  it("rejects --port without a value", () => {
    expect(() => parseStartArgs(["--port"])).toThrow("--port requires a non-negative integer value");
  });

  it("rejects a non-numeric --port", () => {
    expect(() => parseStartArgs(["--port", "abc"])).toThrow(
      "--port requires a non-negative integer value",
    );
  });

  it.each([
    ["an empty value", ""],
    ["whitespace", " "],
    ["a hex literal", "0x10"],
    ["a negative number", "-1"],
    ["a float", "1.5"],
  ])("rejects %s rather than coercing it to a port", (_label, value) => {
    expect(() => parseStartArgs(["--port", value])).toThrow(
      "--port requires a non-negative integer value",
    );
  });

  it("rejects an unknown option instead of taking it for a project directory", () => {
    expect(() => parseStartArgs(["--prot", "4799", "./proj"])).toThrow("Unknown option: --prot");
  });
});
