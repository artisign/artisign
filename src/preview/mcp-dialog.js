// "Connect AI tools" dialog (CHR-926): the `artisign setup` command, and per AI tool its status plus what to copy to connect it by hand. Statuses are read from GET /api/setup each time the dialog opens (the daemon looks at the disk then); nothing here writes a config. CHR-1272: a native modal <dialog> in the floating look (float-dialog.js): Escape, the scrim, the close and Done buttons close it, the browser traps Tab, focus goes back to the opener. State resets on close: the next open starts on the MCP tab with nothing of the last read left.
// CHR-1048: a second tab, "Agent skill", shows the artisign skill from the `skill` part of the same response: SKILL.md readable before installing (a reader step that swaps in for the tabs), the command that installs it, a status per tool, and copy / download of SKILL.md. Still copy-only: the download is a client-side Blob.

import { fetchSetup } from "./api.js";
import { isShown } from "./menu-keys.js";
import { copyWithLabel, createCodeField } from "./clipboard.js";
import { createModal } from "./float-dialog.js";
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

/** The status chip of a row (design `chrome-status-chip`): `key` picks the look, `icon` the optional glyph before the label. @param {string} key @param {string} label @param {string} [iconName] */
function statusChip(key, label, iconName) {
  const chip = el("span", `status-chip status-chip--${key}`);
  if (iconName) chip.appendChild(icon(iconName));
  chip.append(label);
  return chip;
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
 * @param {{ dialogEl: HTMLDialogElement, commandEl: HTMLElement, clientsEl: HTMLElement, summaryEl: HTMLElement, closeEl: HTMLElement, doneEl: HTMLElement, fallbackFocusEl?: HTMLElement }} els `fallbackFocusEl`: where focus goes on close when the opener is gone or hidden
 * @returns {{ show: () => void, hide: () => void, isOpen: () => boolean }}
 */
export function createMcpDialog({ dialogEl, commandEl, clientsEl, summaryEl, closeEl, doneEl, fallbackFocusEl }) {
  const $ = (selector) => /** @type {HTMLElement} */ (dialogEl.querySelector(selector));
  const mainEl = $("#mcp-main");
  const readerEl = $("#mcp-reader");
  const readerBodyEl = $("#mcp-reader-body");
  const skillCardEl = $("#skill-card");
  const skillCommandEl = $("#skill-command");
  const skillClientsEl = $("#skill-clients");
  const tabs = [
    { key: "mcp", tab: $("#mcp-tab-mcp"), panel: $("#mcp-panel-mcp") },
    { key: "skill", tab: $("#mcp-tab-skill"), panel: $("#mcp-panel-skill") },
  ];
  let loadToken = 0;
  /** @type {HTMLElement | null} */
  let readButton = null;
  let skillContent = "";
  let activeTab = "mcp";
  /** The footer line per tab; the footer shows the selected tab's. @type {Record<string, { text: string, icon?: string }>} */
  const summaries = { mcp: { text: "" }, skill: { text: "" } };

  /** The footer's live region only changes when what it says changes: switching tabs or a re-read with the same answer announces nothing twice. */
  function renderSummary() {
    const { text, icon: iconName } = summaries[activeTab];
    const key = `${iconName ?? ""}|${text}`;
    if (summaryEl.dataset.key === key) return;
    summaryEl.dataset.key = key;
    summaryEl.replaceChildren(...(iconName && text ? [icon(iconName), text] : text ? [text] : []));
  }

  /** @param {string} key @param {boolean} [focus] */
  function selectTab(key, focus = false) {
    activeTab = key;
    for (const t of tabs) {
      const on = t.key === key;
      t.tab.setAttribute("aria-selected", String(on));
      t.tab.tabIndex = on ? 0 : -1;
      t.panel.hidden = !on;
      if (on && focus) t.tab.focus();
    }
    renderSummary();
  }

  /** The reader replaces the tabs inside the same modal; `open` false returns to the Agent skill tab. @param {boolean} open @param {boolean} [moveFocus] false when the dialog is only being reset before it opens: focus must stay where the opener had it */
  function showReader(open, moveFocus = true) {
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
      if (moveFocus) (readButton && isShown(readButton) ? readButton : tabs[1].tab).focus();
    }
  }

  /** @param {string} label @param {() => void} onClick */
  function actionButton(label, onClick) {
    const button = el("button", "dialog-btn", label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }

  function renderCommand(command) {
    commandEl.replaceChildren(createCodeField(command, { label: `Copy ${command}` }), el("p", "float-dialog-hint", "Run it in a terminal. It connects every AI tool it finds."));
  }

  /** @param {{ name: string, found: boolean, connected: boolean, manual: { kind: "command" | "config", path?: string, text: string } }} client @param {number} index @param {boolean} open whether the row starts expanded */
  function clientRow(client, index, open) {
    const status = statusOf(client);
    const row = el("li", `status-row${status.key === "not-found" ? " status-row--muted" : ""}`);
    const head = el(status.key === "connected" ? "div" : "button", "status-row-head");
    head.append(icon(CLIENT_ICONS[client.name] ?? "terminal"), el("span", "status-row-name", client.name), statusChip(status.key, status.label, status.key === "connected" ? "check" : undefined));
    row.appendChild(head);
    if (status.key === "connected") {
      head.appendChild(el("span", "status-row-end")); // keeps the chips of every row in one column
      return row;
    }
    // Only a tool that is not connected has something to copy; the first one that is installed starts open, the rest stay collapsed until asked.
    const panelId = `mcp-manual-${index}`;
    const chevron = icon("expand_more");
    chevron.classList.add("status-row-end");
    head.appendChild(chevron);
    head.type = "button";
    head.setAttribute("aria-controls", panelId);
    const panel = el("div", "status-row-detail");
    panel.id = panelId;
    const hint = el("span", "status-row-hint");
    const { manual } = client;
    if (manual.kind === "command") hint.textContent = "Run in a terminal:";
    else if (manual.path) hint.append("Add this to ", el("span", "mcp-path", manual.path), ":");
    else hint.textContent = "Add this config:";
    panel.append(hint, createCodeField(manual.text, { variant: "block", label: `Copy ${client.name} setup` }));
    const setOpen = (value) => {
      panel.hidden = !value;
      row.classList.toggle("is-open", value);
      head.setAttribute("aria-expanded", String(value));
      chevron.textContent = value ? "expand_less" : "expand_more";
    };
    setOpen(open);
    head.addEventListener("click", () => setOpen(panel.hidden));
    row.appendChild(panel);
    return row;
  }

  /** Names the key to type (`r`) in the code font, as the design does. */
  function skillHint() {
    const hint = el("p", "float-dialog-hint");
    hint.append("Run it in a terminal. It asks before installing into each tool; answer ", el("kbd", "mcp-key", "r"), " to read SKILL.md first.");
    return hint;
  }

  /** @param {string} text */
  function noteBox(text) {
    return el("p", "float-dialog-hint", text);
  }

  /** The Agent skill tab while the status is read (`setup` undefined) or cannot be shown (`setup` null: failed request or an older daemon without `skill`). @param {Awaited<ReturnType<typeof fetchSetup>> | null | undefined} setup */
  function renderSkill(setup) {
    const skill = setup?.skill ?? null;
    skillContent = skill?.content ?? "";
    const iconBox = el("span", "skill-card-icon");
    iconBox.appendChild(icon("description"));
    const text = el("div", "skill-card-text");
    text.append(el("span", "skill-card-name", "artisign skill"), el("span", "skill-card-desc", "Teaches your AI tools artisign's conventions: tag every screen, use screen variants, design system first."));
    readButton = null;
    skillCardEl.replaceChildren(iconBox, text);
    if (skill) {
      readButton = actionButton("Read SKILL.md", () => showReader(true));
      skillCardEl.appendChild(readButton);
    }
    skillCommandEl.replaceChildren(createCodeField(skill?.command ?? FALLBACK_SKILL_COMMAND, { label: `Copy ${skill?.command ?? FALLBACK_SKILL_COMMAND}` }), skillHint());
    summaries.skill = { text: "" };
    if (setup === undefined) {
      skillClientsEl.replaceChildren(noteBox("Checking installed tools…"));
    } else if (!skill) {
      const box = el("div", "status-note");
      box.setAttribute("role", "status");
      const noteText = el("div", "status-note-text");
      const sub = el("span", "status-note-body");
      sub.append("The command above still works. To read SKILL.md first, run ", el("span", "mcp-path", "artisign skill"), " in a terminal.");
      noteText.append(el("span", "status-note-title", "Could not read the skill status."), sub);
      box.append(icon("info"), noteText);
      skillClientsEl.replaceChildren(box);
    } else {
      const list = el("ul", "status-list");
      let found = 0;
      let installed = 0;
      skill.clients.forEach((client, index) => {
        // "Not found" comes from the MCP part of the response and wins over the skill status.
        const notFound = setup.clients.find((c) => c.name === client.name)?.found === false;
        // A tool without a skills folder (status "unsupported", Claude Desktop) gets no row.
        if (client.status === "unsupported") return;
        if (!notFound) {
          found++;
          if (client.status === "installed") installed++;
        }
        list.appendChild(skillRow(client, notFound, index));
      });
      skillClientsEl.replaceChildren(list);
      if (found > 0) {
        const all = installed === found;
        summaries.skill = { text: all ? (found === 1 ? "The tool has the current skill" : `All ${found} tools have the current skill`) : `${installed} of ${found} tool${found === 1 ? "" : "s"} ${found === 1 ? "has" : "have"} the current skill`, icon: all ? "check_circle" : undefined };
      }
    }
    renderSummary();
  }

  /** @param {import("./api.js").SkillClient} client @param {boolean} notFound @param {number} index */
  function skillRow(client, notFound, index) {
    const key = notFound ? "not-found" : client.status === "missing" ? "skill-missing" : client.status;
    const row = el("li", `status-row${notFound ? " status-row--muted" : ""}`);
    const head = el("div", "status-row-head");
    head.append(icon(CLIENT_ICONS[client.name] ?? "terminal"), el("span", "status-row-name", client.name));
    const chipSpec = SKILL_CHIPS[key] ?? SKILL_CHIPS["skill-missing"];
    const chip = statusChip(key, chipSpec.label, chipSpec.icon);
    head.appendChild(chip);
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
      head.append(hidden);
    }
    head.appendChild(el("span", "status-row-end"));
    row.appendChild(head);
    return row;
  }

  async function load() {
    const token = ++loadToken;
    renderCommand(FALLBACK_COMMAND);
    clientsEl.replaceChildren(noteBox("Checking installed tools…"));
    summaries.mcp = { text: "" };
    renderSkill(undefined);
    const setup = await fetchSetup();
    if (token !== loadToken) return;
    renderSkill(setup);
    if (!setup) {
      clientsEl.replaceChildren(noteBox("Could not read the tool status. The command above still works."));
      return;
    }
    renderCommand(setup.command);
    const firstOpen = setup.clients.findIndex((c) => !c.connected && c.found);
    clientsEl.replaceChildren(...setup.clients.map((client, index) => clientRow(client, index, index === firstOpen)));
    summaries.mcp = { text: `${setup.clients.filter((c) => c.connected).length} of ${setup.clients.length} connected` };
    renderSummary();
  }

  // Whatever way the dialog closes, the next open starts clean: the MCP tab, no reader, nothing of the last read.
  const modal = createModal(dialogEl, {
    fallbackFocusEl,
    onClosed: () => {
      loadToken++;
      skillContent = "";
      readButton = null;
      readerBodyEl.replaceChildren();
      commandEl.replaceChildren();
      clientsEl.replaceChildren();
      skillCardEl.replaceChildren();
      skillCommandEl.replaceChildren();
      skillClientsEl.replaceChildren();
      summaries.mcp = { text: "" };
      summaries.skill = { text: "" };
      renderSummary();
    },
  });

  function show() {
    if (modal.isOpen()) return;
    showReader(false, false);
    selectTab("mcp");
    modal.show();
    void load();
  }

  closeEl.addEventListener("click", () => modal.hide());
  doneEl.addEventListener("click", () => modal.hide());
  $("#mcp-reader-close").addEventListener("click", () => modal.hide());
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

  return { show, hide: modal.hide, isOpen: modal.isOpen };
}
