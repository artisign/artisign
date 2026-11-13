// @vitest-environment jsdom
//
// CHR-1048 — the Agent skill tab, the SKILL.md reader and the tab behaviour of the Connect AI tools dialog (CHR-926). The MCP tab itself is covered in settings-menu.dom.test.js.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";
import { createMcpDialog, stripFrontmatter } from "./mcp-dialog.js";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

const SKILL_TEXT = "---\nname: artisign\ndescription: How to design well.\n---\n\n# Designing with artisign\n\nTag **every** screen.\n";

const mcp = (name, found = true) => ({ name, found, connected: false, manual: { kind: "command", text: `add ${name}` } });
const SETUP = {
  command: "artisign setup",
  clients: [mcp("Claude Code"), mcp("Claude Desktop"), mcp("Cursor"), mcp("Codex CLI"), mcp("VS Code"), mcp("opencode", false)],
  skill: {
    command: "artisign setup --skill",
    content: SKILL_TEXT,
    clients: [
      { name: "Claude Code", status: "installed", path: "~/.claude/skills/artisign/SKILL.md" },
      { name: "Claude Desktop", status: "unsupported" },
      { name: "Cursor", status: "outdated", path: "~/.cursor/skills/artisign/SKILL.md" },
      { name: "Codex CLI", status: "missing", path: "~/.codex/skills/artisign/SKILL.md" },
      { name: "VS Code", status: "installed", path: "~/.vscode/skills/artisign/SKILL.md" },
      { name: "opencode", status: "installed", path: "~/.config/opencode/skills/artisign/SKILL.md" },
    ],
  },
};

let response;
let writeText;
let requests;
let dialog;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const key = (k, target = document.activeElement) => {
  const evt = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(evt);
  return evt;
};
const rows = () => $$("#skill-clients .mcp-client");
const chipTexts = () => rows().map((r) => r.querySelector(".mcp-status")?.textContent.replace(/^(check|update|warning)/, "") ?? null);

async function open(setup = SETUP) {
  response = setup;
  dialog.show();
  await flush();
}
const gotoSkill = () => $("#mcp-tab-skill").click();

// createMcpDialog registers a document-level keydown listener; drop the previous test's.
const nativeAdd = document.addEventListener.bind(document);
let docListeners = [];

beforeEach(() => {
  docListeners = [];
  document.addEventListener = (type, fn, opts) => {
    docListeners.push([type, fn, opts]);
    nativeAdd(type, fn, opts);
  };
  document.body.innerHTML = bodyHtml;
  requests = [];
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.stubGlobal("fetch", async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET" });
    if (!response) throw new Error("down");
    return { ok: true, status: 200, json: async () => response };
  });
  dialog = createMcpDialog({
    scrimEl: $("#mcp-scrim"),
    commandEl: $("#mcp-command"),
    clientsEl: $("#mcp-clients"),
    summaryEl: $("#mcp-summary"),
    closeEl: $("#mcp-close"),
    doneEl: $("#mcp-done"),
  });
});
afterEach(() => {
  for (const [type, fn, opts] of docListeners) document.removeEventListener(type, fn, opts);
  document.addEventListener = nativeAdd;
  vi.unstubAllGlobals();
});

