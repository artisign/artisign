import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { setTokens, writeHtml } from "./writes.js";
import { promoteToSystem } from "./lifecycle.js";
import { loadRegistry, parseScreen, serializeScreen, renderScreen } from "../model/index.js";
import { buildRenderContext } from "./render-context.js";

const EYEBROW = `<span id="e" style="font-size: 12px; color: #888">hi</span>`;

describe("component / bare token member name collision (CHR-772)", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  describe("set_tokens introduces a member named like a component", () => {
    beforeEach(async () => {
      await fx.store.writeComponent("eyebrow", EYEBROW);
    });

    it("refuses when class-form instances would lose their binding, naming them, and writes nothing", async () => {
      await fx.store.writeScreen("home", `<div id="n1"><p id="n2" class="$eyebrow">x</p></div>`);
      const before = await fx.store.readTokens();

      await expect(setTokens(fx.store, { tokens: { "typography.eyebrow": "12px" }, mode: "patch" })).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("home.n2"),
      });
      expect(await fx.store.readTokens()).toEqual(before);
    });

    it("does not count a data-component slot fill as a class-form instance", async () => {
      await fx.store.writeComponent("card", `<div id="c"><span data-slot="body">d</span></div>`);
      await fx.store.writeScreen("home", `<div id="n1"><div id="n2" class="$card"><p data-slot="body" data-component="eyebrow">x</p></div></div>`);
      const res = await setTokens(fx.store, { tokens: { "typography.eyebrow": "12px" }, mode: "patch" });
      expect(res.warnings).toEqual([expect.objectContaining({ kind: "ambiguous_ref", target: "eyebrow" })]);
    });

    it("also counts instances in another component definition and in slot fills", async () => {
      await fx.store.writeComponent("card", `<div id="c"><span data-slot="body">d</span></div>`);
      await fx.store.writeScreen("home", `<div id="n1"><div id="n2" class="$card"><p data-slot="body" class="$eyebrow">x</p></div></div>`);
      await expect(setTokens(fx.store, { tokens: { "typography.eyebrow": "12px" }, mode: "patch" })).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("home.n2 (slot fill)"),
      });
    });

    it("warns ambiguous_ref and succeeds when nothing is bound via class", async () => {
      await fx.store.writeScreen("home", `<div id="n1"><p id="n2" data-component="eyebrow">x</p></div>`);
      const res = await setTokens(fx.store, { tokens: { "typography.eyebrow": "12px" }, mode: "patch" });
      expect(res.warnings).toEqual([expect.objectContaining({ kind: "ambiguous_ref", target: "eyebrow" })]);
      expect((await fx.store.readTokens()).typography).toEqual({ eyebrow: "12px" });
    });

    it("does not complain about a dot-path token that merely shares the bare name with an existing member", async () => {
      await fx.store.writeTokens({ color: { eyebrow: "#111" } });
      const res = await setTokens(fx.store, { tokens: { "typography.eyebrow": "12px" }, mode: "patch" });
      expect(res.warnings).toEqual([]);
    });
  });

  describe("write_html kind component introduces a name equal to a token member", () => {
    beforeEach(async () => {
      await fx.store.writeTokens({ typography: { eyebrow: "12px" } });
    });

    it("refuses when nodes use class=$name as the token class, and writes nothing", async () => {
      await fx.store.writeScreen("home", `<div id="n1"><p id="n2" class="$eyebrow">x</p></div>`);
      await expect(writeHtml(fx.store, { kind: "component", screen: "eyebrow", mode: "create", html_aug: EYEBROW })).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("home.n2"),
      });
      expect(await fx.store.listComponents()).toEqual([]);
    });

    it("refuses when the incoming definition itself uses class=$name as the token class", async () => {
      await expect(
        writeHtml(fx.store, { kind: "component", screen: "eyebrow", mode: "create", html_aug: `<p id="p" class="$eyebrow">x</p>` }),
      ).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("the new definition") });
      expect(await fx.store.listComponents()).toEqual([]);
    });

    it("does not re-check when the component already exists (replace)", async () => {
      await fx.store.writeComponent("eyebrow", EYEBROW);
      const res = await writeHtml(fx.store, { kind: "component", screen: "eyebrow", mode: "replace", html_aug: EYEBROW });
      expect(res.warnings).toEqual([]);
    });

    it("warns ambiguous_ref and succeeds when nothing uses the token class", async () => {
      const res = await writeHtml(fx.store, { kind: "component", screen: "eyebrow", mode: "create", html_aug: EYEBROW });
      expect(res.warnings).toEqual([expect.objectContaining({ kind: "ambiguous_ref", target: "eyebrow" })]);
      expect(await fx.store.listComponents()).toEqual(["eyebrow"]);
    });

    it("a pattern of the same name cannot collide (patterns are not in the registry)", async () => {
      await fx.store.writeScreen("home", `<div id="n1"><p id="n2" class="$eyebrow">x</p></div>`);
      const res = await writeHtml(fx.store, { kind: "pattern", screen: "eyebrow", mode: "create", html_aug: EYEBROW });
      expect(res.warnings).toEqual([]);
      expect(await fx.store.listPatterns()).toEqual(["eyebrow"]);
    });
  });

  describe("promote_to_system", () => {
    it("kind=token refuses a member named like a component with class-form instances", async () => {
      await fx.store.writeComponent("brand", EYEBROW);
      await fx.store.writeScreen("home", `<div id="n1" style="color: #3366ff"><p id="n2" class="$brand">x</p></div>`);
      const before = await fx.store.readTokens();
      await expect(promoteToSystem(fx.store, { node: "home.n1", kind: "token", name: "color.brand" })).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("home.n2"),
      });
      expect(await fx.store.readTokens()).toEqual(before);
    });

    it("kind=token warns when the colliding component has no class-form instance", async () => {
      await fx.store.writeComponent("brand", EYEBROW);
      await fx.store.writeScreen("home", `<div id="n1" style="color: #3366ff"></div>`);
      const res = await promoteToSystem(fx.store, { node: "home.n1", kind: "token", name: "color.brand" });
      expect(res.warnings).toEqual([expect.objectContaining({ kind: "ambiguous_ref", target: "brand" })]);
    });

    it("kind=component into an existing component of that name is not re-checked", async () => {
      await fx.store.writeComponent("card", `<div id="c"></div>`);
      await fx.store.writeTokens({ typography: { card: "12px" } });
      await fx.store.writeScreen("home", `<div id="n1"><p id="n2">x</p></div>`);
      await expect(promoteToSystem(fx.store, { node: "home.n2", kind: "component", name: "card" })).resolves.toBeDefined();
    });

    it("kind=component refuses a name equal to a token member (its new instances would be born ambiguous)", async () => {
      await fx.store.writeTokens({ typography: { card: "12px" } });
      await fx.store.writeScreen("home", `<div id="n1"><p id="n2">x</p></div>`);
      await expect(promoteToSystem(fx.store, { node: "home.n2", kind: "component", name: "card" })).rejects.toMatchObject({ code: "conflict" });
      expect(await fx.store.listComponents()).toEqual([]);
    });

    it("kind=pattern never collides", async () => {
      await fx.store.writeTokens({ typography: { card: "12px" } });
      await fx.store.writeScreen("home", `<div id="n1"><p id="n2">x</p></div>`);
      const res = await promoteToSystem(fx.store, { node: "home.n2", kind: "pattern", name: "card" });
      expect(res.warnings).toEqual([]);
    });
  });

  describe("an ambiguous instance that already exists on disk (hand edit, git checkout)", () => {
    it("does not flag a valid data-component instance that keeps a $-class token (the recommended escape hatch)", async () => {
      await fx.store.writeComponent("card", `<div id="c"></div>`);
      await fx.store.writeComponent("btn", `<button id="b"></button>`);
      await fx.store.writeTokens({ typography: { card: "12px" }, color: { primary: "#111" } });
      const registry = await loadRegistry(fx.store);
      const { doc } = parseScreen(
        `<div id="n1"><div id="a" data-component="card" class="$card"></div><button id="b" data-component="btn" class="$primary"></button></div>`,
        "home",
        registry,
      );
      const html = renderScreen(doc, await buildRenderContext(fx.store));
      expect(html).not.toContain("data-unresolved-token");
    });

    it("keeps the ambiguous ref in its original class position", async () => {
      await fx.store.writeComponent("eyebrow", EYEBROW);
      await fx.store.writeTokens({ typography: { eyebrow: "12px" } });
      const registry = await loadRegistry(fx.store);
      const { doc } = parseScreen(`<div id="n1"><p id="n2" class="a $eyebrow muted">x</p></div>`, "home", registry);
      expect(serializeScreen(doc)).toContain('class="a $eyebrow muted"');
    });

    it("keeps the class ref through serialization and renders with the red-outline marker", async () => {
      await fx.store.writeComponent("eyebrow", EYEBROW);
      await fx.store.writeTokens({ typography: { eyebrow: "12px" } });
      const registry = await loadRegistry(fx.store);
      const { doc } = parseScreen(`<div id="n1"><p id="n2" class="$eyebrow">x</p></div>`, "home", registry);

      expect(serializeScreen(doc)).toContain('class="$eyebrow"');
      const html = renderScreen(doc, await buildRenderContext(fx.store));
      expect(html).toContain('data-unresolved-token="eyebrow"');
    });
  });
});
