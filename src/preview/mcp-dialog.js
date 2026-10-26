// "Connect AI tools" dialog (CHR-926): the `artisign setup` command, and per AI tool its status plus what to copy to connect it by hand. Statuses are read from GET /api/setup each time the dialog opens (the daemon looks at the disk then); nothing here writes a config. Same modal conventions as the shortcut reference: Escape, scrim click, the close and Done buttons close it, Tab is trapped, focus goes back to the opener.

import { fetchSetup } from "./api.js";
import { isShown, trapFocus } from "./menu-keys.js";

const CLIENT_ICONS = { "Claude Code": "terminal", "Claude Desktop": "desktop_windows", Cursor: "ads_click", "Codex CLI": "terminal", "VS Code": "code", opencode: "terminal" };
const FALLBACK_COMMAND = "artisign setup";
/** How long a copy button shows its check mark. */
const COPIED_MS = 1500;

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
 * A read-only code box with a copy button; the icon turns into a check for a moment. A clipboard that is missing or refuses is tolerated (nothing happens).
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
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    glyph.textContent = "check";
    setTimeout(() => {
      glyph.textContent = "content_copy";
    }, COPIED_MS);
  });
  field.append(code, copy);
  return field;
}

/** @param {{ found: boolean, connected: boolean }} client */
function statusOf(client) {
  if (client.connected) return { key: "connected", label: "Connected" };
  return client.found ? { key: "not-connected", label: "Not connected" } : { key: "not-installed", label: "Not installed" };
}

/**
 * @param {{ scrimEl: HTMLElement, commandEl: HTMLElement, clientsEl: HTMLElement, summaryEl: HTMLElement, closeEl: HTMLElement, doneEl: HTMLElement, fallbackFocusEl?: HTMLElement }} els `fallbackFocusEl`: where focus goes on close when the opener is gone or hidden
 * @returns {{ show: () => void, hide: () => void, isOpen: () => boolean }}
 */
export function createMcpDialog({ scrimEl, commandEl, clientsEl, summaryEl, closeEl, doneEl, fallbackFocusEl }) {
  const dialogEl = /** @type {HTMLElement} */ (scrimEl.querySelector("#mcp-dialog"));
  /** @type {Element | null} */
  let returnFocusTo = null;
  let loadToken = 0;

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

  async function load() {
    const token = ++loadToken;
    renderCommand(FALLBACK_COMMAND);
    clientsEl.replaceChildren(el("div", "mcp-note", "Checking installed tools…"));
    summaryEl.textContent = "";
    const setup = await fetchSetup();
    if (token !== loadToken) return;
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