describe("tabs", () => {
  it("opens on the MCP server tab and has tablist / tab / tabpanel semantics", async () => {
    await open();
    expect($(".mcp-tabs").getAttribute("role")).toBe("tablist");
    expect($$("[role=tab]").map((t) => [t.textContent, t.getAttribute("aria-selected")])).toEqual([["MCP server", "true"], ["Agent skill", "false"]]);
    expect($("#mcp-panel-mcp").hidden).toBe(false);
    expect($("#mcp-panel-skill").hidden).toBe(true);
    expect($("#mcp-tab-skill").getAttribute("aria-controls")).toBe("mcp-panel-skill");
  });

  it("switches by click and by arrow keys, with a roving tab stop", async () => {
    await open();
    gotoSkill();
    expect($("#mcp-panel-skill").hidden).toBe(false);
    expect($("#mcp-panel-mcp").hidden).toBe(true);
    expect($("#mcp-tab-skill").tabIndex).toBe(0);
    expect($("#mcp-tab-mcp").tabIndex).toBe(-1);
    $("#mcp-tab-mcp").click();
    $("#mcp-tab-mcp").focus();
    key("ArrowRight");
    expect($("#mcp-tab-skill").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe($("#mcp-tab-skill"));
    key("ArrowRight");
    expect($("#mcp-tab-mcp").getAttribute("aria-selected")).toBe("true");
    key("ArrowLeft");
    expect($("#mcp-tab-skill").getAttribute("aria-selected")).toBe("true");
    key("Home");
    expect($("#mcp-tab-mcp").getAttribute("aria-selected")).toBe("true");
    key("End");
    expect($("#mcp-tab-skill").getAttribute("aria-selected")).toBe("true");
  });

  it("opens on MCP server again after it was closed on the Agent skill tab", async () => {
    await open();
    gotoSkill();
    key("Escape");
    expect($("#mcp-scrim").hidden).toBe(true);
    dialog.show();
    expect($("#mcp-panel-mcp").hidden).toBe(false);
  });
});

describe("Agent skill tab", () => {
  it("shows the card, the install command, a chip per tool and the summary", async () => {
    await open();
    gotoSkill();
    expect($("#skill-card").textContent).toContain("artisign skill");
    expect($("#skill-card").textContent).toContain("Read SKILL.md");
    expect($("#skill-command .mcp-code-text").textContent).toBe("artisign setup --skill");
    expect(rows().map((r) => r.querySelector(".mcp-client-name").textContent)).toEqual(["Claude Code", "Claude Desktop", "Cursor", "Codex CLI", "VS Code", "opencode"]);
    // "Not found" (MCP part) wins over the skill status; M = found tools with a skills folder.
    expect(chipTexts()).toEqual(["Installed", null, "Outdated", "Not installed", "Installed", "Not found"]);
    expect(rows()[5].classList.contains("mcp-client--not-found")).toBe(true);
    expect($("#skill-summary").textContent).toBe("2 of 4 tools have the current skill");
    expect($("#skill-caption")).toBeNull();
    expect($("#skill-command .mcp-hint").textContent).toBe("Run in a terminal — it asks before installing into each tool; answer r to read SKILL.md first.");
    expect($("#skill-command .mcp-hint .mcp-path").textContent).toBe("r");
  });

  it("says All M tools when every tool has the current skill", async () => {
    const all = structuredClone(SETUP);
    all.skill.clients = all.skill.clients.map((c) => (c.status === "unsupported" ? c : { ...c, status: "installed" }));
    await open(all);
    gotoSkill();
    expect($("#skill-summary").textContent).toBe("All 4 tools have the current skill");
  });

  it("Claude Desktop has no chip and no buttons, only a muted note with a title; it stays out of M", async () => {
    await open();
    gotoSkill();
    const desktop = rows()[1];
    expect(desktop.querySelector(".mcp-status")).toBeNull();
    expect(desktop.querySelector("button")).toBeNull();
    const note = desktop.querySelector(".mcp-row-note");
    expect(note.textContent).toBe("Not supported yet");
    expect(note.title).toBe("Claude Desktop accepts skills only as a ZIP upload.");
    expect($("#skill-summary").textContent).toBe("2 of 4 tools have the current skill");
  });

  it("the reader's Download saves SKILL.md as a Blob and does not revoke the URL at once", async () => {
    await open();
    gotoSkill();
    $("#skill-card button").click();
    const createObjectURL = vi.fn(() => "blob:x");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    let saved;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
      saved = this.download;
    });
    $("#mcp-reader-download").click();
    expect(saved).toBe("SKILL.md");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled(); // revoked only after a delay
    const text = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(createObjectURL.mock.calls[0][0]);
    });
    expect(text).toBe(SKILL_TEXT);
    click.mockRestore();
  });

  it("copies the install command", async () => {
    await open();
    gotoSkill();
    $("#skill-command button").click();
    await flush();
    expect(writeText).toHaveBeenLastCalledWith("artisign setup --skill");
  });

  it("an unreadable skill is a warning chip whose error is reachable by keyboard, as the server sends it", async () => {
    const bad = structuredClone(SETUP);
    bad.skill.clients[0] = { name: "Claude Code", status: "unreadable", path: "~/.claude/skills/artisign/SKILL.md", error: "EACCES: permission denied, open '~/.claude/skills/artisign/SKILL.md'" };
    await open(bad);
    gotoSkill();
    const chip = rows()[0].querySelector(".mcp-status--unreadable");
    expect(chip.textContent).toBe("warningUnreadable");
    expect(chip.tabIndex).toBe(0);
    const described = document.getElementById(chip.getAttribute("aria-describedby"));
    expect(described.textContent).toBe("EACCES: permission denied, open '~/.claude/skills/artisign/SKILL.md'");
    expect(described.classList.contains("mcp-visually-hidden")).toBe(true);
    expect(chip.title).toBe(described.textContent);
    // counts as not installed
    expect($("#skill-summary").textContent).toBe("1 of 4 tools have the current skill");
  });

  it("without a skill field (older daemon) it says so, offers the command and no Read / Copy / Download", async () => {
    const older = { ...SETUP, skill: undefined };
    await open(older);
    gotoSkill();
    expect($("#skill-clients [role=status]").textContent).toContain("Could not read the skill status.");
    expect($("#skill-clients").textContent).toContain("artisign skill");
    expect($("#skill-command .mcp-code-text").textContent).toBe("artisign setup --skill");
    expect($$("#skill-card button")).toEqual([]);
    expect($$("#skill-clients button")).toEqual([]);
    expect($("#skill-summary").textContent).toBe("");
    // the MCP tab still works
    expect($$("#mcp-clients .mcp-client").length).toBe(6);
  });

  it("a failed request gives the same unavailable state; while loading it says Checking installed tools", async () => {
    response = null;
    dialog.show();
    gotoSkill();
    expect($("#skill-clients").textContent).toBe("Checking installed tools…");
    await flush();
    expect($("#skill-clients [role=status]")).not.toBeNull();
    expect($("#skill-command .mcp-code-text").textContent).toBe("artisign setup --skill");
  });

  it("never writes: every request is a GET", async () => {
    await open();
    gotoSkill();
    $("#skill-card button").click();
    $("#mcp-reader-copy").click();
    await flush();
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
});

