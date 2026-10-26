import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readVersion } from "../version.js";
import { readChangelog } from "../changelog.js";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";

describe("GET /api/whats-new", () => {
  let home: ArtisignHomeFixture;
  let daemon: DaemonHandle;
  const version = readVersion();

  beforeEach(async () => {
    home = await setupArtisignHome();
    daemon = await startDaemon({ port: 0, projects: [] });
  });
  afterEach(async () => {
    await daemon.stop();
    await home.cleanup();
  });

  const get = async (query = "") => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/whats-new${query}`);
    return { status: res.status, json: (await res.json()) as { version: string; releases: { version: string; date: string | null; body: string }[] } };
  };

  it("returns all released sections up to the started version, newest first, with zero projects open", async () => {
    const { status, json } = await get();
    expect(status).toBe(200);
    expect(json.version).toBe(version);
    expect(json.releases.length).toBe(readChangelog().filter((r) => r.version.length > 0).length);
    expect(json.releases[0]?.version).toBe(version);
    expect(json.releases[0]).toEqual({ version, date: expect.any(String), body: expect.stringMatching(/\S/) });
  });

  it("applies since as an exclusive lower bound", async () => {
    const all = (await get()).json.releases.map((r) => r.version);
    const since = all[1] as string;
    expect((await get(`?since=${since}`)).json.releases.map((r) => r.version)).toEqual([all[0]]);
    expect((await get(`?since=${version}`)).json.releases).toEqual([]);
  });

  it("treats an unparsable since as absent", async () => {
    const all = (await get()).json.releases;
    expect((await get("?since=banana")).json.releases).toEqual(all);
  });

  it("rejects cross-origin requests and unknown methods", async () => {
    const url = `http://127.0.0.1:${daemon.port}/api/whats-new`;
    expect((await fetch(url, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    const post = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(post.status).toBe(404);
  });
});
