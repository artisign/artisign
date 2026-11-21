import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, type RenameFn } from "./atomic-write.js";

function lockError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: resource busy or locked`), { code });
}

describe("atomicWrite", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-write-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renames on the first attempt without delay", async () => {
    const target = join(dir, "a.txt");
    const rename = vi.fn<RenameFn>(async () => undefined);
    const spy = vi.spyOn(globalThis, "setTimeout");
    await atomicWrite(target, "x", { rename });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each(["EPERM", "EBUSY", "EACCES"])("succeeds after a transient %s", async (code) => {
    const target = join(dir, "a.txt");
    await writeFile(target, "old");
    let calls = 0;
    const rename: RenameFn = async (from, to) => {
      if (++calls < 3) throw lockError(code);
      const { rename: real } = await import("node:fs/promises");
      await real(from, to);
    };
    await atomicWrite(target, "new", { rename, retryDelaysMs: [1, 1, 1, 1] });
    expect(calls).toBe(3);
    expect(await readFile(target, "utf-8")).toBe("new");
    expect(await readdir(dir)).toEqual(["a.txt"]);
  });

  it("fails after the bound, names the file, removes the temp file and keeps the old content", async () => {
    const target = join(dir, "a.txt");
    await writeFile(target, "old");
    const rename = vi.fn<RenameFn>(async () => {
      throw lockError("EPERM");
    });
    await expect(atomicWrite(target, "new", { rename, retryDelaysMs: [1, 1] })).rejects.toThrow(target);
    expect(rename).toHaveBeenCalledTimes(3);
    expect(await readFile(target, "utf-8")).toBe("old");
    expect(await readdir(dir)).toEqual(["a.txt"]);
  });

  it("does not retry other errors and cleans up the temp file", async () => {
    const target = join(dir, "a.txt");
    const rename = vi.fn<RenameFn>(async () => {
      throw lockError("ENOSPC");
    });
    await expect(atomicWrite(target, "new", { rename, retryDelaysMs: [1, 1] })).rejects.toThrow("ENOSPC");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it("still accepts a numeric mode and Buffer content", async () => {
    const target = join(dir, "b.bin");
    await atomicWrite(target, Buffer.from([1, 2, 3]), 0o600);
    expect([...(await readFile(target))]).toEqual([1, 2, 3]);
  });
});
