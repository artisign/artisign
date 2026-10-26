import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { writeHtml, patchHtml } from "./writes.js";
import { promoteMockup } from "./mockups.js";
import { deleteEntity } from "./lifecycle.js";
import { ToolError, type Warning } from "./types.js";

let fx: ProjectFixture;
beforeEach(async () => {
  fx = await setupProject();
});
afterEach(() => fx.cleanup());

const root = (backdrop?: string, inner = ""): string =>
  `<div id="root"${backdrop ? ` data-backdrop="${backdrop}"` : ""}>${inner}</div>`;

async function create(screen: string, html: string): Promise<Record<string, unknown>> {
  return writeHtml(fx.store, { screen, mode: "create", title: screen, html_aug: html });
}

async function rejection(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error("expected a ToolError");
}

describe("data-backdrop write validation", () => {
  it("write_html rejects data-backdrop on a non-root element, naming it, and writes nothing", async () => {
    const err = await rejection(create("a", root(undefined, `<div id="inner" data-backdrop="b"></div>`)));
    expect(err.code).toBe("validation_failed");
    expect(err.message).toContain("inner");
    expect(await fx.store.listScreens()).toEqual([]);
  });

  it("rejects data-backdrop inside a slot fill", async () => {
    await fx.store.writeComponent("card", `<div id="c"><div data-slot="body"></div></div>`);
    const err = await rejection(
      create("a", root(undefined, `<div class="$card"><div data-slot="body"><span id="deep" data-backdrop="b"></span></div></div>`)),
    );
    expect(err.code).toBe("validation_failed");
    expect(err.message).toContain("deep");
  });

  it("rejects a missing target with not_found and writes nothing", async () => {
    const err = await rejection(create("a", root("ghost")));
    expect(err.code).toBe("not_found");
    expect(await fx.store.listScreens()).toEqual([]);
  });

  it("rejects a self-reference", async () => {
    const err = await rejection(create("a", root("a")));
    expect(err.code).toBe("validation_failed");
  });

  it("rejects a two-screen cycle and names the chain", async () => {
    await create("a", root());
    await create("b", root("a"));
    const err = await rejection(writeHtml(fx.store, { screen: "a", mode: "replace", html_aug: root("b") }));
    expect(err.code).toBe("validation_failed");
    expect(err.message).toContain("a -> b -> a");
    expect(await fx.store.readScreen("a")).not.toContain("data-backdrop");
  });

  it("rejects a depth-3 cycle", async () => {
    await create("a", root());
    await create("c", root("a"));
    await create("b", root("c"));
    const err = await rejection(writeHtml(fx.store, { screen: "a", mode: "replace", html_aug: root("b") }));
    expect(err.code).toBe("validation_failed");
    expect(err.message).toContain("a -> b -> c -> a");
  });

  it("accepts a valid transitive chain", async () => {
    await create("c", root());
    await create("b", root("c"));
    const res = await create("a", root("b"));
    expect(res.errors).toBeUndefined();
    expect(await fx.store.readScreen("a")).toContain('data-backdrop="b"');
  });

  it("terminates on a pre-existing cycle on disk that does not involve the written screen", async () => {
    await fx.store.writeScreen("b", root("c"));
    await fx.store.writeScreen("c", root("b"));
    const res = await create("a", root("b"));
    expect(res.errors).toBeUndefined();
  });

  it("does not throw reading a screen whose backdrop is missing on disk", async () => {
    await fx.store.writeScreen("b", root("ghost"));
    const res = await create("a", root("b"));
    expect(res.errors).toBeUndefined();
  });

  it("write_html with an unchanged root backdrop skips the target checks", async () => {
    await create("b", root());
    await create("a", root("b"));
    await fx.store.deleteScreen("b");
    const res = await writeHtml(fx.store, { screen: "a", mode: "replace", html_aug: root("b", `<p id="p1">new</p>`) });
    expect(res.errors).toBeUndefined();
    expect((await rejection(writeHtml(fx.store, { screen: "a", mode: "replace", html_aug: root("other") }))).code).toBe("not_found");
  });

  it("flags a misspelled data-backdrop as suspicious_attr", async () => {
    const res = await create("a", root(undefined, `<p id="p1" data-backdorp="b">x</p>`));
    expect((res.warnings as Warning[]).some((w) => w.kind === "suspicious_attr")).toBe(true);
  });

  it("promote_mockup enforces the same validation", async () => {
    await fx.store.writeMockupMeta("m", { variants: [{ id: "v1", title: "V1", description: "" }] });
    await fx.store.writeMockupVariant("m", "v1", root("ghost"));
    const err = await rejection(promoteMockup(fx.store, { mockup: "m", variant: "v1", screen: "a" }));
    expect(err.code).toBe("not_found");
    expect(await fx.store.listScreens()).toEqual([]);
  });
});