describe("SKILL.md reader", () => {
  it("replaces the tabs, renders without the frontmatter, and Back returns to the tab", async () => {
    await open();
    gotoSkill();
    const read = $("#skill-card button");
    read.click();
    expect($("#mcp-main").hidden).toBe(true);
    expect($("#mcp-reader").hidden).toBe(false);
    expect($("#mcp-dialog").classList.contains("mcp-dialog--reader")).toBe(true);
    expect($("#mcp-dialog").getAttribute("aria-labelledby")).toBe("mcp-reader-title");
    const body = $("#mcp-reader-body");
    expect(body.tabIndex).toBe(0);
    expect(document.activeElement).toBe(body);
    expect(body.querySelector("h3").textContent).toBe("Designing with artisign");
    expect(body.querySelector("strong").textContent).toBe("every");
    expect(body.textContent).not.toContain("description: How to design well.");
    $("#mcp-reader-back").click();
    expect($("#mcp-main").hidden).toBe(false);
    expect($("#mcp-panel-skill").hidden).toBe(false);
    expect($("#mcp-dialog").classList.contains("mcp-dialog--reader")).toBe(false);
    expect(document.activeElement).toBe(read);
    read.click();
    $("#mcp-reader-done").click();
    expect($("#mcp-reader").hidden).toBe(true);
  });

  it("copies the whole file including the frontmatter and shows Copied for a moment", async () => {
    await open();
    gotoSkill();
    $("#skill-card button").click();
    $("#mcp-reader-copy").click();
    await flush();
    expect(writeText).toHaveBeenLastCalledWith(SKILL_TEXT);
    expect($("#mcp-reader-copy").textContent).toBe("Copied");
  });

  it("Esc closes the whole dialog from the reader; so does the close button", async () => {
    await open();
    gotoSkill();
    $("#skill-card button").click();
    key("Escape");
    expect($("#mcp-scrim").hidden).toBe(true);
    dialog.show();
    await flush();
    expect($("#mcp-reader").hidden).toBe(true);
    expect($("#mcp-main").hidden).toBe(false);
    gotoSkill();
    $("#skill-card button").click();
    $("#mcp-reader-close").click();
    expect($("#mcp-scrim").hidden).toBe(true);
  });
});

describe("stripFrontmatter", () => {
  it("removes a leading YAML block only", () => {
    expect(stripFrontmatter("---\nname: a\n---\n\n# T\n")).toBe("# T\n");
    expect(stripFrontmatter("---\r\nname: a\r\n---\r\n# T")).toBe("# T");
    expect(stripFrontmatter("# T\n\n---\nnot: yaml\n---\n")).toBe("# T\n\n---\nnot: yaml\n---\n");
    expect(stripFrontmatter("no frontmatter")).toBe("no frontmatter");
  });
});
