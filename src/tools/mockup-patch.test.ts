import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { writeMockup } from "./mockups.js";
import { patchHtml } from "./writes.js";
import { inspectNode } from "./inspect-node.js";
import { parseNodeRef } from "./node-ref.js";
import { deriveActivityEvent } from "../mcp/activity.js";

const FRAGMENT = `<div id="root">\n  <h1 id="title">Hello</h1>\n  <p id="body" style="color: red">Text</p>\n</div>`;
const FULL_DOC = `<!doctype html>\n<html>\n<head><style>.x{color:red}</style></head>\n<body>\n  <div id="root">\n    <h1 id="title">Hello</h1>\n  </div>\n</body>\n</html>\n`;

describe("parseNodeRef — mockup refs (CHR-956)", () => {
  it("parses mockup:<name>#<variant>.<node-id>", () => {
    expect(parseNodeRef("mockup:hero#a.title")).toEqual({
      kind: "mockup",
      name: "hero",
      variant: "a",
      nodeId: "title",
      address: "mockup:hero#a",
    });
  });

  it.each(["mockup:hero", "mockup:hero#a", "mockup:#a.x", "mockup:hero#.x", "mockup:hero#a.", "mockup:../x#a.n1", "mockup:hero#a/b.n1"])(
    "rejects malformed %s",
    (ref) => {
      expect(() => parseNodeRef(ref)).toThrowError(expect.objectContaining({ code: "validation_failed" }));
    },
  );
});

describe("patch_html on a mockup variant (CHR-956)", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
    await writeMockup(fx.store, { mockup: "hero", variant: "a", mode: "create", html: FRAGMENT });
    await writeMockup(fx.store, { mockup: "hero", variant: "b", mode: "create", html: FRAGMENT });
    await writeMockup(fx.store, { mockup: "doc", variant: "a", mode: "create", html: FULL_DOC });
  });
  afterEach(() => fx.cleanup());

  const patch = (node: string, operation: "replace" | "insert_before" | "insert_after" | "delete" | "set_attr", extra: object = {}) =>
    patchHtml(fx.store, { target: { kind: "node", node }, operation, ...extra } as never);

  it("set_attr changes only the addressed node; the rest of the file stays byte-stable", async () => {
    const res = await patch("mockup:hero#a.title", "set_attr", { attr: { name: "class", value: "big" } });
    expect(res).toMatchObject({ affected_nodes: ["mockup:hero#a.title"], warnings: [] });
    expect(res.commit).toBeDefined();
    expect(await fx.store.readMockupVariant("hero", "a")).toBe(FRAGMENT.replace('<h1 id="title">', '<h1 id="title" class="big">'));
    expect(await fx.store.readMockupVariant("hero", "b")).toBe(FRAGMENT);
  });

  it("replace, insert_before, insert_after and delete work like on a screen", async () => {
    await patch("mockup:hero#a.title", "replace", { html_aug: '<h2 id="title">Hi</h2>' });
    await patch("mockup:hero#a.title", "insert_after", { html_aug: '<hr id="rule">' });
    await patch("mockup:hero#a.body", "insert_before", { html_aug: '<span id="pre">x</span>' });
    await patch("mockup:hero#a.body", "delete");
    expect(await fx.store.readMockupVariant("hero", "a")).toBe(
      `<div id="root">\n  <h2 id="title">Hi</h2><hr id="rule">\n  <span id="pre">x</span>\n</div>`,
    );
  });

  it("stays lenient: unresolved $refs and inline values are not validated or drift-warned", async () => {
    const res = await patch("mockup:hero#a.body", "set_attr", { attr: { name: "style", value: "color: $color.nope; padding: 7px" } });
    expect(res.warnings).toEqual([]);
  });

  it("warns missing_id for a node without an authored id (derived address)", async () => {
    await writeMockup(fx.store, { mockup: "bare", variant: "a", mode: "create", html: "<div><span>x</span></div>" });
    const res = await patch("mockup:bare#a.n1", "set_attr", { attr: { name: "class", value: "c" } });
    expect((res.warnings as { kind: string }[]).map((w) => w.kind)).toEqual(["missing_id"]);
  });

  it("full-document variant: patches the addressed node, document stays byte-stable", async () => {
    await patch("mockup:doc#a.title", "set_attr", { attr: { name: "class", value: "big" } });
    expect(await fx.store.readMockupVariant("doc", "a")).toBe(FULL_DOC.replace('<h1 id="title">', '<h1 id="title" class="big">'));
  });

  it.each([
    ["unknown mockup", "mockup:nope#a.title"],
    ["unknown variant", "mockup:hero#zzz.title"],
    ["unknown node", "mockup:hero#a.nope"],
  ])("%s -> not_found", async (_label, node) => {
    await expect(patch(node, "delete")).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects response_mode diff/full (no canonical document), like definitions", async () => {
    await expect(patch("mockup:hero#a.title", "delete", { response_mode: "diff" })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("emits the same activity target write_mockup does", () => {
    const evt = deriveActivityEvent(
      "patch_html",
      { target: { kind: "node", node: "mockup:hero#a.title" } },
      true,
      { affected_nodes: ["mockup:hero#a.title"] },
    );
    expect(evt.target).toEqual({ kind: "mockup", name: "hero", variant: "a" });
    expect(evt.nodes).toEqual(["mockup:hero#a.title"]);
  });

  it("screen node patching is unchanged", async () => {
    await fx.store.writeScreen("home", `<div id="n1"><span id="n2">x</span></div>`);
    const res = await patch("home.n2", "set_attr", { attr: { name: "title", value: "c" } });
    expect(res.affected_nodes).toEqual(["home.n2"]);
  });
});

describe("inspect_node on a mockup variant (CHR-956)", () => {
  let fx: ProjectFixture;
  beforeEach(async () => {
    fx = await setupProject();
    await writeMockup(fx.store, { mockup: "hero", variant: "a", mode: "create", html: `<div id="root" style="width:200px;height:50px">x</div>` });
  });
  afterEach(() => fx.cleanup());

  it("unknown mockup / variant -> not_found without a browser", async () => {
    await expect(inspectNode(fx.store, { node: "mockup:nope#a.root" })).rejects.toMatchObject({ code: "not_found" });
    await expect(inspectNode(fx.store, { node: "mockup:hero#zzz.root" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns a box for an authored id", async () => {
    const res = await inspectNode(fx.store, { node: "mockup:hero#a.root" });
    expect(res.box).toMatchObject({ width: 200, height: 50 });
  }, 60_000);

  it("unknown node -> not_found", async () => {
    await expect(inspectNode(fx.store, { node: "mockup:hero#a.nope" })).rejects.toMatchObject({ code: "not_found" });
  }, 60_000);
});