describe("data-backdrop via patch_html", () => {
  beforeEach(async () => {
    await create("b", root());
    await create("a", root());
  });
  const setAttr = (screen: string, value: string | null) =>
    patchHtml(fx.store, { target: { kind: "node", node: `${screen}.root` }, operation: "set_attr", attr: { name: "data-backdrop", value } });

  it("adds a valid backdrop", async () => {
    await setAttr("a", "b");
    expect(await fx.store.readScreen("a")).toContain('data-backdrop="b"');
  });

  it("rejects a missing target, a self-reference and a cycle", async () => {
    expect((await rejection(setAttr("a", "ghost"))).code).toBe("not_found");
    expect((await rejection(setAttr("a", "a"))).code).toBe("validation_failed");
    await setAttr("b", "a");
    expect((await rejection(setAttr("a", "b"))).code).toBe("validation_failed");
  });

  it("rejects adding it to a non-root node", async () => {
    await create("n", root(undefined, `<p id="p1">x</p>`));
    const err = await rejection(
      patchHtml(fx.store, { target: { kind: "node", node: "n.p1" }, operation: "set_attr", attr: { name: "data-backdrop", value: "b" } }),
    );
    expect(err.code).toBe("validation_failed");
    expect(err.message).toContain("p1");
  });

  it("a misplaced data-backdrop already on disk does not block an unrelated patch, a new one does", async () => {
    await fx.store.writeScreen("n", root(undefined, `<p id="p1" data-backdrop="b">x</p><p id="p2">y</p>`));
    await patchHtml(fx.store, { target: { kind: "node", node: "n.p2" }, operation: "set_attr", attr: { name: "title", value: "t" } });
    const err = await rejection(
      patchHtml(fx.store, { target: { kind: "node", node: "n.p2" }, operation: "set_attr", attr: { name: "data-backdrop", value: "b" } }),
    );
    expect(err.message).toContain("p2");
    expect(err.message).not.toContain("p1");
  });

  it("removing the backdrop always succeeds, even when the target is gone", async () => {
    await setAttr("a", "b");
    await fx.store.deleteScreen("b");
    await setAttr("a", null);
    expect(await fx.store.readScreen("a")).not.toContain("data-backdrop");
  });
});

describe("delete_entity and dangling_backdrop", () => {
  it("deleting a backdrop succeeds with one warning per dependent and repairs nothing", async () => {
    await create("b", root());
    await create("a1", root("b"));
    await create("a2", root("b"));
    const res = await deleteEntity(fx.store, { kind: "screen", name: "b" });
    const warnings = res.warnings as Warning[];
    expect(warnings.map((w) => w.kind)).toEqual(["dangling_backdrop", "dangling_backdrop"]);
    expect(warnings.map((w) => w.target).sort()).toEqual(["a1.root", "a2.root"]);
    expect(await fx.store.readScreen("a1")).toContain('data-backdrop="b"');
  });

  it("with cascade, dependents inside the subtree are silent and outside ones warn", async () => {
    await create("main", root());
    await create("sheet", root("main"));
    await create("outside", root("main"));
    await fx.store.writeScreenMeta("sheet", { notes: "", tags: [], variant_of: "main", variant_kind: "overlay" });
    const res = await deleteEntity(fx.store, { kind: "screen", name: "main", cascade: true });
    expect((res.warnings as Warning[]).map((w) => w.target)).toEqual(["outside.root"]);
  });
});

