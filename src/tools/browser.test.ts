import { describe, it, expect } from "vitest";
import {
  discoverBrowsers,
  selectBrowser,
  kindFromExecutable,
  fromRemoteValue,
  BROWSER_ENV,
  NO_BROWSER_MESSAGE,
} from "./browser.js";

const has =
  (...paths: string[]) =>
  (path: string): boolean =>
    paths.includes(path);

describe("discoverBrowsers", () => {
  it("finds macOS app bundles in /Applications and ~/Applications, in preference order", () => {
    const found = discoverBrowsers({
      platform: "darwin",
      home: "/Users/me",
      exists: has(
        "/Applications/Firefox.app/Contents/MacOS/firefox",
        "/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
    });
    expect(found).toEqual([
      {
        kind: "chrome",
        executable: "/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      { kind: "firefox", executable: "/Applications/Firefox.app/Contents/MacOS/firefox" },
    ]);
  });

  it("finds Linux executables on PATH, including their alternative names", () => {
    const found = discoverBrowsers({
      platform: "linux",
      env: { PATH: "/usr/local/bin:/usr/bin" },
      exists: has("/usr/bin/chromium-browser", "/usr/bin/firefox-esr"),
    });
    expect(found).toEqual([
      { kind: "chromium", executable: "/usr/bin/chromium-browser" },
      { kind: "firefox", executable: "/usr/bin/firefox-esr" },
    ]);
  });

  it("finds nothing without a PATH on Linux", () => {
    expect(discoverBrowsers({ platform: "linux", env: {}, exists: () => true })).toEqual([]);
  });
});

describe("kindFromExecutable", () => {
  it.each([
    ["/Applications/Firefox.app/Contents/MacOS/firefox", "firefox"],
    ["/usr/bin/firefox-esr", "firefox"],
    ["/usr/bin/microsoft-edge-stable", "edge"],
    ["/usr/bin/brave-browser", "brave"],
    ["/snap/bin/chromium", "chromium"],
    ["/opt/google/chrome/chrome", "chrome"],
    ["/somewhere/custom-browser", "chrome"],
  ])("%s -> %s", (path, kind) => {
    expect(kindFromExecutable(path)).toBe(kind);
  });
});

describe("selectBrowser", () => {
  const linux = { platform: "linux" as const, env: { PATH: "/usr/bin" } };

  it("defaults to the first discovered browser", () => {
    expect(
      selectBrowser(undefined, {
        ...linux,
        exists: has("/usr/bin/firefox", "/usr/bin/google-chrome"),
      }),
    ).toEqual({
      kind: "chrome",
      executable: "/usr/bin/google-chrome",
    });
  });

  it("honours an explicit kind", () => {
    expect(
      selectBrowser("firefox", {
        ...linux,
        exists: has("/usr/bin/firefox", "/usr/bin/google-chrome"),
      }),
    ).toEqual({
      kind: "firefox",
      executable: "/usr/bin/firefox",
    });
  });

  it("lists the installed browsers when the requested one is missing", () => {
    expect(() =>
      selectBrowser("edge", {
        ...linux,
        exists: has("/usr/bin/firefox", "/usr/bin/google-chrome"),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "not_found",
        message: expect.stringContaining("available: chrome, firefox"),
      }),
    );
  });

  it("throws the no-browser message when nothing is installed", () => {
    expect(() => selectBrowser(undefined, { ...linux, exists: () => false })).toThrowError(
      expect.objectContaining({ code: "io_error", message: NO_BROWSER_MESSAGE }),
    );
  });

  it("prefers ARTISIGN_BROWSER over discovery and infers its protocol from the name", () => {
    const env = { ...linux.env, [BROWSER_ENV]: "/opt/ff/firefox" };
    expect(
      selectBrowser(undefined, {
        ...linux,
        env,
        exists: has("/opt/ff/firefox", "/usr/bin/google-chrome"),
      }),
    ).toEqual({
      kind: "firefox",
      executable: "/opt/ff/firefox",
    });
    // An explicit other kind still uses discovery.
    expect(
      selectBrowser("chrome", {
        ...linux,
        env,
        exists: has("/opt/ff/firefox", "/usr/bin/google-chrome"),
      }),
    ).toEqual({
      kind: "chrome",
      executable: "/usr/bin/google-chrome",
    });
  });

  it("names a missing ARTISIGN_BROWSER path instead of silently falling back", () => {
    const env = { ...linux.env, [BROWSER_ENV]: "/nope/chrome" };
    expect(() =>
      selectBrowser(undefined, { ...linux, env, exists: has("/usr/bin/google-chrome") }),
    ).toThrowError(
      expect.objectContaining({
        code: "io_error",
        message: expect.stringContaining("/nope/chrome does not exist"),
      }),
    );
  });
});

describe("fromRemoteValue (WebDriver BiDi)", () => {
  it("decodes the shapes the tools' scripts return", () => {
    expect(fromRemoteValue({ type: "null" })).toBeNull();
    expect(fromRemoteValue({ type: "undefined" })).toBeUndefined();
    expect(fromRemoteValue({ type: "number", value: 211.5 })).toBe(211.5);
    expect(fromRemoteValue({ type: "number", value: "NaN" })).toBeNaN();
    expect(
      fromRemoteValue({
        type: "object",
        value: [
          ["box", { type: "object", value: [["x", { type: "number", value: 40 }]] }],
          [
            "list",
            {
              type: "array",
              value: [
                { type: "string", value: "a" },
                { type: "boolean", value: true },
              ],
            },
          ],
        ],
      }),
    ).toEqual({ box: { x: 40 }, list: ["a", true] });
  });
});
