import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offerSetup, type OfferSetupDeps } from "./offer-setup.js";
import { CLIENTS, defaultClientEnv } from "../setup/clients.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "artisign-offer-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const desktopDir = (): string => join(home, "Library", "Application Support", "Claude");

function make(over: Partial<OfferSetupDeps> = {}) {
  let declined = false;
  const deps: OfferSetupDeps = {
    env: { ...defaultClientEnv(), home, platform: "darwin", pathEnv: "", vars: {} },
    clients: CLIENTS,
    isTTY: true,
    processEnv: {},
    ask: vi.fn(async () => ""),
    runSetup: vi.fn(async () => 0),
    isDeclined: async () => declined,
    rememberDecline: async () => void (declined = true),
    ...over,
  };
  return deps;
}

async function installDesktop(config: object = {}): Promise<void> {
  await mkdir(desktopDir(), { recursive: true });
  await writeFile(join(desktopDir(), "claude_desktop_config.json"), JSON.stringify(config));
}

describe("offerSetup", () => {
  it("asks once naming the detected tools; yes (or Enter) runs setup", async () => {
    await installDesktop();
    const d = make();
    await offerSetup("e", d);
    expect(d.ask).toHaveBeenCalledWith("Connect Artisign to Claude Desktop now? [Y/n] ");
    expect(d.runSetup).toHaveBeenCalledWith("e");
  });

  it("no is remembered and the question is never asked again", async () => {
    await installDesktop();
    const d = make({ ask: vi.fn(async () => "n") });
    await offerSetup("e", d);
    expect(d.runSetup).not.toHaveBeenCalled();
    await offerSetup("e", d);
    expect(d.ask).toHaveBeenCalledTimes(1);
  });

  it("stays silent when a tool is already connected", async () => {
    await installDesktop({ mcpServers: { artisign: { command: "x" } } });
    const d = make();
    await offerSetup("e", d);
    expect(d.ask).not.toHaveBeenCalled();
  });

  it("stays silent when no supported tool is installed", async () => {
    const d = make();
    await offerSetup("e", d);
    expect(d.ask).not.toHaveBeenCalled();
  });

  it("stays silent without a terminal and in CI", async () => {
    await installDesktop();
    for (const over of [{ isTTY: false }, { processEnv: { CI: "true" } }]) {
      const d = make(over);
      await offerSetup("e", d);
      expect(d.ask).not.toHaveBeenCalled();
    }
  });
});
