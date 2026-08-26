import { describe, it, expect, vi } from "vitest";
import {
  readBoolPref,
  writeBoolPref,
  readStringPref,
  writeStringPref,
  pickInitialScreen,
  parseLastSelection,
  parseZoomPref,
  parseEnumPref,
} from "./prefs.js";

function fakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = value;
    },
    removeItem: (key) => {
      delete store[key];
    },
    _store: store,
  };
}

describe("readBoolPref", () => {
  it("returns the fallback when the key is missing", () => {
    expect(readBoolPref(fakeStorage(), "artisign.foo", true)).toBe(true);
    expect(readBoolPref(fakeStorage(), "artisign.foo", false)).toBe(false);
  });

  it("returns the fallback when storage is null or undefined", () => {
    expect(readBoolPref(null, "artisign.foo", true)).toBe(true);
    expect(readBoolPref(undefined, "artisign.foo", false)).toBe(false);
  });

  it("returns the fallback for a garbage stored value", () => {
    const storage = fakeStorage({ "artisign.foo": "yes" });
    expect(readBoolPref(storage, "artisign.foo", false)).toBe(false);
  });

  it("returns the fallback when storage.getItem throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readBoolPref(storage, "artisign.foo", true)).toBe(true);
  });

  it("parses the stored true/false strings", () => {
    const storage = fakeStorage({ "artisign.foo": "true", "artisign.bar": "false" });
    expect(readBoolPref(storage, "artisign.foo", false)).toBe(true);
    expect(readBoolPref(storage, "artisign.bar", true)).toBe(false);
  });

  // Same uxd. -> artisign. migration as readStringPref, via the
  // shared migratedRaw helper — see that describe block for the mirrored
  // string-preference cases.
  describe("legacy uxd. -> artisign. migration", () => {
    it("reads the legacy value, migrates it to the new key, and removes the old one", () => {
      const storage = fakeStorage({ "uxd.foo": "true" });
      expect(readBoolPref(storage, "artisign.foo", false)).toBe(true);
      expect(storage._store["artisign.foo"]).toBe("true");
      expect("uxd.foo" in storage._store).toBe(false);

      const storage2 = fakeStorage({ "uxd.bar": "false" });
      expect(readBoolPref(storage2, "artisign.bar", true)).toBe(false);
      expect(storage2._store["artisign.bar"]).toBe("false");
      expect("uxd.bar" in storage2._store).toBe(false);
    });

    it("prefers the new key over a still-present legacy one", () => {
      const storage = fakeStorage({ "uxd.foo": "false", "artisign.foo": "true" });
      expect(readBoolPref(storage, "artisign.foo", false)).toBe(true);
      expect(storage._store["uxd.foo"]).toBe("false");
    });

    it("does not migrate for a key outside the artisign. prefix", () => {
      const storage = fakeStorage({ "uxd.foo": "true" });
      expect(readBoolPref(storage, "uxd.foo", false)).toBe(true);
      expect("artisign.foo" in storage._store).toBe(false);
    });

    it("still migrates the key (removing the legacy one) even when the legacy value isn't valid true/false — value validation and key migration are separate", () => {
      const storage = fakeStorage({ "uxd.foo": "yes" });
      expect(readBoolPref(storage, "artisign.foo", false)).toBe(false);
      expect(storage._store["artisign.foo"]).toBe("yes");
      expect("uxd.foo" in storage._store).toBe(false);
    });
  });
});

describe("writeBoolPref", () => {
  it("stores the boolean as a string", () => {
    const storage = fakeStorage();
    writeBoolPref(storage, "artisign.foo", true);
    expect(storage._store["artisign.foo"]).toBe("true");
    writeBoolPref(storage, "artisign.foo", false);
    expect(storage._store["artisign.foo"]).toBe("false");
  });

  it("swallows a throwing storage.setItem", () => {
    const storage = {
      setItem: vi.fn(() => {
        throw new Error("QuotaExceededError");
      }),
    };
    expect(() => writeBoolPref(storage, "artisign.foo", true)).not.toThrow();
  });

  it("does nothing when storage is null or undefined", () => {
    expect(() => writeBoolPref(null, "artisign.foo", true)).not.toThrow();
    expect(() => writeBoolPref(undefined, "artisign.foo", true)).not.toThrow();
  });
});

