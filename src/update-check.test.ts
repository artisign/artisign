import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupArtisignHome, type ArtisignHomeFixture } from "./tools/test-fixtures.js";
import { latestVersion } from "./update-check.js";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("latestVersion", () => {
  let fixture: ArtisignHomeFixture;
  let fetchStub: ReturnType<typeof vi.fn>;
  const cacheFile = (): string => join(fixture.home, "update-check.json");
  const deps = () => ({ fetch: fetchStub as unknown as typeof fetch, now: () => NOW });

  beforeEach(async () => {
    fixture = await setupArtisignHome();
    fetchStub = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ latest: "3.0.0" }) });
  });
  afterEach(() => fixture.cleanup());

  it("fresh cache: returns it without a request", async () => {
    await writeFile(cacheFile(), JSON.stringify({ checkedAt: NOW - HOUR, latest: "2.5.0" }));
    expect(await latestVersion(deps())).toBe("2.5.0");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("stale or missing cache: one request, cache written atomically", async () => {
    await writeFile(cacheFile(), JSON.stringify({ checkedAt: NOW - 25 * HOUR, latest: "2.5.0" }));
    expect(await latestVersion(deps())).toBe("3.0.0");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(cacheFile(), "utf-8"))).toEqual({ checkedAt: NOW, latest: "3.0.0" });
  });

  it("offline: the stale cached value, or undefined, never a throw", async () => {
    fetchStub.mockRejectedValue(new Error("offline"));
    expect(await latestVersion(deps())).toBeUndefined();
    await writeFile(cacheFile(), JSON.stringify({ checkedAt: NOW - 25 * HOUR, latest: "2.5.0" }));
    expect(await latestVersion(deps())).toBe("2.5.0");
  });

  it("rejects a non-x.y.z answer", async () => {
    fetchStub.mockResolvedValue({ ok: true, json: async () => ({ latest: "next" }) });
    expect(await latestVersion(deps())).toBeUndefined();
  });
});
