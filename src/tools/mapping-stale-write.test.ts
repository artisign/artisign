import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupProject, type ProjectFixture } from "./test-fixtures.js";
import { writeHtml, patchHtml } from "./writes.js";
import { deleteEntity } from "./lifecycle.js";
import { getUseCase, setUseCases } from "./usecases.js";
import { MAPPING_STALE_CAP } from "../usecases/index.js";
import type { Warning } from "./types.js";

const DIMENSIONS = [{ id: "membership", name: "Membership", values: [{ id: "student", label: "Student" }, { id: "staff", label: "Staff" }] }];
const PERSONAS = [{ id: "member-ana", name: "Ana", traits: { membership: "student" } }];

const catalogHtml = (button: string): string => `<section id="root"><button id="${button}">Borrow</button><p id="note">Hi</p></section>`;

function borrowCase(): Record<string, unknown> {
  return {
    id: "borrow-book",
    title: "Borrow a book",
    personas: ["member-ana"],
    inputs: [{ object: "loan", source: "catalog", example: { status: "x" } }],
    outputs: [{ object: "loan", target: "catalog", example: { status: "x" } }],
    steps: [
      { id: "borrow", actor: "member-ana", action: "Taps borrow", target: { screen: "catalog", node: "btn-borrow" } },
      { id: "confirm", actor: "member-ana", action: "Sees the confirmation", target: { screen: "loan-confirm" } },
      { id: "elsewhere", actor: "member-ana", action: "Reads a note", target: { screen: "other", node: "keep" } },
    ],
    branches: [{ id: "denied", title: "Denied", from: "borrow", when: [{ subject: "loan", property: "status", value: "denied" }], steps: [{ id: "deny", actor: "system", action: "Refuses", target: { screen: "catalog", node: "btn-borrow" } }] }],
    variants: [
      { id: "staff", title: "Staff", when: { membership: ["staff"] }, steps: [{ op: "append", step: { id: "override", actor: "member-ana", action: "Overrides", target: { screen: "catalog", node: "btn-borrow" } } }] },
    ],
  };
}

const stale = (res: Record<string, unknown>): Warning[] => (res.warnings as Warning[]).filter((w) => w.kind === "mapping_stale");