describe("readStringPref", () => {
  it("returns the fallback when the key is missing", () => {
    expect(readStringPref(fakeStorage(), "artisign.foo", "bar")).toBe("bar");
    expect(readStringPref(fakeStorage(), "artisign.foo", null)).toBe(null);
  });

  it("returns the stored value when present", () => {
    const storage = fakeStorage({ "artisign.foo": "home" });
    expect(readStringPref(storage, "artisign.foo", null)).toBe("home");
  });

  it("returns the fallback when storage is null, undefined, or throws", () => {
    expect(readStringPref(null, "artisign.foo", "bar")).toBe("bar");
    expect(readStringPref(undefined, "artisign.foo", "bar")).toBe("bar");
    const storage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readStringPref(storage, "artisign.foo", "bar")).toBe("bar");
  });

  // One-time migration for the uxd. -> artisign. product rename (the
  // localStorage prefix): only applies to artisign.-prefixed keys, and only
  // when the new key is absent — see readStringPref's own comment.
  describe("legacy uxd. -> artisign. migration", () => {
    it("reads the legacy value, migrates it to the new key, and removes the old one", () => {
      const storage = fakeStorage({ "uxd.foo": "legacy-value" });
      expect(readStringPref(storage, "artisign.foo", "fallback")).toBe("legacy-value");
      expect(storage._store["artisign.foo"]).toBe("legacy-value");
      expect("uxd.foo" in storage._store).toBe(false);
    });

    it("prefers the new key over a still-present legacy one", () => {
      const storage = fakeStorage({ "uxd.foo": "legacy-value", "artisign.foo": "current-value" });
      expect(readStringPref(storage, "artisign.foo", "fallback")).toBe("current-value");
      expect(storage._store["uxd.foo"]).toBe("legacy-value");
    });

    it("returns the fallback and writes nothing when neither key is present", () => {
      const storage = fakeStorage();
      expect(readStringPref(storage, "artisign.foo", "fallback")).toBe("fallback");
      expect(storage._store).toEqual({});
    });

    it("does not migrate for a key outside the artisign. prefix", () => {
      const storage = fakeStorage({ "uxd.foo": "legacy-value" });
      expect(readStringPref(storage, "uxd.foo", "fallback")).toBe("legacy-value");
      expect("artisign.foo" in storage._store).toBe(false);
    });
  });
});

describe("writeStringPref", () => {
  it("stores the value", () => {
    const storage = fakeStorage();
    writeStringPref(storage, "artisign.foo", "home");
    expect(storage._store["artisign.foo"]).toBe("home");
  });

  it("swallows a throwing storage.setItem and does nothing without storage", () => {
    const storage = {
      setItem: vi.fn(() => {
        throw new Error("QuotaExceededError");
      }),
    };
    expect(() => writeStringPref(storage, "artisign.foo", "home")).not.toThrow();
    expect(() => writeStringPref(null, "artisign.foo", "home")).not.toThrow();
  });
});

describe("pickInitialScreen", () => {
  const screens = [{ name: "home" }, { name: "settings" }];

  it("picks the persisted screen when it still exists", () => {
    expect(pickInitialScreen(screens, "settings")).toBe("settings");
  });

  it("falls back to the first screen when the persisted one no longer exists", () => {
    expect(pickInitialScreen(screens, "deleted-screen")).toBe("home");
  });

  it("falls back to the first screen when nothing is persisted", () => {
    expect(pickInitialScreen(screens, null)).toBe("home");
  });

  it("returns null when the project has no screens", () => {
    expect(pickInitialScreen([], "home")).toBe(null);
    expect(pickInitialScreen([], null)).toBe(null);
  });
});

describe("parseLastSelection", () => {
  it("returns null for a missing value", () => {
    expect(parseLastSelection(null)).toBe(null);
  });

  it("treats a plain string as a legacy screen selection", () => {
    expect(parseLastSelection("login")).toEqual({ kind: "screen", name: "login" });
  });

  it("parses a mockup: prefixed value", () => {
    expect(parseLastSelection("mockup:checkout-redesign")).toEqual({ kind: "mockup", name: "checkout-redesign" });
  });

  it("returns null for a mockup: prefix with no name", () => {
    expect(parseLastSelection("mockup:")).toBe(null);
  });
});

describe("parseZoomPref", () => {
  it("parses 'fit'", () => {
    expect(parseZoomPref("fit", 1)).toBe("fit");
  });

  it("parses a positive number", () => {
    expect(parseZoomPref("0.5", "fit")).toBe(0.5);
    expect(parseZoomPref("2", "fit")).toBe(2);
  });

  it("falls back for a missing, non-numeric, or non-positive value", () => {
    expect(parseZoomPref(null, "fit")).toBe("fit");
    expect(parseZoomPref("banana", "fit")).toBe("fit");
    expect(parseZoomPref("0", "fit")).toBe("fit");
    expect(parseZoomPref("-1", "fit")).toBe("fit");
  });
});

describe("parseEnumPref", () => {
  const allowed = ["screens", "design-system", "board"];

  it("returns the value when it's one of the allowed options", () => {
    expect(parseEnumPref("board", allowed, "screens")).toBe("board");
  });

  it("falls back when missing or no longer a valid option", () => {
    expect(parseEnumPref(null, allowed, "screens")).toBe("screens");
    expect(parseEnumPref("removed-view", allowed, "screens")).toBe("screens");
  });
});
