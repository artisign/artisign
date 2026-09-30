import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { createRequire } from "node:module";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { patchHtml } from "./writes.js";
import { inspectNode } from "./inspect-node.js";
import { getNode } from "./reads.js";
import { __setPlaywrightImportForTests } from "./browser.js";

const require = createRequire(import.meta.url);
function isPlaywrightAvailable(): boolean {
  try {
    require.resolve("playwright");
    return true;
  } catch {
    return false;
  }
}

// CHR-746 — nodes inside a component instance's slot fill must be reachable by
// the write tools and inspect_node, the same way get_node/find_nodes see them
// (CHR-584). Fill content never enters ScreenDocument.nodes; the authored
// markup in the screen file stays the source of truth.
const SCREEN =
  `<main id="page">` +
  `<section id="install" class="$section">` +
  `<div data-slot="content" id="content-wrap"><h2 id="install-title">Install</h2><p id="install-copy" class="lead">Run it</p></div>` +
  `</section>` +
  `<div id="shot" class="$screenshot-frame"><img id="shot-img" data-slot="image" src="assets/a.png" alt="old"></div>` +
  `</main>`;

async function setup(fx: ProjectFixture): Promise<void> {
  await fx.store.writeComponent("section", `<section style="padding: 8px"><div data-slot="content"></div></section>`);
  await fx.store.writeComponent("screenshot-frame", `<div style="max-width: 200px"><div data-slot="image"></div></div>`);
  await fx.store.writeScreen("home", SCREEN);
}

describe("patch_html — nodes inside a slot fill (CHR-746)", () => {
  let fx: ProjectFixture;
  beforeEach(async () => {
    fx = await setupProject();
    await setup(fx);
  });
  afterEach(() => fx.cleanup());

  it("set_attr by node ref edits the authored fill markup", async () => {
    await patchHtml(fx.store, {
      target: { kind: "node", node: "home.install-copy" },
      operation: "set_attr",
      attr: { name: "data-x", value: "1" },
    });
    expect(await fx.store.readScreen("home")).toContain(`<p id="install-copy" class="lead" data-x="1">`);
  });

  it("set_attr on an <img> directly filling a slot", async () => {
    await patchHtml(fx.store, {
      target: { kind: "node", node: "home.shot-img" },
      operation: "set_attr",
      attr: { name: "alt", value: "new" },
    });
    const html = await fx.store.readScreen("home");
    expect(html).toContain(`alt="new"`);
    expect(html).toContain(`data-slot="image"`);
  });

  it("replace by node ref swaps a nested fill node", async () => {
    await patchHtml(fx.store, {
      target: { kind: "node", node: "home.install-title" },
      operation: "replace",
      html_aug: `<h3 id="install-title">Get started</h3>`,
    });
    const html = await fx.store.readScreen("home");
    expect(html).toContain(`<h3 id="install-title">Get started</h3>`);
    expect(html).not.toContain("<h2");
    expect(html).toContain(`<section id="install" class="$section">`);
  });

  it("replace of a top-level fill node keeps its slot name", async () => {
    await patchHtml(fx.store, {
      target: { kind: "node", node: "home.shot-img" },
      operation: "replace",
      html_aug: `<img id="shot-img" src="assets/b.png" alt="b">`,
    });
    const html = await fx.store.readScreen("home");
    expect(html).toContain(`src="assets/b.png"`);
    expect(html).toContain(`data-slot="image"`);
  });

  it("insert_after and delete work inside a fill", async () => {
    await patchHtml(fx.store, {
      target: { kind: "node", node: "home.install-title" },
      operation: "insert_after",
      html_aug: `<p id="sub">Sub</p>`,
    });
    let html = await fx.store.readScreen("home");
    expect(html.indexOf("install-title")).toBeLessThan(html.indexOf(`id="sub"`));
    await patchHtml(fx.store, { target: { kind: "node", node: "home.sub" }, operation: "delete" });
    html = await fx.store.readScreen("home");
    expect(html).not.toContain(`id="sub"`);
  });

  it("selector targets reach into fills", async () => {
    await patchHtml(fx.store, {
      target: { kind: "selector", screen: "home", css_selector: "p.lead" },
      operation: "set_attr",
      attr: { name: "data-y", value: "2" },
    });
    expect(await fx.store.readScreen("home")).toContain(`data-y="2"`);
    await patchHtml(fx.store, {
      target: { kind: "selector", screen: "home", css_selector: "#shot-img" },
      operation: "set_attr",
      attr: { name: "alt", value: "via-selector" },
    });
    expect(await fx.store.readScreen("home")).toContain(`alt="via-selector"`);
  });

  it("rejects a sibling insert next to a slot's top-level fill, and an id that is already taken", async () => {
    await expect(
      patchHtml(fx.store, { target: { kind: "node", node: "home.shot-img" }, operation: "insert_after", html_aug: `<p id="z">z</p>` }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      patchHtml(fx.store, { target: { kind: "node", node: "home.install-title" }, operation: "insert_after", html_aug: `<p id="page">z</p>` }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("deleting a top-level fill removes it from the instance", async () => {
    await patchHtml(fx.store, { target: { kind: "node", node: "home.shot-img" }, operation: "delete" });
    expect(await fx.store.readScreen("home")).not.toContain("shot-img");
  });

  it("an unknown id still reports not_found", async () => {
    await expect(
      patchHtml(fx.store, { target: { kind: "node", node: "home.nope" }, operation: "delete" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("get_node still does not list the fill in children", async () => {
    const res = await getNode(fx.store, { node: "home.install", view: "full" });
    expect(res.children).toEqual([]);
  });
});

describe.skipIf(!isPlaywrightAvailable())("inspect_node — nodes inside a slot fill (CHR-746)", () => {
  let fx: ProjectFixture;
  beforeEach(async () => {
    fx = await setupProject();
    await setup(fx);
  });
  afterEach(() => fx.cleanup());
  afterAll(() => __setPlaywrightImportForTests(undefined));

  it("returns a box for a nested fill node and for a slot-filling <img>", async () => {
    const copy = await inspectNode(fx.store, { node: "home.install-copy" });
    expect(copy.box.height).toBeGreaterThan(0);
    const img = await inspectNode(fx.store, { node: "home.shot-img" });
    expect(img.box.width).toBeGreaterThan(0);
  }, 30_000);
});
