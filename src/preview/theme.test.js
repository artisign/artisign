import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { THEME_PREFS, THEME_PREF_KEY, resolveTheme, nextThemePref, applyTheme, watchSystemTheme } from "./theme.js";
import { parseEnumPref } from "./prefs.js";

function fakeMql(matches) {
  const listeners = [];
  return {
    matches,
    addEventListener: (_type, fn) => listeners.push(fn),
    fire(next) {
      this.matches = next;
      for (const fn of listeners) fn();
    },
  };
}

function fakeRoot() {
  const attrs = {};
  return { setAttribute: (k, v) => (attrs[k] = v), attrs };
}

describe("resolveTheme", () => {
  it("follows the OS only for system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("ignores the OS for an explicit choice", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("nextThemePref", () => {
  it("cycles System -> Light -> Dark -> System", () => {
    expect(nextThemePref("system")).toBe("light");
    expect(nextThemePref("light")).toBe("dark");
    expect(nextThemePref("dark")).toBe("system");
  });
});

describe("stored pref validation", () => {
  it("falls back to system for a missing or invalid value", () => {
    expect(parseEnumPref(null, THEME_PREFS, "system")).toBe("system");
    expect(parseEnumPref("purple", THEME_PREFS, "system")).toBe("system");
    expect(parseEnumPref("dark", THEME_PREFS, "system")).toBe("dark");
  });
});

describe("applyTheme / watchSystemTheme", () => {
  it("sets data-theme from the resolved theme", () => {
    const root = fakeRoot();
    applyTheme(root, "system", fakeMql(true));
    expect(root.attrs["data-theme"]).toBe("dark");
  });

  it("re-themes live on an OS change while the pref is system", () => {
    const root = fakeRoot();
    const mql = fakeMql(false);
    let pref = "system";
    watchSystemTheme(root, mql, () => pref);
    mql.fire(true);
    expect(root.attrs["data-theme"]).toBe("dark");
    mql.fire(false);
    expect(root.attrs["data-theme"]).toBe("light");
  });

  it("ignores OS changes under an explicit pref", () => {
    const root = fakeRoot();
    const mql = fakeMql(false);
    watchSystemTheme(root, mql, () => "light");
    mql.fire(true);
    expect(root.attrs["data-theme"]).toBeUndefined();
  });
});

describe("watchSystemTheme on a legacy MediaQueryList", () => {
  it("falls back to addListener and does not throw without any listener API", () => {
    const root = fakeRoot();
    let handler;
    watchSystemTheme(root, { matches: true, addListener: (fn) => (handler = fn) }, () => "system");
    handler();
    expect(root.attrs["data-theme"]).toBe("dark");
    expect(() => watchSystemTheme(root, { matches: false }, () => "system")).not.toThrow();
  });
});

describe("pre-paint script in index.html", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";

  it("reads the same pref key and values as theme.js", () => {
    expect(script).toContain(`"${THEME_PREF_KEY}"`);
    expect(script).toContain('"dark"');
    expect(script).toContain('"light"');
    expect(script).toContain("prefers-color-scheme: dark");
    expect(THEME_PREFS).toEqual(["system", "light", "dark"]);
  });
});
