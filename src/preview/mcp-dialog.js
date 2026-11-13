// "Connect AI tools" dialog (CHR-926): the `artisign setup` command, and per AI tool its status plus what to copy to connect it by hand. Statuses are read from GET /api/setup each time the dialog opens (the daemon looks at the disk then); nothing here writes a config. Same modal conventions as the shortcut reference: Escape, scrim click, the close and Done buttons close it, Tab is trapped, focus goes back to the opener.
// CHR-1048: a second tab, "Agent skill", shows the artisign skill from the `skill` part of the same response: SKILL.md readable before installing (a reader step that swaps in for the tabs), the command that installs it, a status per tool, and copy / download of SKILL.md for Claude Desktop. Still copy-only: the download is a client-side Blob.

import { fetchSetup } from "./api.js";
import { isShown, trapFocus } from "./menu-keys.js";
import { copyWithFeedback, copyWithLabel } from "./clipboard.js";
import { setMarkdown } from "./markdown.js";

const CLIENT_ICONS = { "Claude Code": "terminal", "Claude Desktop": "desktop_windows", Cursor: "ads_click", "Codex CLI": "terminal", "VS Code": "code", opencode: "terminal" };
const FALLBACK_COMMAND = "artisign setup";
const FALLBACK_SKILL_COMMAND = "artisign setup --skill";
const SKILL_FILE_NAME = "SKILL.md";
const SKILL_CHIPS = {
  installed: { label: "Installed", icon: "check" },
  outdated: { label: "Outdated", icon: "update" },
  unreadable: { label: "Unreadable", icon: "warning" },
  "skill-missing": { label: "Not installed" },
  "not-found": { label: "Not found" },
};

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {string} name */
function icon(name) {
  const node = el("span", "icon", name);
  node.setAttribute("aria-hidden", "true");
  return node;
}

/**
 * A read-only code box with a copy button (feedback and failure handling: clipboard.js).
 *
 * @param {string} text
 * @param {"line" | "block"} kind
 * @param {string} label accessible name of the copy button
 */
function codeField(text, kind, label) {
  const field = el("div", `mcp-code mcp-code--${kind}`);
  const code = el("code", "mcp-code-text", text);
  const copy = el("button", "chrome-icon-btn chrome-icon-btn--sm");
  copy.type = "button";
  copy.setAttribute("aria-label", label);
  copy.dataset.tooltip = "Copy";
  const glyph = icon("content_copy");
  copy.appendChild(glyph);
  copy.addEventListener("click", () => copyWithFeedback(text, glyph));
  field.append(code, copy);
  return field;
}

/** @param {{ found: boolean, connected: boolean }} client */
function statusOf(client) {
  if (client.connected) return { key: "connected", label: "Connected" };
  return client.found ? { key: "not-connected", label: "Not connected" } : { key: "not-found", label: "Not found" };
}

/** SKILL.md without its leading YAML frontmatter, for the reader (copy and download keep the whole file). @param {string} content */
export function stripFrontmatter(content) {
  return content.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").replace(/^\s+/, "");
}