describe("mapping_stale at write time (CHR-1123)", () => {
  let fx: ProjectFixture;

  beforeEach(async () => {
    fx = await setupProject();
  });
  afterEach(() => fx.cleanup());

  async function seed(): Promise<void> {
    await writeHtml(fx.store, { screen: "catalog", mode: "create", title: "Catalog", html_aug: catalogHtml("btn-borrow") });
    await writeHtml(fx.store, { screen: "loan-confirm", mode: "create", title: "Confirm", html_aug: `<section id="c-root"><h1 id="c-title">Done</h1></section>` });
    await writeHtml(fx.store, { screen: "other", mode: "create", title: "Other", html_aug: `<section id="o-root"><p id="keep">x</p></section>` });
    await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, use_cases: [borrowCase()] });
  }

  it("write_html replace warns when a mapped node is re-id'd, naming case, variant, branch and step", async () => {
    await seed();
    const res = await writeHtml(fx.store, { screen: "catalog", mode: "replace", html_aug: catalogHtml("btn-loan") });
    const warnings = stale(res);
    expect(warnings.map((w) => w.target).sort()).toEqual(["use_case:borrow-book#staff/override", "use_case:borrow-book/borrow", "use_case:borrow-book/deny"]);
    expect(warnings.find((w) => w.target === "use_case:borrow-book/deny")!.message).toBe('node "btn-borrow" does not exist on screen "catalog"');
    // Same semantics as the read: get_use_case agrees.
    const read = (await getUseCase(fx.store, { id: "borrow-book" })) as { warnings: Warning[] };
    expect(read.warnings.filter((w) => w.kind === "mapping_stale")).toHaveLength(3);
  });

  it("write_html replace that keeps the mapped node warns about nothing", async () => {
    await seed();
    const res = await writeHtml(fx.store, { screen: "catalog", mode: "replace", html_aug: catalogHtml("btn-borrow") });
    expect(stale(res)).toEqual([]);
  });

  it("patch_html delete and replace of the mapped node warn; set_attr and insert do not", async () => {
    await seed();
    const attr = await patchHtml(fx.store, { target: { kind: "node", node: "catalog.note" }, operation: "set_attr", attr: { name: "title", value: "t" } });
    expect(stale(attr)).toEqual([]);
    const unrelated = await patchHtml(fx.store, { target: { kind: "node", node: "catalog.note" }, operation: "delete" });
    expect(stale(unrelated)).toEqual([]);
    const replaced = await patchHtml(fx.store, { target: { kind: "node", node: "catalog.btn-borrow" }, operation: "replace", html_aug: `<button id="btn-loan">Borrow</button>` });
    expect(stale(replaced)).toHaveLength(3);
  });

  it("does not repeat a mapping that was already stale before the write", async () => {
    await seed();
    await writeHtml(fx.store, { screen: "catalog", mode: "replace", html_aug: catalogHtml("btn-loan") });
    const again = await writeHtml(fx.store, { screen: "catalog", mode: "replace", html_aug: catalogHtml("btn-other") });
    expect(stale(again)).toEqual([]);
  });

  it("a step already stale (node missing) is not reported again when its screen is deleted", async () => {
    await seed();
    await writeHtml(fx.store, { screen: "catalog", mode: "replace", html_aug: catalogHtml("btn-loan") });
    const res = await deleteEntity(fx.store, { kind: "screen", name: "catalog" });
    expect(stale(res)).toEqual([]);
  });

  it("fails open: a readUseCases error neither blocks nor fails write_html, patch_html or delete_entity", async () => {
    await seed();
    fx.store.readUseCases = async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    const written = await writeHtml(fx.store, { screen: "catalog", mode: "replace", html_aug: catalogHtml("btn-loan") });
    expect(stale(written)).toEqual([]);
    const patched = await patchHtml(fx.store, { target: { kind: "node", node: "catalog.btn-loan" }, operation: "delete" });
    expect(stale(patched)).toEqual([]);
    const deleted = await deleteEntity(fx.store, { kind: "screen", name: "loan-confirm" });
    expect(stale(deleted)).toEqual([]);
    expect(await fx.store.listScreens()).not.toContain("loan-confirm");
  });

  it("delete_entity screen warns next to dangling_flow, for the screen and for a node on it", async () => {
    await seed();
    const res = await deleteEntity(fx.store, { kind: "screen", name: "loan-confirm" });
    expect(stale(res)).toEqual([{ kind: "mapping_stale", target: "use_case:borrow-book/confirm", message: 'screen "loan-confirm" does not exist' }]);
    const node = await deleteEntity(fx.store, { kind: "screen", name: "catalog" });
    expect(stale(node).map((w) => w.target).sort()).toEqual(["use_case:borrow-book#staff/override", "use_case:borrow-book/borrow", "use_case:borrow-book/deny"]);
  });

  it("delete_entity screen with cascade covers the whole subtree", async () => {
    await seed();
    await writeHtml(fx.store, { screen: "other-b", mode: "create", title: "B", html_aug: `<div id="b">x</div>` });
    await fx.store.writeScreenMeta("other-b", { notes: "", tags: [], variant_of: "other", variant_kind: "state" });
    await setUseCases(fx.store, { use_cases: [{ ...borrowCase(), id: "second", steps: [{ id: "s1", actor: "member-ana", action: "x", target: { screen: "other-b", node: "b" } }], branches: undefined, variants: undefined }] });
    const res = await deleteEntity(fx.store, { kind: "screen", name: "other", cascade: true });
    expect(stale(res).map((w) => w.target).sort()).toEqual(["use_case:borrow-book/elsewhere", "use_case:second/s1"]);
  });

  it("caps the list and counts the omitted warnings", async () => {
    await writeHtml(fx.store, { screen: "big", mode: "create", title: "Big", html_aug: `<section id="root"><b id="a">x</b></section>` });
    const steps = Array.from({ length: MAPPING_STALE_CAP + 5 }, (_, i) => ({ id: `s${i}`, actor: "member-ana", action: "x", target: { screen: "big", node: "a" } }));
    await setUseCases(fx.store, { dimensions: DIMENSIONS, personas: PERSONAS, use_cases: [{ id: "many", title: "Many", personas: ["member-ana"], inputs: [{ object: "loan", source: "catalog", example: { status: "x" } }], outputs: [{ object: "loan", target: "catalog", example: { status: "x" } }], steps }] });
    const res = await deleteEntity(fx.store, { kind: "screen", name: "big" });
    expect(stale(res)).toHaveLength(MAPPING_STALE_CAP);
    expect(res.mapping_stale_omitted_count).toBe(5);
  });

  it("a project without use cases answers exactly as before: no field, no usecases/ folder", async () => {
    await writeHtml(fx.store, { screen: "home", mode: "create", title: "Home", html_aug: `<section id="root"><b id="a">x</b></section>` });
    const written = await writeHtml(fx.store, { screen: "home", mode: "replace", html_aug: `<section id="root"><b id="z">x</b></section>` });
    const patched = await patchHtml(fx.store, { target: { kind: "node", node: "home.z" }, operation: "delete" });
    const deleted = await deleteEntity(fx.store, { kind: "screen", name: "home" });
    for (const res of [written, patched, deleted]) {
      expect(res.warnings as Warning[]).toEqual((res.warnings as Warning[]).filter((w) => w.kind !== "mapping_stale"));
      expect(res).not.toHaveProperty("mapping_stale_omitted_count");
    }
    const { stat } = await import("node:fs/promises");
    await expect(stat(`${fx.dir}/usecases`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
