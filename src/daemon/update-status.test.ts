import { describe, it, expect, afterEach, vi } from "vitest";
import { createUpdateChecker } from "./update-status.js";

afterEach(() => vi.useRealTimers());

const make = (latest: string | undefined, over: Parameters<typeof createUpdateChecker>[0] = {}) => {
  const latestVersion = vi.fn().mockResolvedValue(latest);
  const checker = createUpdateChecker({ env: {}, currentVersion: "2.0.0", latestVersion, ...over });
  return { checker, latestVersion };
};

describe("createUpdateChecker", () => {
  it("is on, with nothing known, before the first check", () => {
    expect(make("2.1.0").checker.status()).toEqual({ updateCheck: "on", updateAvailable: false });
  });

  it("reports a newer latest as an available update", async () => {
    const { checker } = make("2.1.0");
    await checker.start();
    expect(checker.status()).toEqual({ updateCheck: "on", latest: "2.1.0", updateAvailable: true });
    checker.stop();
  });

  it.each([
    ["equal", "2.0.0", "2.0.0", false],
    ["older", "1.9.0", "2.0.0", false],
    ["prerelease current below latest", "2.0.1", "2.0.0-rc.1", true],
    ["prerelease latest ignored", "3.0.0-beta.1", "2.0.0", false],
  ])("%s", async (_n, latest, current, available) => {
    const { checker } = make(latest, { currentVersion: current });
    await checker.start();
    expect(checker.status().updateAvailable).toBe(available);
    checker.stop();
  });

  it("keeps the last known latest when a later check fails", async () => {
    vi.useFakeTimers();
    const latestVersion = vi.fn().mockResolvedValueOnce("2.1.0").mockRejectedValue(new Error("offline"));
    const checker = createUpdateChecker({ env: {}, currentVersion: "2.0.0", latestVersion });
    await checker.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(latestVersion).toHaveBeenCalledTimes(2);
    expect(checker.status().latest).toBe("2.1.0");
    checker.stop();
  });

  it("checks again every 24 h until stopped", async () => {
    vi.useFakeTimers();
    const { checker, latestVersion } = make("2.1.0");
    await checker.start();
    expect(latestVersion).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
    expect(latestVersion).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(latestVersion).toHaveBeenCalledTimes(2);
    checker.stop();
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
    expect(latestVersion).toHaveBeenCalledTimes(2);
  });

  it("unrefs its timer", async () => {
    const unref = vi.fn();
    const checker = createUpdateChecker({
      env: {},
      currentVersion: "2.0.0",
      latestVersion: async () => undefined,
      setInterval: () => ({ unref }),
    });
    await checker.start();
    expect(unref).toHaveBeenCalled();
  });

  it.each([
    ["CI", { CI: "true" }],
    ["ARTISIGN_NO_UPDATE_CHECK", { ARTISIGN_NO_UPDATE_CHECK: "1" }],
  ])("is off and silent when %s is set", async (_n, env) => {
    const { checker, latestVersion } = make("9.9.9", { env });
    await checker.start();
    expect(latestVersion).not.toHaveBeenCalled();
    expect(checker.status()).toEqual({ updateCheck: "off", updateAvailable: false });
  });

  it("treats CI=0 / false as unset", async () => {
    const { checker, latestVersion } = make("2.1.0", { env: { CI: "0", ARTISIGN_NO_UPDATE_CHECK: "false" } });
    await checker.start();
    expect(latestVersion).toHaveBeenCalledTimes(1);
    checker.stop();
  });
});
