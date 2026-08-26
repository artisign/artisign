import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsStore } from "./fs-store.js";
import { initProject } from "../init/init-project.js";

describe("FsStore", () => {
  let dir: string;
  let store: FsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-store-"));
    await initProject(dir);
    store = new FsStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes and reads screens, components, patterns", async () => {
    await store.writeScreen("home", "<div id=\"n1\">hi</div>");
    expect(await store.readScreen("home")).toBe('<div id="n1">hi</div>');
    expect(await store.listScreens()).toEqual(["home"]);

    await store.writeComponent("btn-primary", "<button id=\"n1\">Go</button>");
    expect(await store.listComponents()).toEqual(["btn-primary"]);

    await store.writePattern("card-grid", "<div id=\"n1\"></div>");
    expect(await store.listPatterns()).toEqual(["card-grid"]);
  });

  it("deletes a screen", async () => {
    await store.writeScreen("home", "<div id=\"n1\"></div>");
    await store.deleteScreen("home");
    expect(await store.listScreens()).toEqual([]);
  });

  it("deleteScreen also removes the meta sidecar", async () => {
    await store.writeScreen("home", "<div id=\"n1\"></div>");
    await store.writeScreenMeta("home", { notes: "wip", tags: ["a"] });
    await store.deleteScreen("home");
    expect(await store.readScreenMeta("home")).toEqual({ notes: "", tags: [] });
  });

  it("deletes a component", async () => {
    await store.writeComponent("btn-primary", "<button id=\"n1\">Go</button>");
    await store.deleteComponent("btn-primary");
    expect(await store.listComponents()).toEqual([]);
  });

  it("deleteComponent on a missing name is a no-op", async () => {
    await expect(store.deleteComponent("nope")).resolves.toBeUndefined();
  });

  it("deletes a pattern", async () => {
    await store.writePattern("card-grid", "<div id=\"n1\"></div>");
    await store.deletePattern("card-grid");
    expect(await store.listPatterns()).toEqual([]);
  });

  it("deletePattern on a missing name is a no-op", async () => {
    await expect(store.deletePattern("nope")).resolves.toBeUndefined();
  });

  it("readScreenMeta yields empty defaults when the sidecar is missing", async () => {
    expect(await store.readScreenMeta("nope")).toEqual({ notes: "", tags: [] });
  });

  it("round-trips screen meta and lenient-merges a partial file over defaults", async () => {
    await store.writeScreenMeta("home", { notes: "check contrast", tags: ["checkout", "wip"] });
    expect(await store.readScreenMeta("home")).toEqual({ notes: "check contrast", tags: ["checkout", "wip"] });

    // Hand-edited/partial sidecar file — missing keys fall back to defaults.
    await store.writeScreenMeta("partial", { notes: "only notes" } as never);
    expect(await store.readScreenMeta("partial")).toEqual({ notes: "only notes", tags: [] });
  });

  it("readScreenMeta yields defaults instead of throwing on malformed JSON (hand-edited sidecar)", async () => {
    await writeFile(join(dir, "screens", "home.meta.json"), "{ not valid json");
    expect(await store.readScreenMeta("home")).toEqual({ notes: "", tags: [] });
  });

  it("readScreenMeta coerces a wrong-typed tags field to an empty array instead of passing it through", async () => {
    await writeFile(join(dir, "screens", "home.meta.json"), JSON.stringify({ notes: "x", tags: "checkout" }));
    expect(await store.readScreenMeta("home")).toEqual({ notes: "x", tags: [] });
  });

  it("readDesignSystemMeta yields empty defaults when meta.json is missing", async () => {
    expect(await store.readDesignSystemMeta()).toEqual({ idea: "", decisions: [], component_usage: {}, pattern_usage: {} });
  });

  it("round-trips design-system meta and lenient-merges a partial file over defaults", async () => {
    const meta = {
      idea: "a checkout flow that never loses cart state",
      decisions: [{ id: "d1", date: "2026-01-01", title: "single page checkout", body: "fewer steps, higher conversion", status: "active" as const }],
      component_usage: { "btn-primary": "primary CTAs only" },
      pattern_usage: {},
    };
    await store.writeDesignSystemMeta(meta);
    expect(await store.readDesignSystemMeta()).toEqual(meta);
  });

  it("readDesignSystemMeta yields defaults instead of throwing on malformed JSON (hand-edited sidecar)", async () => {
    await writeFile(join(dir, "design-system", "meta.json"), "{ not valid json");
    expect(await store.readDesignSystemMeta()).toEqual({ idea: "", decisions: [], component_usage: {}, pattern_usage: {} });
  });

  it("readDesignSystemMeta drops a malformed decision entry but keeps the valid ones", async () => {
    const valid = { id: "d1", date: "2026-01-01", title: "single page checkout", body: "fewer steps", status: "active" };
    await writeFile(
      join(dir, "design-system", "meta.json"),
      JSON.stringify({ decisions: [valid, { id: "d2", title: "missing required fields" }] }),
    );
    expect(await store.readDesignSystemMeta()).toEqual({ idea: "", decisions: [valid], component_usage: {}, pattern_usage: {} });
  });

  it("readDesignSystemMeta drops non-string values from component_usage/pattern_usage", async () => {
    await writeFile(
      join(dir, "design-system", "meta.json"),
      JSON.stringify({ component_usage: { "btn-primary": "primary CTAs only", broken: 42 } }),
    );
    expect(await store.readDesignSystemMeta()).toEqual({
      idea: "",
      decisions: [],
      component_usage: { "btn-primary": "primary CTAs only" },
      pattern_usage: {},
    });
  });

  it("reads and writes tokens and flows", async () => {
    const tokens = await store.readTokens();
    tokens.color!["primary"] = "#000";
    await store.writeTokens(tokens);
    expect((await store.readTokens()).color!["primary"]).toBe("#000");

    await store.writeFlows([{ from: "a.n1", event: "tap", to: "b" }]);
    expect(await store.readFlows()).toEqual([{ from: "a.n1", event: "tap", to: "b" }]);
  });

  it("appends comments as JSON lines", async () => {
    await store.appendComment(JSON.stringify({ id: "c1", text: "hi" }));
    await store.appendComment(JSON.stringify({ id: "c2", text: "there" }));
    const lines = await store.readComments();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ id: "c1", text: "hi" });
  });

  it("round-trips the derived cache index", async () => {
    expect(await store.readCacheIndex()).toBeUndefined();
    await store.writeCacheIndex({ hello: "world" });
    expect(await store.readCacheIndex()).toEqual({ hello: "world" });
  });

  it("leaves no temp files behind after a write", async () => {
    await store.writeScreen("home", "<div id=\"n1\"></div>");
    const entries = await readdir(join(dir, "screens"));
    expect(entries).toEqual(["home.html"]);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("commits on write when autoCommit is enabled, reports why when disabled", async () => {
    await store.writeScreen("home", "<div id=\"n1\"></div>");
    const result = await store.commit("feat: add home screen");
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.skipped_reason).toBeUndefined();

    const config = await store.readArtisignConfig();
    config.settings.autoCommit = false;
    await store.writeArtisignConfig(config);
    await store.writeScreen("home", "<div id=\"n1\">changed</div>");
    const disabled = await store.commit("feat: change home screen");
    expect(disabled.sha).toBeNull();
    expect(disabled.skipped_reason).toBe("disabled");
  });

  it("does not fail a write when auto-commit itself fails, and reports why", async () => {
    // Break git by making .git a plain file instead of a directory, so a
    // real git init/commit inside it errors out.
    await writeFile(join(dir, ".git"), "not a git dir");
    await store.writeScreen("home", "<div id=\"n1\"></div>");
    const result = await store.commit("feat: add home screen");
    expect(result.sha).toBeNull();
    expect(result.skipped_reason).toMatch(/^git_error: /);
  });

  it("refuses a screen name that escapes the project directory", async () => {
    await expect(store.writeScreen("../../pwned", "<div id=\"n1\"></div>")).rejects.toThrow();
    await expect(store.readScreen("../../etc/passwd")).rejects.toThrow();
    await expect(store.deleteScreen("../../pwned")).rejects.toThrow();
    // design-system/components and design-system/patterns are nested two
    // levels deep, so escaping the project dir needs three "..".
    await expect(store.writeComponent("../../../escape", "<div id=\"n1\"></div>")).rejects.toThrow();
    await expect(store.writePattern("../../../escape", "<div id=\"n1\"></div>")).rejects.toThrow();
    await expect(store.deleteComponent("../../../escape")).rejects.toThrow();
    await expect(store.deletePattern("../../../escape")).rejects.toThrow();

    // must not have written anything outside the project directory
    await expect(readdir(join(dir, ".."))).resolves.not.toContain("pwned.html");
  });

  describe("mockups", () => {
    it("round-trips mockup meta and variant HTML", async () => {
      await store.writeMockupMeta("assign-caregiver", {
        title: "Assign caregiver",
        description: "two interaction models",
        variants: [
          { id: "a", title: "Toggle", description: "single toggle" },
          { id: "b", title: "Radio group", description: "explicit choice" },
        ],
      });
      await store.writeMockupVariant("assign-caregiver", "a", "<div>toggle</div>");
      await store.writeMockupVariant("assign-caregiver", "b", "<div>radio</div>");

      expect(await store.readMockupMeta("assign-caregiver")).toEqual({
        title: "Assign caregiver",
        description: "two interaction models",
        variants: [
          { id: "a", title: "Toggle", description: "single toggle" },
          { id: "b", title: "Radio group", description: "explicit choice" },
        ],
      });
      expect(await store.readMockupVariant("assign-caregiver", "a")).toBe("<div>toggle</div>");
      expect(await store.readMockupVariant("assign-caregiver", "b")).toBe("<div>radio</div>");
    });

    it("listMockups returns sorted directory names, [] when mockups/ is missing", async () => {
      // initProject already scaffolds an empty mockups/ dir.
      expect(await store.listMockups()).toEqual([]);

      await store.writeMockupMeta("zeta", { variants: [] });
      await store.writeMockupMeta("alpha", { variants: [] });
      expect(await store.listMockups()).toEqual(["alpha", "zeta"]);

      await rm(join(dir, "mockups"), { recursive: true, force: true });
      expect(await store.listMockups()).toEqual([]);
    });

    it("readMockupMeta propagates ENOENT for a mockup that doesn't exist (unlike readScreenMeta)", async () => {
      await expect(store.readMockupMeta("nope")).rejects.toThrow(/ENOENT/);
    });

    it("readMockupMeta yields {variants: []} instead of throwing on malformed JSON", async () => {
      await store.writeMockupVariant("broken", "a", "<div></div>");
      await writeFile(join(dir, "mockups", "broken", "mockup.json"), "{ not valid json");
      expect(await store.readMockupMeta("broken")).toEqual({ variants: [] });
    });

    it("readMockupMeta coerces a wrong-shaped mockup.json to {variants: []}", async () => {
      await store.writeMockupVariant("broken", "a", "<div></div>");
      await writeFile(join(dir, "mockups", "broken", "mockup.json"), JSON.stringify({ variants: "not an array" }));
      expect(await store.readMockupMeta("broken")).toEqual({ variants: [] });
    });

    it("round-trips mockup tags", async () => {
      await store.writeMockupMeta("assign-caregiver", { variants: [], tags: ["checkout", "wip"] });
      expect(await store.readMockupMeta("assign-caregiver")).toEqual({ variants: [], tags: ["checkout", "wip"] });
    });

    it("readMockupMeta drops non-string tags entries instead of throwing (same leniency as sanitizeScreenMeta)", async () => {
      await store.writeMockupVariant("broken", "a", "<div></div>");
      await writeFile(join(dir, "mockups", "broken", "mockup.json"), JSON.stringify({ variants: [], tags: ["ok", 1, null, "also-ok"] }));
      expect(await store.readMockupMeta("broken")).toEqual({ variants: [], tags: ["ok", "also-ok"] });
    });

    it("readMockupMeta omits tags when the field is absent, rather than defaulting to []", async () => {
      await store.writeMockupMeta("assign-caregiver", { variants: [] });
      expect(await store.readMockupMeta("assign-caregiver")).toEqual({ variants: [] });
    });

    it("readMockupVariant propagates ENOENT for a missing variant", async () => {
      await expect(store.readMockupVariant("nope", "a")).rejects.toThrow(/ENOENT/);
    });

    it("deleteMockup removes the whole directory", async () => {
      await store.writeMockupMeta("assign-caregiver", { variants: [{ id: "a", title: "a", description: "" }] });
      await store.writeMockupVariant("assign-caregiver", "a", "<div></div>");
      await store.deleteMockup("assign-caregiver");
      expect(await store.listMockups()).toEqual([]);
      await expect(store.readMockupMeta("assign-caregiver")).rejects.toThrow();
    });

    it("deleteMockupVariant is a no-op when the variant is already missing", async () => {
      await expect(store.deleteMockupVariant("nope", "a")).resolves.toBeUndefined();
    });

    it("refuses a mockup name/variant id that escapes the project directory", async () => {
      await expect(store.writeMockupVariant("../../pwned", "a", "<div></div>")).rejects.toThrow();
      await expect(store.readMockupVariant("../../etc", "passwd")).rejects.toThrow();
      await expect(store.writeMockupMeta("../../pwned", { variants: [] })).rejects.toThrow();
      await expect(store.deleteMockup("../../pwned")).rejects.toThrow();

      await expect(readdir(join(dir, ".."))).resolves.not.toContain("pwned");
    });
  });

  describe("readArtisignConfig shape validation", () => {
    it("rejects artisign.json containing null, naming the path", async () => {
      await writeFile(join(dir, "artisign.json"), "null");
      await expect(store.readArtisignConfig()).rejects.toThrow(join(dir, "artisign.json"));
    });

    it("rejects artisign.json containing a bare number", async () => {
      await writeFile(join(dir, "artisign.json"), "42");
      await expect(store.readArtisignConfig()).rejects.toThrow(join(dir, "artisign.json"));
    });

    it("rejects artisign.json containing an array", async () => {
      await writeFile(join(dir, "artisign.json"), "[]");
      await expect(store.readArtisignConfig()).rejects.toThrow(join(dir, "artisign.json"));
    });

    it("rejects artisign.json missing a string name", async () => {
      await writeFile(join(dir, "artisign.json"), JSON.stringify({ settings: { autoCommit: true } }));
      await expect(store.readArtisignConfig()).rejects.toThrow(/name/);
    });

    it("rejects artisign.json missing a settings object", async () => {
      await writeFile(join(dir, "artisign.json"), JSON.stringify({ name: "x" }));
      await expect(store.readArtisignConfig()).rejects.toThrow(/settings/);
    });

    it("rejects invalid JSON", async () => {
      await writeFile(join(dir, "artisign.json"), "not json");
      await expect(store.readArtisignConfig()).rejects.toThrow(join(dir, "artisign.json"));
    });
  });
});