describe("backdrop_candidate", () => {
  const items = (n: number, tag = "a"): string =>
    Array.from({ length: n }, (_, i) => `<p id="${tag}${i}" style="color: #123456; padding: ${i}px">item ${i}</p>`).join("");
  const item = (i: number, id: string): string => `<p id="${id}" style="color: #123456; padding: ${i}px">item ${i}</p>`;
  const warn = (res: Record<string, unknown>): Warning | undefined =>
    (res.warnings as Warning[]).find((w) => w.kind === "backdrop_candidate");

  async function setup(parentCount: number, kind: "overlay" | "state" = "overlay"): Promise<void> {
    await create("parent", root(undefined, items(parentCount, "p")));
    await fx.store.writeScreenMeta("sheet", { notes: "", tags: [], variant_of: "parent", variant_kind: kind });
  }
  // deleteScreen drops the sidecar too, so a re-write needs the overlay link again.
  const resetSheet = async (): Promise<void> => {
    await fx.store.deleteScreen("sheet");
    await fx.store.writeScreenMeta("sheet", { notes: "", tags: [], variant_of: "parent", variant_kind: "overlay" });
  };
  const writeSheet = (inner: string, backdrop?: string) =>
    writeHtml(fx.store, { screen: "sheet", mode: "create", title: "sheet", html_aug: root(backdrop, inner) });

  it("fires on copied nodes carrying different ids and tells the agent what to do", async () => {
    await setup(30);
    const w = warn(await writeSheet(items(30, "x")));
    expect(w?.message).toContain('data-backdrop="parent"');
  });

  it("different own text does not match, same text does", async () => {
    const row = (text: string, id: string): string => `<p id="${id}" style="color: #123456; padding: 4px">${text}</p>`;
    await create("parent", root(undefined, Array.from({ length: 25 }, (_, i) => row(`parent ${i}`, `p${i}`)).join("")));
    await fx.store.writeScreenMeta("sheet", { notes: "", tags: [], variant_of: "parent", variant_kind: "overlay" });
    expect(warn(await writeSheet(Array.from({ length: 25 }, (_, i) => row(`other ${i}`, `x${i}`)).join("")))).toBeUndefined();
    await resetSheet();
    expect(warn(await writeSheet(Array.from({ length: 25 }, (_, i) => row(`parent ${i}`, `x${i}`)).join("")))).toBeDefined();
  });

  it("counts component instances, so a component-built parent copied 1:1 is caught", async () => {
    await fx.store.writeComponent("chip", `<span id="c">chip</span>`);
    const chips = (tag: string): string => Array.from({ length: 22 }, (_, i) => `<span id="${tag}${i}" class="$chip"></span>`).join("");
    await create("parent", root(undefined, chips("p")));
    await fx.store.writeScreenMeta("sheet", { notes: "", tags: [], variant_of: "parent", variant_kind: "overlay" });
    expect(warn(await writeSheet(chips("x")))).toBeDefined();
  });

  it("is at threshold for the count: 20 matched of 20 fires, 19 does not", async () => {
    await setup(30);
    expect(warn(await writeSheet(items(20, "x")))).toBeDefined();
    await resetSheet();
    expect(warn(await writeSheet(items(19, "x")))).toBeUndefined();
  });

  it("is at threshold for the share: 20 of 40 fires, 20 of 41 does not", async () => {
    await setup(30);
    const own = (n: number): string => Array.from({ length: n }, (_, i) => `<p id="o${i}" style="color: #abcdef; margin: ${i}px">own ${i}</p>`).join("");
    expect(warn(await writeSheet(items(20, "x") + own(20)))).toBeDefined();
    await resetSheet();
    expect(warn(await writeSheet(items(20, "x") + own(21)))).toBeUndefined();
  });

  it("matches as a multiset: identical overlay nodes do not all match one parent node", async () => {
    await create("parent", root(undefined, item(1, "p1")));
    await fx.store.writeScreenMeta("sheet", { notes: "", tags: [], variant_of: "parent", variant_kind: "overlay" });
    const many = Array.from({ length: 30 }, (_, i) => item(1, `x${i}`)).join("");
    expect(warn(await writeSheet(many))).toBeUndefined();
  });

  it("stays silent for a non-overlay variant, no variant_of, an existing backdrop and a missing parent", async () => {
    await setup(30, "state");
    expect(warn(await writeSheet(items(30, "x")))).toBeUndefined();
    await fx.store.deleteScreen("sheet");

    await fx.store.writeScreenMeta("sheet", { notes: "", tags: [] });
    expect(warn(await writeSheet(items(30, "x")))).toBeUndefined();
    await fx.store.deleteScreen("sheet");

    await fx.store.writeScreenMeta("sheet", { notes: "", tags: [], variant_of: "parent", variant_kind: "overlay" });
    expect(warn(await writeSheet(items(30, "x"), "parent"))).toBeUndefined();
    await fx.store.deleteScreen("sheet");

    await fx.store.deleteScreen("parent");
    await fx.store.writeScreenMeta("sheet", { notes: "", tags: [], variant_of: "parent", variant_kind: "overlay" });
    expect(warn(await writeSheet(items(30, "x")))).toBeUndefined();
  });

  it("patch_html emits it too", async () => {
    await setup(30);
    await writeSheet(items(5, "x"));
    const ok = await patchHtml(fx.store, { target: { kind: "node", node: "sheet.x0" }, operation: "insert_after", html_aug: items(20, "y") });
    expect(warn(ok)).toBeDefined();
  });

  it("promote_mockup never emits it", async () => {
    await fx.store.writeMockupMeta("m", { variants: [{ id: "v1", title: "V1", description: "" }] });
    await fx.store.writeMockupVariant("m", "v1", root(undefined, items(30, "x")));
    await create("parent", root(undefined, items(30, "p")));
    await fx.store.writeScreenMeta("sheet", { notes: "", tags: [], variant_of: "parent", variant_kind: "overlay" });
    const res = await promoteMockup(fx.store, { mockup: "m", variant: "v1", screen: "sheet" });
    expect(warn(res)).toBeUndefined();
  });
});
