import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsStore } from "../store/fs-store.js";
import { initProject } from "../init/init-project.js";
import { buildIndex, rebuildAndPersistIndex } from "./index-builder.js";

describe("buildIndex", () => {
  let dir: string;
  let store: FsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "artisign-index-"));
    await initProject(dir);
    store = new FsStore(dir);

    const tokens = await store.readTokens();
    tokens.color = { primary: "#3366ff" };
    await store.writeTokens(tokens);

    await store.writeComponent("btn-primary", `<button id="n1">Go</button>`);
    await store.writeScreen(
      "home",
      `<section id="n1" style="color: $color.primary"><button id="n2" class="$btn-primary"></button></section>`,
    );
    await store.writeScreen("about", `<div id="n1" style="color: $color.primary"></div>`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("indexes screens, nodes, and the token/component ref graph", async () => {
    const index = await buildIndex(store);

    expect(Object.keys(index.screens).sort()).toEqual(["about", "home"]);
    expect(index.screens.home!.nodeCount).toBe(2);

    expect(index.nodes["home.n1"]).toEqual({ screenId: "home", kind: "element", parentId: null });
    expect(index.nodes["home.n2"]).toEqual({ screenId: "home", kind: "component_instance", parentId: "n1" });

    expect(index.refGraph.tokens["color.primary"]?.sort()).toEqual(["about.n1", "home.n1"]);
    expect(index.refGraph.components["btn-primary"]).toEqual(["home.n2"]);
  });

  it("keeps token-class refs separate from token dot-path refs in the ref graph", async () => {
    const tokens = await store.readTokens();
    tokens.layout = { "screen-base": "flex" };
    await store.writeTokens(tokens);
    await store.writeScreen(
      "landing",
      `<section id="n1" class="$screen-base" style="color: $color.primary"></section>`,
    );

    const index = await buildIndex(store);

    expect(index.refGraph.tokens["color.primary"]).toContain("landing.n1");
    expect(index.refGraph.tokens["screen-base"]).toBeUndefined();
    expect(index.refGraph.tokenClasses["screen-base"]).toEqual(["landing.n1"]);
  });

  it("indexes both refs of a mixed multi-ref value", async () => {
    const tokens = await store.readTokens();
    tokens.spacing = { sm: "8px", lg: "24px" };
    await store.writeTokens(tokens);
    await store.writeScreen("checkout", `<div id="n1" style="padding: $spacing.sm $spacing.lg"></div>`);

    const index = await buildIndex(store);

    expect(index.refGraph.tokens["spacing.sm"]).toEqual(["checkout.n1"]);
    expect(index.refGraph.tokens["spacing.lg"]).toEqual(["checkout.n1"]);
  });

  it("deleting .artisign/ and rebuilding produces a byte-identical index", async () => {
    const first = await rebuildAndPersistIndex(store);
    const firstBytes = JSON.stringify(await store.readCacheIndex());

    await rm(join(dir, ".artisign"), { recursive: true, force: true });
    expect(await store.readCacheIndex()).toBeUndefined();

    const second = await rebuildAndPersistIndex(store);
    const secondBytes = JSON.stringify(await store.readCacheIndex());

    expect(second).toEqual(first);
    expect(secondBytes).toBe(firstBytes);
  });

  it(".artisign/ is self-ignoring, and stays self-ignoring after being deleted and rebuilt", async () => {
    await expect(readFile(join(dir, ".artisign", ".gitignore"), "utf-8")).resolves.toBe("*\n");

    await rm(join(dir, ".artisign"), { recursive: true, force: true });
    await rebuildAndPersistIndex(store);

    await expect(readFile(join(dir, ".artisign", ".gitignore"), "utf-8")).resolves.toBe("*\n");
  });
});
