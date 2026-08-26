import { describe, it, expect } from "vitest";
import { filterScreens } from "./screens.js";

// renderScreenList itself isn't tested here — this file stays on the fast
// node default; its DOM smoke test lives in screens.dom.test.js. Filtering —
// the one piece of actual logic — is exercised
// directly instead.
describe("filterScreens", () => {
  const screens = [
    { name: "checkout-cart", tags: ["checkout"] },
    { name: "checkout-payment", tags: ["checkout", "payment"] },
    { name: "login", tags: ["auth"] },
  ];

  it("returns every screen for an empty filter", () => {
    expect(filterScreens(screens, "")).toEqual(screens);
  });

  it("matches a substring of the screen name", () => {
    expect(filterScreens(screens, "login")).toEqual([screens[2]]);
  });

  it("matches a substring of a tag", () => {
    expect(filterScreens(screens, "payment")).toEqual([screens[1]]);
  });

  it("is case-insensitive on both name and tags", () => {
    expect(filterScreens(screens, "LOGIN")).toEqual([screens[2]]);
    expect(filterScreens(screens, "Checkout")).toEqual([screens[0], screens[1]]);
  });

  it("matches screens with no tags only by name", () => {
    expect(filterScreens([{ name: "login", tags: [] }], "login")).toEqual([{ name: "login", tags: [] }]);
    expect(filterScreens([{ name: "login", tags: [] }], "auth")).toEqual([]);
  });

  it("returns no screens when nothing matches", () => {
    expect(filterScreens(screens, "nope")).toEqual([]);
  });
});