/** Saves `text` as `name` through a temporary Blob link; nothing leaves the browser. @param {string} name @param {string} text */
function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const link = el("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param {{ scrimEl: HTMLElement, commandEl: HTMLElement, clientsEl: HTMLElement, summaryEl: HTMLElement, closeEl: HTMLElement, doneEl: HTMLElement, fallbackFocusEl?: HTMLElement }} els `fallbackFocusEl`: where focus goes on close when the opener is gone or hidden
 * @returns {{ show: () => void, hide: () => void, isOpen: () => boolean }}
 */
export function createMcpDialog({ scrimEl, commandEl, clientsEl, summaryEl, closeEl, doneEl, fallbackFocusEl }) {
  const dialogEl = /** @type {HTMLElement} */ (scrimEl.querySelector("#mcp-dialog"));
  const $ = (selector) => /** @type {HTMLElement} */ (dialogEl.querySelector(selector));
  const mainEl = $("#mcp-main");
  const readerEl = $("#mcp-reader");
  const readerBodyEl = $("#mcp-reader-body");
  const skillCardEl = $("#skill-card");
  const skillCommandEl = $("#skill-command");
  const skillClientsEl = $("#skill-clients");
  const skillSummaryEl = $("#skill-summary");
  const tabs = [
    { key: "mcp", tab: $("#mcp-tab-mcp"), panel: $("#mcp-panel-mcp") },
    { key: "skill", tab: $("#mcp-tab-skill"), panel: $("#mcp-panel-skill") },
  ];
  /** @type {Element | null} */
  let returnFocusTo = null;
  let loadToken = 0;
  /** @type {HTMLElement | null} */
  let readButton = null;
  let skillContent = "";

  /** @param {string} key @param {boolean} [focus] */
  function selectTab(key, focus = false) {
    for (const t of tabs) {
      const on = t.key === key;
      t.tab.setAttribute("aria-selected", String(on));
      t.tab.tabIndex = on ? 0 : -1;
      t.panel.hidden = !on;
      if (on && focus) t.tab.focus();
    }
  }

  /** The reader replaces the tabs inside the same modal; `open` false returns to the Agent skill tab. @param {boolean} open */
  function showReader(open) {
    mainEl.hidden = open;
    readerEl.hidden = !open;
    dialogEl.classList.toggle("mcp-dialog--reader", open);
    dialogEl.setAttribute("aria-labelledby", open ? "mcp-reader-title" : "mcp-title");
    if (open) {
      setMarkdown(readerBodyEl, stripFrontmatter(skillContent));
      readerBodyEl.scrollTop = 0;
      readerBodyEl.focus();
    } else {
      readerBodyEl.replaceChildren();
      (readButton && isShown(readButton) ? readButton : tabs[1].tab).focus();
    }
  }

  /** @param {string} label @param {() => void} onClick */
  function compactButton(label, onClick) {
    const button = el("button", "chrome-btn chrome-btn--compact", label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }

  function renderCommand(command) {
    commandEl.replaceChildren(codeField(command, "line", `Copy ${command}`), el("div", "mcp-hint", "Run in a terminal — it connects every tool it finds."));
  }

  /** @param {{ name: string, found: boolean, connected: boolean, manual: { kind: "command" | "config", path?: string, text: string } }} client @param {number} index */
  function clientRow(client, index) {
    const status = statusOf(client);
    const wrap = el("div", `mcp-client mcp-client--${status.key}`);
    const head = el(status.key === "connected" ? "div" : "button", "mcp-client-row");
    head.append(icon(CLIENT_ICONS[client.name] ?? "terminal"), el("span", "mcp-client-name", client.name), el("span", "mcp-client-spacer"));
    const chip = el("span", `mcp-status mcp-status--${status.key}`);
    if (status.key === "connected") chip.appendChild(icon("check"));
    chip.append(status.label);
    head.appendChild(chip);
    wrap.appendChild(head);
    if (status.key === "connected") {
      head.appendChild(el("span", "mcp-chevron-slot")); // keeps the chips of every row in one column
      return wrap;
    }
    // Only a tool that is not connected has something to copy; not-installed ones stay collapsed until asked.
    const panelId = `mcp-manual-${index}`;
    const chevron = icon("expand_more");
    chevron.classList.add("mcp-chevron");
    head.appendChild(chevron);
    head.type = "button";
    head.setAttribute("aria-controls", panelId);
    const panel = el("div", "mcp-manual");
    panel.id = panelId;
    const hint = el("div", "mcp-hint mcp-hint--small");
    const { manual } = client;
    if (manual.kind === "command") hint.textContent = "Run in a terminal:";
    else if (manual.path) hint.append("Add this to ", el("span", "mcp-path", manual.path), ":");
    else hint.textContent = "Add this config:";
    panel.append(hint, codeField(manual.text, "block", `Copy ${client.name} setup`));
    const setOpen = (open) => {
      panel.hidden = !open;
      head.setAttribute("aria-expanded", String(open));
      chevron.textContent = open ? "expand_less" : "expand_more";
    };
    setOpen(status.key === "not-connected");
    head.addEventListener("click", () => setOpen(panel.hidden));
    wrap.appendChild(panel);
    return wrap;
  }

  /** Names the key to type (`r`) in the code font, as the design does. */
  function skillHint() {
    const hint = el("div", "mcp-hint mcp-hint--base");
    hint.append("Run in a terminal — it asks before installing into each tool; answer ", el("span", "mcp-path", "r"), " to read SKILL.md first.");
    return hint;
  }

  /** @param {string} text */
  function noteBox(text) {
    return el("div", "mcp-note", text);
  }

  /** The Agent skill tab while the status is read (`setup` undefined) or cannot be shown (`setup` null: failed request or an older daemon without `skill`). @param {Awaited<ReturnType<typeof fetchSetup>> | null | undefined} setup */
  function renderSkill(setup) {
    const skill = setup?.skill ?? null;
    skillContent = skill?.content ?? "";
    const head = el("div", "mcp-card-head");
    head.append(icon("description"), el("span", "mcp-card-name", "artisign skill"));
    readButton = null;
    if (skill) {
      readButton = compactButton("Read SKILL.md", () => showReader(true));
      head.appendChild(readButton);
    }
    skillCardEl.replaceChildren(head, el("div", "mcp-card-desc", "Teaches your AI tools artisign's conventions: tag every screen, use screen variants, design system first."));
    skillCommandEl.replaceChildren(
      codeField(skill?.command ?? FALLBACK_SKILL_COMMAND, "line", `Copy ${skill?.command ?? FALLBACK_SKILL_COMMAND}`),
      skillHint(),
    );
    skillSummaryEl.textContent = "";
    if (setup === undefined) {
      skillClientsEl.replaceChildren(noteBox("Checking installed tools…"));
      return;
    }
    if (!skill) {
      const box = el("div", "mcp-note-box");
      box.setAttribute("role", "status");
      const text = el("div", "mcp-note-box-text");
      const sub = el("span", "mcp-note-box-sub");
      sub.append("The command above still works. To read SKILL.md first, run ", el("span", "mcp-path", "artisign skill"), " in a terminal.");
      text.append(el("span", "", "Could not read the skill status."), sub);
      box.append(icon("info"), text);
      skillClientsEl.replaceChildren(box);
      return;
    }
    const list = el("div", "mcp-clients");
    let found = 0;
    let installed = 0;
    skill.clients.forEach((client, index) => {
      // "Not found" comes from the MCP part of the response and wins over the skill status.
      const notFound = setup.clients.find((c) => c.name === client.name)?.found === false;
      const unsupported = client.status === "unsupported";
      if (!notFound && !unsupported) {
        found++;
        if (client.status === "installed") installed++;
      }
      list.appendChild(skillRow(client, notFound, unsupported, skill.content, index));
    });
    skillClientsEl.replaceChildren(list);
    if (found > 0) {
      skillSummaryEl.textContent = installed === found ? (found === 1 ? "The tool has the current skill" : `All ${found} tools have the current skill`) : `${installed} of ${found} tool${found === 1 ? "" : "s"} ${found === 1 ? "has" : "have"} the current skill`;
    }
  }

  /** @param {import("./api.js").SkillClient} client @param {boolean} notFound @param {boolean} unsupported @param {string} content @param {number} index */
  function skillRow(client, notFound, unsupported, content, index) {
    const key = notFound ? "not-found" : client.status === "missing" ? "skill-missing" : client.status;
    const wrap = el("div", `mcp-client${notFound ? " mcp-client--not-found" : ""}`);
    const row = el("div", "mcp-client-row");
    row.append(icon(CLIENT_ICONS[client.name] ?? "terminal"), el("span", "mcp-client-name", client.name), el("span", "mcp-client-spacer"));
    wrap.appendChild(row);
    if (unsupported && !notFound) {
      // Claude Desktop has no skills folder and takes skills only as a ZIP upload: not a status of the skill, so plain text, not a chip.
      const note = el("span", "mcp-row-note", "Not supported yet");
      note.title = "Claude Desktop accepts skills only as a ZIP upload.";
      row.appendChild(note);
      return wrap;
    }
    const chipSpec = SKILL_CHIPS[key] ?? SKILL_CHIPS["skill-missing"];
    const chip = el("span", `mcp-status mcp-status--${key}`);
    if (chipSpec.icon) chip.appendChild(icon(chipSpec.icon));
    chip.append(chipSpec.label);
    if (key === "unreadable" && client.error) {
      // The error text is reachable by keyboard: the chip is focusable and described by a visually hidden copy; hover shows the title.
      const message = client.error;
      const describedBy = `mcp-skill-error-${index}`;
      const hidden = el("span", "mcp-visually-hidden", message);
      hidden.id = describedBy;
      chip.tabIndex = 0;
      chip.setAttribute("role", "note");
      chip.setAttribute("aria-describedby", describedBy);
      chip.title = message;
      row.append(chip, hidden);
      return wrap;
    }
    row.appendChild(chip);
    return wrap;
  }

  async function load() {
    const token = ++loadToken;
    renderCommand(FALLBACK_COMMAND);
    clientsEl.replaceChildren(el("div", "mcp-note", "Checking installed tools…"));
    summaryEl.textContent = "";
    renderSkill(undefined);
    const setup = await fetchSetup();
    if (token !== loadToken) return;
    renderSkill(setup);
    if (!setup) {
      clientsEl.replaceChildren(el("div", "mcp-note", "Could not read the tool status. The command above still works."));
      return;
    }
    renderCommand(setup.command);
    clientsEl.replaceChildren(...setup.clients.map(clientRow));
    summaryEl.textContent = `${setup.clients.filter((c) => c.connected).length} of ${setup.clients.length} connected`;
  }

  function isOpen() {
    return !scrimEl.hidden;
  }

  function show() {
    if (isOpen()) return;
    returnFocusTo = document.activeElement;
    showReader(false);
    selectTab("mcp");
    scrimEl.hidden = false;
    dialogEl.focus();
    void load();
  }

  function hide() {
    if (!isOpen()) return;
    loadToken++;
    scrimEl.hidden = true;
    (returnFocusTo instanceof HTMLElement && isShown(returnFocusTo) ? returnFocusTo : (fallbackFocusEl ?? document.body)).focus();
    returnFocusTo = null;
  }

  closeEl.addEventListener("click", hide);
  doneEl.addEventListener("click", hide);
  $("#skill-done").addEventListener("click", hide);
  $("#mcp-reader-close").addEventListener("click", hide);
  $("#mcp-reader-back").addEventListener("click", () => showReader(false));
  $("#mcp-reader-done").addEventListener("click", () => showReader(false));
  $("#mcp-reader-copy").addEventListener("click", function () {
    void copyWithLabel(skillContent, this);
  });
  $("#mcp-reader-download").addEventListener("click", () => downloadText(SKILL_FILE_NAME, skillContent));
  for (const { key, tab } of tabs) tab.addEventListener("click", () => selectTab(key));
  $(".mcp-tabs").addEventListener("keydown", (evt) => {
    if (evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey) return;
    const current = tabs.findIndex((t) => t.tab === evt.target);
    if (current === -1) return;
    let next;
    if (evt.key === "ArrowRight") next = (current + 1) % tabs.length;
    else if (evt.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    else if (evt.key === "Home") next = 0;
    else if (evt.key === "End") next = tabs.length - 1;
    else return;
    evt.preventDefault();
    selectTab(tabs[next].key, true);
  });
  scrimEl.addEventListener("click", (evt) => {
    if (evt.target === scrimEl) hide();
  });
  document.addEventListener("keydown", (evt) => {
    if (!isOpen()) return;
    trapFocus(evt, dialogEl);
    if (evt.key === "Escape") {
      evt.preventDefault();
      evt.stopImmediatePropagation();
      hide();
    }
  });

  return { show, hide, isOpen };
}
