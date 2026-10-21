import { describe, it, expect, vi } from "vitest";
import type { AddressInfo } from "node:net";

describe("/health version", () => {
  it("is the version the process started with, even if package.json changes afterwards", async () => {
    let onDisk = "1.0.0";
    vi.resetModules();
    vi.doMock("../version.js", () => ({ readVersion: () => onDisk }));
    const { createServer } = await import("./server.js");
    const { server } = createServer({} as never);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      onDisk = "2.0.0"; // what `npm install -g` does to package.json under a running daemon
      const { port } = server.address() as AddressInfo;
      const body = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { version: string };
      expect(body.version).toBe("1.0.0");
    } finally {
      await new Promise((resolve) => server.close(resolve));
      vi.doUnmock("../version.js");
    }
  });
});
