import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { abortUpdateCheck, checkForUpdate, isNewer, type UpdateNoticeDeps } from "./update-notice.js";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("update notice", () => {
  let fixture: ArtisignHomeFixture;
  let lines: string[];
  let fetchStub: ReturnType<typeof vi.fn>;
  let deps: UpdateNoticeDeps;

  const registryReplies = (latest: string): void => {
    fetchStub.mockResolvedValue({ ok: true, json: async () => ({ latest }) });
  };
  const cacheFile = (): string => join(fixture.home, "update-check.json");

  beforeEach(async () => {
    fixture = await setupArtisignHome();
    lines = [];
    fetchStub = vi.fn();
    deps = {
      env: {},
      isTTY: true,
      error: (line) => lines.push(line),
      fetch: fetchStub as unknown as typeof fetch,
      now: () => NOW,
      currentVersion: () => "2.0.0",
    };
  });

  afterEach(() => fixture.cleanup());

  it("isNewer compares x.y.z numerically and ignores prereleases", () => {
    expect(isNewer("2.0.1", "2.0.0")).toBe(true);
    expect(isNewer("10.0.0", "9.9.9")).toBe(true);
    expect(isNewer("2.0.0", "2.0.0")).toBe(false);
    expect(isNewer("1.9.9", "2.0.0")).toBe(false);
    expect(isNewer("3.0.0-beta.1", "2.0.0")).toBe(false);
    expect(isNewer("2.1.0", "2.0.0-rc.1")).toBe(true);
  });

  it("prints one line and caches the result when the registry has a newer version", async () => {
    registryReplies("2.1.0");
    await checkForUpdate(deps);
    expect(lines).toEqual(["New version 2.1.0 — run artisign update"]);
    expect(JSON.parse(await readFile(cacheFile(), "utf-8"))).toEqual({ checkedAt: NOW, latest: "2.1.0" });
  });

  it("prints nothing when already up to date", async () => {
    registryReplies("2.0.0");
    await checkForUpdate(deps);
    expect(lines).toEqual([]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("cache hit within 24 h: no request; a newer cached version is printed", async () => {
    await writeFile(cacheFile(), JSON.stringify({ checkedAt: NOW - HOUR, latest: "2.2.0" }));
    await checkForUpdate(deps);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(lines).toEqual(["New version 2.2.0 — run artisign update"]);
  });

  it("cache expired: asks again, and prints a newer cached version only once", async () => {
    await writeFile(cacheFile(), JSON.stringify({ checkedAt: NOW - 25 * HOUR, latest: "2.2.0" }));
    registryReplies("2.3.0");
    await checkForUpdate(deps);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(["New version 2.2.0 — run artisign update"]);
    expect(JSON.parse(await readFile(cacheFile(), "utf-8")).latest).toBe("2.3.0");
  });

  it("prints nothing when the running version is already at or above the cached latest (after an update)", async () => {
    await writeFile(cacheFile(), JSON.stringify({ checkedAt: NOW - HOUR, latest: "2.0.0" }));
    await checkForUpdate({ ...deps, currentVersion: () => "2.1.0" });
    expect(lines).toEqual([]);
  });

  it("abortUpdateCheck() ends a request that is still pending, silently", async () => {
    let signal: AbortSignal | undefined;
    fetchStub.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal = init.signal;
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = checkForUpdate(deps);
    await vi.waitFor(() => expect(signal).toBeDefined());

    abortUpdateCheck();

    await expect(pending).resolves.toBeUndefined();
    expect(signal!.aborted).toBe(true);
    expect(lines).toEqual([]);
  });

  it("is silent when offline, on a bad status or on bad JSON", async () => {
    fetchStub.mockRejectedValue(new Error("offline"));
    await expect(checkForUpdate(deps)).resolves.toBeUndefined();
    fetchStub.mockResolvedValue({ ok: false, json: async () => ({}) });
    await checkForUpdate(deps);
    fetchStub.mockResolvedValue({ ok: true, json: async () => { throw new Error("bad json"); } });
    await checkForUpdate(deps);
    fetchStub.mockResolvedValue({ ok: true, json: async () => ({ latest: "not-a-version" }) });
    await checkForUpdate(deps);
    expect(lines).toEqual([]);
  });

  it.each([
    ["CI is set", { env: { CI: "true" } }],
    ["stdout is not a TTY", { isTTY: false }],
    ["ARTISIGN_NO_UPDATE_CHECK=1", { env: { ARTISIGN_NO_UPDATE_CHECK: "1" } }],
  ])("does nothing when %s", async (_label, override) => {
    registryReplies("9.9.9");
    await checkForUpdate({ ...deps, ...override });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });
});
