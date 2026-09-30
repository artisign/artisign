import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { compareScreens } from "./compare.js";

describe("compareScreens", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  const write = (name: string, html: string) => fx.store.writeScreen(name, html);

  const BASE = `<main id="page"><header id="top"><h1 id="greeting">Hello</h1></header><section id="content"><ul id="card-list"><li id="card-1">A</li></ul></section></main>`;

  async function compareOne(base: string, other: string) {
    const res = await compareScreens(fx.store, base, [other]);
    expect(res.base).toBe(base);
    return res.members[0]!;
  }

  it("matches by authored id: identical screens have no differences", async () => {
    await write("a", BASE);
    await write("b", BASE);
    const m = await compareOne("a", "b");
    expect(m).toEqual({
      screen: "b",
      status: "ok",
      overlap: { shared: 6, base: 6, member: 6, ratio: 1 },
      added: [],
      removed: [],
      changed: [],
      counts: { added: 0, removed: 0, changed: 0 },
    });
  });

  it("reports added, removed and changed identity nodes", async () => {
    await write("a", BASE);
    await write(
      "b",
      `<main id="page"><header id="top"><h1 id="greeting" style="color: red">Hello</h1></header><section id="content"><div id="empty-state">none</div></section></main>`,
    );
    const m = await compareOne("a", "b");
    expect(m.added).toEqual(["empty-state"]);
    expect(m.removed).toEqual([{ id: "card-list", parent: "content" }]);
    expect(m.changed).toEqual(["greeting"]);
    // card-1 is removed too, but folded away in the list; counts stay unfolded.
    expect(m.counts).toEqual({ added: 1, removed: 2, changed: 1 });
  });

  it("folds a text change in anonymous content into the enclosing identity node", async () => {
    await write("a", BASE);
    await write("b", BASE.replace(">Hello<", ">Hi there<"));
    const m = await compareOne("a", "b");
    expect(m.changed).toEqual(["greeting"]);
    expect(m.added).toEqual([]);
    expect(m.removed).toEqual([]);
  });

  it("folds anonymous elements: an inserted one changes its ancestor and shifts nothing", async () => {
    await write("a", `<main id="page"><div id="row"><span>x</span><b id="tail">t</b></div></main>`);
    await write("b", `<main id="page"><div id="row"><i>new</i><span>x</span><b id="tail">t</b></div></main>`);
    const m = await compareOne("a", "b");
    expect(m.changed).toEqual(["row"]);
    expect(m.added).toEqual([]);
    expect(m.removed).toEqual([]);
    expect(m.counts).toEqual({ added: 0, removed: 0, changed: 1 });
  });

  it("does not mark an ancestor changed when only an identity descendant changed", async () => {
    await write("a", `<main id="page"><div id="row"><b id="tail">t</b></div></main>`);
    await write("b", `<main id="page"><div id="row"><b id="tail">u</b></div></main>`);
    expect((await compareOne("a", "b")).changed).toEqual(["tail"]);
  });

  it("folds added and removed to subtree roots while counts stay unfolded", async () => {
    await write("a", `<main id="page"><div id="keep">k</div><section id="gone"><p id="gone-a">a</p><p id="gone-b">b</p></section></main>`);
    await write("b", `<main id="page"><div id="keep">k</div><section id="fresh"><p id="fresh-a">a</p><p id="fresh-b">b</p></section></main>`);
    const m = await compareOne("a", "b");
    expect(m.added).toEqual(["fresh"]);
    expect(m.removed).toEqual([{ id: "gone", parent: "page" }]);
    expect(m.counts).toEqual({ added: 3, removed: 3, changed: 0 });
  });

  it("removed[].parent is the nearest identity ancestor in the reference, null for a root", async () => {
    await write("a", `<main id="page"><div><p id="deep">x</p></div><b id="keep">k</b></main>`);
    await write("b", `<main id="page"><b id="keep">k</b></main>`);
    const m = await compareOne("a", "b");
    expect(m.removed).toEqual([{ id: "deep", parent: "page" }]);

  });

  it("a removed identity root has parent null", async () => {
    await write("a", `<main id="page"><b id="keep">k</b></main>`);
    await write("b", `<main id="page-2"><b id="keep">k</b></main>`);
    const m = await compareOne("a", "b");
    expect(m.removed).toEqual([{ id: "page", parent: null }]);
    expect(m.added).toEqual(["page-2"]);
  });

  describe("overlap threshold", () => {
    const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `<i id="${prefix}${i}"></i>`).join("");

    it("is low_overlap just under 0.25, with empty lists", async () => {
      // shared 2 / max(9, 9) = 0.222
      await write("a", `<div id="root-a">${ids(2, "s")}${ids(6, "a")}</div>`);
      await write("b", `<div id="root-b">${ids(2, "s")}${ids(6, "b")}</div>`);
      // root ids differ, so shared = 2 of 9 identity ids per side.
      const m = await compareOne("a", "b");
      expect(m.overlap).toEqual({ shared: 2, base: 9, member: 9, ratio: 0.22 });
      expect(m.status).toBe("low_overlap");
      expect(m.added).toEqual([]);
      expect(m.removed).toEqual([]);
      expect(m.changed).toEqual([]);
      expect(m.counts).toEqual({ added: 0, removed: 0, changed: 0 });
    });

    it("is ok at exactly 0.25", async () => {
      // shared 2 / max(8, 8) = 0.25
      await write("a", `<div id="root-a">${ids(2, "s")}${ids(5, "a")}</div>`);
      await write("b", `<div id="root-b">${ids(2, "s")}${ids(5, "b")}</div>`);
      const m = await compareOne("a", "b");
      expect(m.overlap).toEqual({ shared: 2, base: 8, member: 8, ratio: 0.25 });
      expect(m.status).toBe("ok");
      expect(m.added.length).toBeGreaterThan(0);
    });

    it("is low_overlap when a side has no identity ids", async () => {
      await write("a", `<div><p>x</p></div>`);
      await write("b", `<div id="page"><p id="x">x</p></div>`);
      const m = await compareOne("a", "b");
      expect(m.status).toBe("low_overlap");
      expect(m.overlap).toEqual({ shared: 0, base: 0, member: 2, ratio: 0 });
      expect(m.added).toEqual([]);
      expect(m.counts).toEqual({ added: 0, removed: 0, changed: 0 });
    });
  });

  it("compares several members in order", async () => {
    await write("a", BASE);
    await write("b", BASE);
    await write("c", BASE);
    const res = await compareScreens(fx.store, "a", ["c", "b"]);
    expect(res.members.map((m) => m.screen)).toEqual(["c", "b"]);
  });

  it("throws not_found for an unknown screen", async () => {
    await write("a", BASE);
    await expect(compareScreens(fx.store, "a", ["nope"])).rejects.toMatchObject({ code: "not_found" });
    await expect(compareScreens(fx.store, "nope", ["a"])).rejects.toMatchObject({ code: "not_found" });
  });
});
