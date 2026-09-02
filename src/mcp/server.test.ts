import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { PLAYWRIGHT_MISSING_MESSAGE } from "../tools/browser.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setupProject, type ProjectFixture } from "../tools/test-fixtures.js";
import { createMcpServer } from "./server.js";
import { TOOLS } from "../tools/index.js";
import { __setPlaywrightImportForTests, __resetBrowserForTests } from "../tools/browser.js";
import { INSTRUCTIONS } from "./instructions.js";

/**
 * Exercises the MCP server the same way Claude Desktop (stdio) or Claude
 * Code would: list the tools, then call each one. This is the closest a
 * unit test gets to the "Claude Desktop and Claude Code list and
 * successfully call every tool" acceptance criterion — an in-process MCP
 * client/server pair over the SDK's InMemoryTransport, exercising the real
 * protocol (schema validation, JSON-RPC framing) without a real subprocess.
 */
describe("MCP server — protocol-level", () => {
  let fx: ProjectFixture;
  let client: Client;

  beforeEach(async () => {
    fx = await setupProject();

    const server = createMcpServer(fx.store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await fx.cleanup();
  });

  // The version an MCP client displays. It lived as a second, hand-maintained
  // copy next to package.json and would have been left behind by the next
  // release; this pins the two together so a bump cannot silently miss one.
  it("reports the installed package version to the client", async () => {
    const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
    expect(client.getServerVersion()).toMatchObject({ name: "artisign", version });
  });

  it("lists all 23 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(tools).toHaveLength(23);
  });

  it("successfully calls every one of the 21 tools that don't need a browser (get_screenshot/inspect_node excluded)", async () => {
    async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name} returned an error: ${JSON.stringify(result.content)}`).not.toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      return JSON.parse(content[0]!.text) as Record<string, unknown>;
    }

    // init_project targets its own fresh directory (it scaffolds a project
    // from scratch), so it can't share `fx`'s already-initialized one.
    const initDir = await mkdtemp(join(tmpdir(), "artisign-mcp-init-"));
    try {
      await call("init_project", { dir: initDir, seed: { kind: "empty" } });
    } finally {
      await rm(initDir, { recursive: true, force: true });
    }

    // Lifecycle / writes first, to build up state the reads then inspect.
    await call("write_html", {
      screen: "home",
      mode: "create",
      title: "Home",
      html_aug: `<section id="n1" style="color: #3366ff"><button id="n2" data-flow-target="checkout">Go</button></section>`,
    });

    await call("patch_html", {
      target: { kind: "node", node: "home.n2" },
      operation: "set_attr",
      attr: { name: "data-testid", value: "cta" },
    });

    await call("update_refs", { node: "home.n1", refs: { token_refs: { color: null } } });

    await call("set_tokens", { tokens: { "color.primary": "#3366ff" }, mode: "patch" });

    await call("set_flow", { node: "home.n2", flow: { from: "home.n2", event: "tap", to: "checkout", to_kind: "screen" } });

    await call("set_meta", { target: { kind: "screen", screen: "home" }, notes: "hero copy still placeholder", tags: ["wip"] });

    await call("import_html", { source: { kind: "html", html_aug: `<div id="n1">Imported</div>`, screen: "imported" } });

    await call("promote_to_system", { node: "home.n2", kind: "component", name: "btn-primary" });

    await call("write_html", {
      screen: "card-grid",
      mode: "create",
      kind: "pattern",
      html_aug: `<div id="p1"><div id="p2">Card</div></div>`,
    });
    await call("delete_entity", { kind: "pattern", name: "card-grid" });

    await call("write_mockup", { mockup: "hero-options", variant: "a", mode: "create", html: `<div>Option A</div>` });
    await call("promote_mockup", { mockup: "hero-options", variant: "a", screen: "hero-a" });
    await call("delete_entity", { kind: "mockup", name: "hero-options" });

    await fx.store.appendComment(
      JSON.stringify({ id: "cmt_x1", parent_id: null, screen: "home", node_id: "home.n1", author: "human", text: "hi", resolved: false, ts: new Date().toISOString() }),
    );
    await call("reply_comment", { comment_id: "cmt_x1", body: "on it" });

    // Reads.
    await call("get_project", {});
    await call("get_screen", { screen: "home" });
    await call("get_node", { node: "home.n1" });
    await call("get_design_system", {});
    await call("find_nodes", { where: [{ kind: "has_flow" }] });
    await call("list_comments", { status: "any" });
    await call("get_guide", {});

    // A second mockup for the get_mockup smoke call (the first was already
    // deleted above by the delete_entity smoke call).
    await call("write_mockup", { mockup: "hero-options-2", variant: "a", mode: "create", html: `<div>Option A</div>` });
    await call("get_mockup", { mockup: "hero-options-2" });
  });

  it("surfaces a not_found tool error as an MCP tool-level error, not a protocol crash", async () => {
    const result = await client.callTool({ name: "get_screen", arguments: { screen: "does-not-exist" } });
    expect(result.isError).toBe(true);
  });

  it("advertises the augmentation-grammar instructions to the connected client", () => {
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
  });

  // The remedy is only worth anything if it survives the trip to the
  // agent. The tool-level tests cover the ToolError itself; this one covers
  // what a connected client actually reads out of the response.
  it("hands the agent the playwright install remedy as the tool error message", async () => {
    await fx.store.writeScreen("home", `<div id="n1"></div>`);
    // `browserPromise` is module-level: a browser cached by any earlier test
    // would short-circuit the launch and silently bypass this mock.
    await __resetBrowserForTests();
    __setPlaywrightImportForTests(() => Promise.reject(new Error("Cannot find module 'playwright'")));
    try {
      const result = await client.callTool({ name: "get_screenshot", arguments: { screen: "home" } });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0]!.text)).toEqual({
        code: "io_error",
        message: PLAYWRIGHT_MISSING_MESSAGE,
      });
    } finally {
      __setPlaywrightImportForTests(undefined);
      await __resetBrowserForTests();
    }
  });
});

describe("MCP server — instructions budget", () => {
  // The WORKFLOW block raised the budget from 600 to 750 — still a cheat
  // sheet, not the methodology guide itself (that's get_guide's
  // docs/agent-guide.md). Later dropping the get_guide mandate from that
  // block left the text further below the ceiling; the ceiling stays
  // where it is because it guards against the instructions growing into a
  // manual, not against anyone editing them. The MOCKUPS block (~4 lines)
  // raised the budget from 750 to 850 for the same reason WORKFLOW did — a
  // new, genuinely separate workflow the cheat sheet has to name, not scope
  // creep on an existing block. One line added to the COMPONENT INSTANCE
  // block (ceiling 850 → 870): styling a data-slot element is silently
  // discarded, and the slot syntax it traps sits right there. The
  // write_html warning is the primary teacher; this line is what an agent
  // sees before it makes the mistake, since get_guide is optional.
  it("stays within the ~870 token cheat-sheet budget (chars/4 heuristic)", () => {
    expect(INSTRUCTIONS.length / 4).toBeLessThanOrEqual(870);
  });
});
