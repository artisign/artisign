import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";
import { createUpdateChecker } from "../daemon/update-status.js";
import { STARTED_VERSION } from "./server.js";

describe("GET /api/about update status", () => {
  let home: ArtisignHomeFixture;
  let daemon: DaemonHandle | undefined;

  beforeEach(async () => {
    home = await setupArtisignHome();
  });
  afterEach(async () => {
    await daemon?.stop();
    await home.cleanup();
  });

  const about = async () => (await fetch(`http://127.0.0.1:${daemon!.port}/api/about`)).json();

  it("reports an available update from the injected checker", async () => {
    const updateChecker = createUpdateChecker({ env: {}, currentVersion: STARTED_VERSION, latestVersion: async () => "99.0.0" });
    daemon = await startDaemon({ port: 0, projects: [], updateChecker });
    // The daemon does not await its first check, so poll until it has landed.
    await vi.waitFor(async () => {
      expect(await about()).toEqual({ version: STARTED_VERSION, updateCheck: "on", latest: "99.0.0", updateAvailable: true });
    });
  });

  it("reports no update when latest equals the started version", async () => {
    const updateChecker = createUpdateChecker({ env: {}, currentVersion: STARTED_VERSION, latestVersion: async () => STARTED_VERSION });
    daemon = await startDaemon({ port: 0, projects: [], updateChecker });
    await vi.waitFor(async () => {
      expect(await about()).toEqual({ version: STARTED_VERSION, updateCheck: "on", latest: STARTED_VERSION, updateAvailable: false });
    });
  });

  it("reports updateCheck off, without fetching, when disabled", async () => {
    let calls = 0;
    const updateChecker = createUpdateChecker({
      env: { ARTISIGN_NO_UPDATE_CHECK: "1" },
      currentVersion: STARTED_VERSION,
      latestVersion: async () => {
        calls++;
        return "99.0.0";
      },
    });
    daemon = await startDaemon({ port: 0, projects: [], updateChecker });
    // A disabled checker's start() returns without scheduling anything, so there is nothing to wait for.
    expect(await about()).toEqual({ version: STARTED_VERSION, updateCheck: "off", updateAvailable: false });
    expect(calls).toBe(0);
  });
});
