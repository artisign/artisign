import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { request } from "node:http";
import { setupArtisignHome, type ArtisignHomeFixture } from "../tools/test-fixtures.js";
import { startDaemon, type DaemonHandle } from "../daemon/start.js";
import { readLock } from "../daemon/lock.js";
import { SHUTDOWN_PATH, SHUTDOWN_TOKEN_HEADER } from "../daemon/shutdown.js";

function post(port: number, headers: Record<string, string>, method = "POST"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: SHUTDOWN_PATH, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("POST /api/daemon/shutdown", () => {
  let artisignHome: ArtisignHomeFixture;
  let daemon: DaemonHandle;
  const onShutdownRequest = vi.fn();

  beforeEach(async () => {
    onShutdownRequest.mockReset();
    artisignHome = await setupArtisignHome();
    daemon = await startDaemon({ port: 0, onShutdownRequest });
  });

  afterEach(async () => {
    await daemon.stop();
    await artisignHome.cleanup();
  });

  it("writes a token to daemon.lock and accepts it", async () => {
    const lock = await readLock();
    expect(lock?.shutdownToken).toMatch(/^[0-9a-f]{64}$/);
    const status = await post(daemon.port, { [SHUTDOWN_TOKEN_HEADER]: lock?.shutdownToken ?? "" });
    expect(status).toBe(202);
    await vi.waitFor(() => expect(onShutdownRequest).toHaveBeenCalledTimes(1));
  });

  it("rejects a missing or wrong token", async () => {
    expect(await post(daemon.port, {})).toBe(403);
    expect(await post(daemon.port, { [SHUTDOWN_TOKEN_HEADER]: "x".repeat(64) })).toBe(403);
    expect(onShutdownRequest).not.toHaveBeenCalled();
  });

  it("rejects a browser request even with the token", async () => {
    const lock = await readLock();
    const status = await post(daemon.port, {
      [SHUTDOWN_TOKEN_HEADER]: lock?.shutdownToken ?? "",
      origin: `http://127.0.0.1:${daemon.port}`,
    });
    expect(status).toBe(403);
    expect(onShutdownRequest).not.toHaveBeenCalled();
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    const lock = await readLock();
    const status = await post(daemon.port, { [SHUTDOWN_TOKEN_HEADER]: lock?.shutdownToken ?? "", host: "attacker.example" });
    expect(status).toBe(403);
    expect(onShutdownRequest).not.toHaveBeenCalled();
  });

  it("is POST only", async () => {
    const lock = await readLock();
    expect(await post(daemon.port, { [SHUTDOWN_TOKEN_HEADER]: lock?.shutdownToken ?? "" }, "GET")).toBe(405);
  });
});

describe("shutdown endpoint is opt-in", () => {
  it("is absent and writes no token without onShutdownRequest", async () => {
    const artisignHome = await setupArtisignHome();
    const daemon = await startDaemon({ port: 0 });
    try {
      expect((await readLock())?.shutdownToken).toBeUndefined();
      expect(await post(daemon.port, {})).toBe(404);
    } finally {
      await daemon.stop();
      await artisignHome.cleanup();
    }
  });
});
