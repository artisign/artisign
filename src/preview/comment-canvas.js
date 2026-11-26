// CHR-1248 — comments on the canvas: one numbered pin per thread on its
// anchored element, a popover with the thread next to it, comment mode's
// hover outline and new-thread flow, re-anchoring, and the floating canvas
// toolbar (Select, Comment, Show resolved, Hide pins).
//
// Everything here is an editor overlay in the PARENT document (#comment-layer
// inside #canvas, in the canvas's scrolled content coordinates). The screen
// iframe's document is only measured and listened to, never written to —
// render determinism: no pin, outline or popover can leak into stored screen
// HTML or a get_screen response.
//
// The module owns no data fetching: app.js hands it the screen's comments
// (GET /api/comments, events already applied server-side) and the actions
// that post to the daemon.

import { icon } from "./icons.js";

const PIN_SIZE = 24;
const POPOVER_GAP = 14;
const DETACHED_STEP = 30;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in comment-canvas.test.js)
// ---------------------------------------------------------------------------

/**
 * Thread number per thread id: 1-based, in the order the threads were started
 * on this screen. Resolved and detached threads keep their number, so "#3"
 * means the same thread whether or not resolved pins are shown.
 * @param {{ id: string }[]} threads in log order
 * @returns {Map<string, number>}
 */
export function numberThreads(threads) {
  return new Map(threads.map((t, i) => [t.id, i + 1]));
}

/**
 * The threads that get a pin: open ones, plus resolved ones when "Show
 * resolved" is on; none at all while "Hide pins" is on.
 * @template {{ status: "open" | "resolved" }} T
 * @param {T[]} threads
 * @param {{ showResolved: boolean, hidePins: boolean }} opts
 * @returns {T[]}
 */
export function pinnedThreads(threads, { showResolved, hidePins }) {
  if (hidePins) return [];
  return threads.filter((t) => t.status === "open" || showResolved);
}

/**
 * Where the popover goes: to the right of the anchored element, flipped to
 * the left when there is no room, then below, then above. The cross axis is
 * clamped into the visible area.
 * @param {{ left: number, top: number, right: number, bottom: number }} anchor element box
 * @param {{ width: number, height: number }} size popover size
 * @param {{ left: number, top: number, right: number, bottom: number }} view visible area
 * @param {number} [gap]
 * @returns {{ left: number, top: number, side: "right" | "left" | "below" | "above" }}
 */
export function placePopover(anchor, size, view, gap = POPOVER_GAP) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const y = clamp(anchor.top - 8, view.top + 8, view.bottom - size.height - 8);
  if (anchor.right + gap + size.width <= view.right) return { left: anchor.right + gap, top: y, side: "right" };
  if (anchor.left - gap - size.width >= view.left) return { left: anchor.left - gap - size.width, top: y, side: "left" };
  const x = clamp(anchor.left, view.left + 8, view.right - size.width - 8);
  if (anchor.bottom + gap + size.height <= view.bottom) return { left: x, top: anchor.bottom + gap, side: "below" };
  return { left: x, top: Math.max(view.top + 8, anchor.top - gap - size.height), side: "above" };
}

/**
 * Short relative time: "now", "5m", "2h", "3d", then a short date.
 * @param {string | undefined} ts ISO timestamp
 * @param {number} [now]
 * @returns {string}
 */
export function relativeTime(ts, now = Date.now()) {
  const at = ts ? Date.parse(ts) : Number.NaN;
  if (Number.isNaN(at)) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The @-mention being typed at the caret, if any: an "@" at the start or
 * after whitespace, followed by name characters up to the caret.
 * @param {string} text
 * @param {number} caret
 * @returns {{ start: number, query: string } | null}
 */
export function mentionAt(text, caret) {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([\w.-]*)$/.exec(before);
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2] };
}

/**
 * The name a message shows: the agent's name, "Agent" for an agent line
 * without one, "You" for the human (the browser is always the human).
 * @param {{ author: "human" | "agent", agent?: string }} record
 * @returns {string}
 */
export function authorLabel(record) {
  if (record.author === "agent") return record.agent || "Agent";
  return "You";
}

/**
 * The Context sidebar's count row (CHR-1253).
 * @param {{ status: "open" | "resolved", detached: boolean }[]} threads
 * @returns {{ label: string, open: number, detached: number }}
 */
export function countRow(threads) {
  const open = threads.filter((t) => t.status === "open");
  const detached = open.filter((t) => t.detached).length;
  if (open.length === 0) return { label: "No open comments", open: 0, detached: 0 };
  return { label: open.length === 1 ? "1 open comment" : `${open.length} open comments`, open: open.length, detached };
}

/**
 * The element a comment-mode click or hover anchors to: the element itself
 * when it has an authored id, else its nearest ancestor with one. The
 * screen root stands for the whole screen (`id: null`). Nothing inside an
 * inert backdrop layer (CHR-940) is a target — the layer is anonymous and
 * pointer-events:none, so a real click lands on the root anyway.
 * @param {Document} doc
 * @param {EventTarget | null} target
 * @returns {{ el: Element, id: string | null } | null}
 */
export function commentTarget(doc, target) {
  const start = /** @type {Element | null} */ (target && typeof (/** @type {Element} */ (target).closest) === "function" ? target : null);
  if (!start) return null;
  const layer = start.closest("[data-backdrop-layer]");
  const el = (layer ? layer.parentElement : start)?.closest("[id]") ?? null;
  if (!el) return null;
  return { el, id: el === doc.body.firstElementChild ? null : el.id };
}

/**
 * Roving-tabindex fallback for a horizontal toolbar where `focusgroup` is
 * unsupported: one item in the tab order, arrow keys (reversed in RTL),
 * Home/End, wrapping at the ends.
 * @param {HTMLElement} toolbar
 * @param {HTMLElement[]} items
 */
function installRovingTabindex(toolbar, items) {
  items.forEach((b, i) => (b.tabIndex = i ? -1 : 0));
  toolbar.addEventListener("focusin", (evt) => {
    const target = /** @type {HTMLElement} */ (evt.target);
    if (items.includes(target)) items.forEach((b) => (b.tabIndex = b === target ? 0 : -1));
  });
  toolbar.addEventListener("keydown", (evt) => {
    const rtl = getComputedStyle(toolbar).direction === "rtl";
    const steps = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 };
    const current = items.indexOf(/** @type {HTMLElement} */ (evt.target));
    if (current === -1) return;
    let next;
    if (evt.key === "Home") next = 0;
    else if (evt.key === "End") next = items.length - 1;
    else if (evt.key in steps) next = (current + steps[/** @type {"ArrowRight" | "ArrowLeft"} */ (evt.key)] + items.length) % items.length;
    else return;
    evt.preventDefault();
    items[next].focus();
  });
}

/** @param {string | null} ref `<screen>.<node-id>` or null */
function bareId(ref) {
  if (ref === null) return null;
  const dot = ref.indexOf(".");
  return dot === -1 ? ref : ref.slice(dot + 1);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, node_id: string | null, author: "human" | "agent", agent?: string, status: "open" | "resolved", detached: boolean, reply_count: number }} ThreadInfo
 * @typedef {{ id: string, node_id: string | null, text: string, author: "human" | "agent", agent?: string, parent_id: string | null, resolved: boolean, ts: string }} CommentRecord
 * @typedef {{ ok: true } | { ok: false, message: string }} ActionResult
 * @typedef {{
 *   setMode: (on: boolean) => void,
 *   create: (nodeId: string | null, text: string) => Promise<ActionResult>,
 *   reply: (rootId: string, text: string) => Promise<ActionResult>,
 *   resolve: (rootId: string) => Promise<ActionResult>,
 *   reopen: (rootId: string) => Promise<ActionResult>,
 *   remove: (rootId: string) => Promise<ActionResult>,
 *   reanchor: (rootId: string, domId: string) => Promise<ActionResult>,
 *   copy?: (text: string) => void,
 * }} CanvasActions
 */

/**
 * @param {{
 *   canvasEl: HTMLElement,
 *   holderEl: HTMLElement,
 *   layerEl: HTMLElement,
 *   toolbarEl: HTMLElement,
 *   bannerEl: HTMLElement,
 *   getDoc: () => Document | null,
 *   actions: CanvasActions,
 *   prefs?: { showResolved: boolean, hidePins: boolean },
 *   onPrefsChange?: (prefs: { showResolved: boolean, hidePins: boolean }) => void,
 * }} opts
 */
export function createCommentCanvas({ canvasEl, holderEl, layerEl, toolbarEl, bannerEl, getDoc, actions, prefs, onPrefsChange }) {
  /** @type {string | null} */
  let screen = null;
  /** @type {CommentRecord[]} */
  let comments = [];
  /** @type {ThreadInfo[]} */
  let threads = [];
  let modeOn = false;
  let showResolved = prefs?.showResolved ?? false;
  let hidePins = prefs?.hidePins ?? false;
  /** @type {string | null} the open thread's id, or "new" for a new thread */
  let activeId = null;
  /** @type {string | null | undefined} the new thread's DOM id (null = screen level) */
  let newTarget;
  /** @type {string | null} thread waiting for the element to re-anchor to */
  let reanchorFor = null;
  /** @type {Element | null} */
  let hoverEl = null;
  let busy = false;
  let errorText = "";
  let menuOpen = false;
  let confirmDelete = false;
  /** @type {Document | null} */
  let attachedDoc = null;
  let detachDoc = () => {};

  // Layer parts. The popover is kept across re-renders so a reply being typed survives an SSE refresh.
  layerEl.replaceChildren();
  const outlineEl = div("comment-target-outline");
  const hoverOutlineEl = div("comment-hover-outline");
  const pinsEl = div("comment-pins");
  // A native non-modal <dialog>, opened with show(): it must stay out of the top layer to scroll with the canvas next to its element.
  const popoverEl = document.createElement("dialog");
  popoverEl.className = "comment-popover";
  outlineEl.hidden = true;
  hoverOutlineEl.hidden = true;
  layerEl.append(outlineEl, hoverOutlineEl, pinsEl, popoverEl);

  const popHeader = div("comment-popover-header");
  const popAlert = div("comment-popover-alert");
  const popMessages = document.createElement("ol");
  popMessages.className = "comment-popover-messages";
  const popComposer = document.createElement("form");
  popComposer.className = "comment-popover-composer";
  const textarea = document.createElement("textarea");
  textarea.className = "chrome-field comment-popover-input";
  textarea.rows = 1;
  textarea.setAttribute("aria-label", "Reply");
  const sendBtn = document.createElement("button");
  sendBtn.type = "submit";
  sendBtn.className = "comment-popover-send";
  sendBtn.setAttribute("aria-label", "Send");
  sendBtn.append(icon("send"));
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "chrome-btn chrome-btn--compact comment-popover-cancel";
  cancelBtn.textContent = "Cancel";
  const composerRow = div("comment-popover-composer-row");
  composerRow.append(textarea, sendBtn);
  const mentionList = document.createElement("ul");
  mentionList.className = "comment-mention-list";
  mentionList.setAttribute("role", "listbox");
  mentionList.setAttribute("aria-label", "Mention an agent");
  mentionList.hidden = true;
  const popError = document.createElement("p");
  popError.className = "comment-popover-error";
  popError.setAttribute("aria-live", "assertive"); // not role=alert: the element exists while hidden, and one live region is enough
  const popHint = document.createElement("p");
  popHint.className = "comment-popover-hint";
  popHint.textContent = "Enter to send · Shift+Enter for a new line";
  const popFoot = div("comment-popover-foot");
  popFoot.append(popHint, cancelBtn);
  popComposer.append(composerRow, mentionList, popError, popFoot);
  const menuEl = document.createElement("div");
  menuEl.className = "chrome-menu comment-popover-menu";
  menuEl.setAttribute("role", "menu");
  menuEl.hidden = true;
  popoverEl.append(popHeader, popAlert, popMessages, popComposer, menuEl);

  // Toolbar.
  toolbarEl.replaceChildren();
  toolbarEl.setAttribute("role", "toolbar");
  toolbarEl.setAttribute("aria-label", "Canvas tools");
  const selectBtn = toolBtn("arrow_selector_tool", "Select", "comment-tool-select");
  const commentBtn = toolBtn("chat_bubble", "Comment (C)", "comment-tool-comment");
  const divider = document.createElement("span");
  divider.className = "comment-toolbar-divider";
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  const resolvedBtn = textBtn("Show resolved", "comment-tool-resolved");
  const hideBtn = textBtn("Hide pins", "comment-tool-hide");
  toolbarEl.append(selectBtn, commentBtn, divider, resolvedBtn, hideBtn);
  // One tab stop: the browser's focusgroup where supported, else a roving tabindex with the arrow keys.
  toolbarEl.setAttribute("focusgroup", "toolbar wrap");
  if (!("focusGroup" in HTMLElement.prototype)) installRovingTabindex(toolbarEl, [selectBtn, commentBtn, resolvedBtn, hideBtn]);
  selectBtn.addEventListener("click", () => actions.setMode(false));
  commentBtn.addEventListener("click", () => actions.setMode(true));
  resolvedBtn.addEventListener("click", () => {
    showResolved = !showResolved;
    onPrefsChange?.({ showResolved, hidePins });
    render();
  });
  hideBtn.addEventListener("click", () => {
    hidePins = !hidePins;
    if (hidePins && activeId !== null && activeId !== "new") close(false);
    onPrefsChange?.({ showResolved, hidePins });
    render();
  });

  // Popover wiring.
  popComposer.addEventListener("submit", (evt) => {
    evt.preventDefault();
    void submit();
  });
  cancelBtn.addEventListener("click", () => close(true));
  textarea.addEventListener("input", () => {
    autosize();
    renderMentions();
  });
  textarea.addEventListener("keydown", (evt) => {
    if (!mentionList.hidden && handleMentionKey(evt)) return;
    if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) {
      evt.preventDefault();
      void submit();
    }
  });
  popoverEl.addEventListener("keydown", (evt) => {
    if (evt.key !== "Escape") return;
    // Esc is the popover's own: never leaves comment mode on the way out.
    evt.preventDefault();
    evt.stopPropagation();
    if (!mentionList.hidden) mentionList.hidden = true;
    else if (menuOpen) setMenu(false);
    else close(true);
  });
  const onOutsidePress = (evt) => {
    if (activeId === null) return;
    const target = /** @type {Node} */ (evt.target);
    if (popoverEl.contains(target) || pinsEl.contains(target) || toolbarEl.contains(target)) return;
    close(false);
  };
  document.addEventListener("pointerdown", onOutsidePress, true);

  // ---------------------------------------------------------------------------

  function div(className) {
    const el = document.createElement("div");
    el.className = className;
    return el;
  }

  function toolBtn(iconName, label, id) {
    const b = document.createElement("button");
    b.type = "button";
    b.id = id;
    b.className = "chrome-icon-btn comment-toolbar-btn";
    b.setAttribute("aria-label", label);
    b.dataset.tooltip = label;
    b.setAttribute("aria-pressed", "false");
    b.append(icon(iconName));
    return b;
  }

  function textBtn(label, id) {
    const b = document.createElement("button");
    b.type = "button";
    b.id = id;
    b.className = "comment-toolbar-text";
    b.setAttribute("aria-pressed", "false");
    b.append(icon("check", "comment-toolbar-check"), label);
    return b;
  }

  /** The screen frame's placement inside #canvas's content box: left/top offset and zoom. */
  function metrics() {
    const scale = Number.parseFloat(holderEl.style.getPropertyValue("--zoom")) || 1;
    return {
      left: Number.parseFloat(holderEl.style.left) || 0,
      top: Number.parseFloat(holderEl.style.top) || 0,
      width: (Number.parseFloat(holderEl.style.width) || holderEl.offsetWidth) * scale,
      height: (Number.parseFloat(holderEl.style.height) || holderEl.offsetHeight) * scale,
      scale,
    };
  }

  /** @param {string | null} domId @returns {{ left: number, top: number, right: number, bottom: number } | null} */
  function boxFor(domId) {
    const m = metrics();
    if (domId === null) return { left: m.left, top: m.top, right: m.left + m.width, bottom: m.top + m.height };
    const el = getDoc()?.getElementById(domId);
    if (!el) return null;
    return boxOfElement(el);
  }

  /** @param {Element} el */
  function boxOfElement(el) {
    const m = metrics();
    const r = el.getBoundingClientRect();
    return { left: m.left + r.left * m.scale, top: m.top + r.top * m.scale, right: m.left + r.right * m.scale, bottom: m.top + r.bottom * m.scale };
  }

  function thread(id) {
    return threads.find((t) => t.id === id) ?? null;
  }

  function threadLabel(t) {
    const number = numberThreads(threads).get(t.id);
    const target = bareId(t.node_id) ?? "screen";
    return `Comment ${number} on ${target}${t.detached ? ", detached" : ""}${t.status === "resolved" ? ", resolved" : ""}`;
  }

  // ---------------------------------------------------------------------------
  // Rendering

  function render() {
    renderToolbar();
    renderBanner();
    renderPins();
    renderOutline();
    renderPopover();
    renderHover();
  }

  function renderToolbar() {
    selectBtn.setAttribute("aria-pressed", String(!modeOn));
    commentBtn.setAttribute("aria-pressed", String(modeOn));
    resolvedBtn.setAttribute("aria-pressed", String(showResolved));
    hideBtn.setAttribute("aria-pressed", String(hidePins));
  }

  function renderBanner() {
    bannerEl.replaceChildren();
    if (reanchorFor !== null) {
      const number = numberThreads(threads).get(reanchorFor);
      bannerEl.append(icon("my_location"), `Click the element to move #${number} to`, kbd("Esc"), muted("cancels"));
      bannerEl.hidden = false;
    } else if (modeOn) {
      bannerEl.append(icon("chat_bubble"), "Comment mode — click an element to start a thread", kbd("Esc"), muted("to exit"));
      bannerEl.hidden = false;
    } else {
      bannerEl.hidden = true;
    }
  }

  function kbd(text) {
    const k = document.createElement("kbd");
    k.textContent = text;
    return k;
  }

  function muted(text) {
    const s = document.createElement("span");
    s.className = "comment-banner-muted";
    s.textContent = text;
    return s;
  }

  function renderPins() {
    const focusedId = pinsEl.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset.thread : undefined;
    pinsEl.replaceChildren();
    const numbers = numberThreads(threads);
    const m = metrics();
    const perElement = new Map();
    let detachedIndex = 0;
    for (const t of pinnedThreads(threads, { showResolved, hidePins })) {
      let x;
      let y;
      if (!t.detached) {
        const domId = bareId(t.node_id);
        const box = boxFor(domId);
        if (!box) continue; // not in this document (yet): the next layout() places it
        const key = domId ?? "";
        const index = perElement.get(key) ?? 0;
        perElement.set(key, index + 1);
        x = box.right - index * (PIN_SIZE - 4);
        y = box.top;
      } else {
        x = m.left;
        y = m.top + detachedIndex * DETACHED_STEP;
        detachedIndex += 1;
      }
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "comment-pin";
      pin.dataset.thread = t.id;
      pin.dataset.kind = t.author;
      pin.dataset.state = t.status === "resolved" ? "resolved" : t.detached ? "detached" : "open";
      if (t.id === activeId) pin.dataset.active = "true";
      pin.setAttribute("aria-label", threadLabel(t));
      pin.setAttribute("aria-expanded", String(t.id === activeId));
      pin.style.left = `${x - PIN_SIZE / 2}px`;
      pin.style.top = `${y - PIN_SIZE / 2}px`;
      if (t.status === "resolved") pin.append(icon("check"));
      else pin.textContent = String(numbers.get(t.id));
      pin.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (activeId === t.id) close(true);
        else open(t.id);
      });
      pinsEl.append(pin);
    }
    if (focusedId) pinFor(focusedId)?.focus();
  }

  function renderOutline() {
    let box = null;
    if (activeId === "new" && newTarget !== undefined) box = boxFor(newTarget);
    else if (activeId !== null && activeId !== "new") {
      const t = thread(activeId);
      if (t && !t.detached && !hidePins) box = boxFor(bareId(t.node_id));
      if (t) outlineEl.dataset.kind = t.author;
    }
    if (activeId === "new") outlineEl.dataset.kind = "human";
    setBox(outlineEl, box);
  }

  function setBox(el, box, label) {
    if (!box) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${Math.max(0, box.right - box.left)}px`;
    el.style.height = `${Math.max(0, box.bottom - box.top)}px`;
    if (label === undefined) delete el.dataset.label;
    else el.dataset.label = label;
  }

  function renderPopover() {
    if (activeId === null) {
      if (popoverEl.open) popoverEl.close();
      return;
    }
    const isNew = activeId === "new";
    const t = isNew ? null : thread(activeId);
    if (!isNew && !t) {
      close(false);
      return;
    }
    if (!popoverEl.open) popoverEl.show();
    popoverEl.dataset.mode = isNew ? "new" : "thread";
    popoverEl.setAttribute("aria-label", isNew ? `New comment on ${newTarget ?? "screen"}` : threadLabel(/** @type {ThreadInfo} */ (t)));

    // Header.
    popHeader.replaceChildren();
    const title = document.createElement("b");
    title.textContent = isNew ? "New thread" : `#${numberThreads(threads).get(/** @type {ThreadInfo} */ (t).id)}`;
    const node = document.createElement("code");
    node.className = "comment-popover-node";
    node.textContent = isNew ? (newTarget ?? "screen") : (bareId(/** @type {ThreadInfo} */ (t).node_id) ?? "screen");
    popHeader.append(title, node);
    if (t?.detached) {
      node.classList.add("is-detached");
      const badge = document.createElement("span");
      badge.className = "comment-badge comment-badge--detached";
      badge.textContent = "Detached";
      popHeader.append(badge);
    }
    if (t?.status === "resolved") {
      const badge = document.createElement("span");
      badge.className = "comment-badge comment-badge--resolved";
      badge.textContent = "Resolved";
      popHeader.append(badge);
    }
    const spacer = div("comment-popover-spacer");
    popHeader.append(spacer);
    if (t) {
      const resolved = t.status === "resolved";
      const statusBtn = headerBtn(resolved ? "undo" : "check", resolved ? "Reopen" : "Resolve");
      statusBtn.addEventListener("click", () => void run(() => (resolved ? actions.reopen(t.id) : actions.resolve(t.id)), !resolved));
      const moreBtn = headerBtn("more_horiz", "More actions");
      moreBtn.setAttribute("aria-haspopup", "menu");
      moreBtn.setAttribute("aria-expanded", String(menuOpen));
      moreBtn.addEventListener("click", () => setMenu(!menuOpen));
      const closeBtn = headerBtn("close", "Close");
      closeBtn.addEventListener("click", () => close(true));
      popHeader.append(statusBtn, moreBtn, closeBtn);
    } else {
      const discard = headerBtn("close", "Discard");
      discard.addEventListener("click", () => close(true));
      popHeader.append(discard);
    }

    // Detached alert.
    popAlert.replaceChildren();
    popAlert.hidden = !t?.detached;
    if (t?.detached) {
      const text = document.createElement("p");
      text.textContent = `${bareId(t.node_id)} no longer exists on this screen. Move the thread to the element that replaced it, or resolve it.`;
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "chrome-btn chrome-btn--primary chrome-btn--compact";
      pick.textContent = "Pick element";
      pick.addEventListener("click", () => startReanchor(t.id));
      popAlert.append(icon("warning"), text, pick);
    }

    // Messages.
    popMessages.replaceChildren();
    popMessages.hidden = isNew;
    if (t) {
      const records = comments.filter((c) => c.id === t.id || c.parent_id === t.id);
      for (const record of records) popMessages.append(renderMessage(record));
    }

    // Composer.
    textarea.placeholder = isNew ? "Write a comment, @ to mention an agent" : "Reply, @ to mention an agent";
    textarea.setAttribute("aria-label", isNew ? "Comment" : "Reply");
    sendBtn.hidden = isNew;
    cancelBtn.hidden = !isNew;
    popFoot.classList.toggle("is-new", isNew);
    popHint.textContent = isNew ? "Enter to send" : "Enter to send · Shift+Enter for a new line";
    if (isNew) {
      cancelBtn.after(submitButtonForNew());
    } else {
      popFoot.querySelector(".comment-popover-post")?.remove();
    }
    popError.textContent = errorText;
    popError.hidden = errorText === "";
    sendBtn.disabled = busy;

    // Menu.
    renderMenu(t);
    placeNow();
  }

  function submitButtonForNew() {
    const existing = popFoot.querySelector(".comment-popover-post");
    if (existing) {
      /** @type {HTMLButtonElement} */ (existing).disabled = busy;
      return existing;
    }
    const post = document.createElement("button");
    post.type = "submit";
    post.className = "chrome-btn chrome-btn--primary chrome-btn--compact comment-popover-post";
    post.textContent = "Comment";
    post.disabled = busy;
    return post;
  }

  function headerBtn(iconName, label) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chrome-icon-btn chrome-icon-btn--sm";
    b.setAttribute("aria-label", label);
    b.dataset.tooltip = label;
    b.append(icon(iconName));
    return b;
  }

  /** @param {CommentRecord} record */
  function renderMessage(record) {
    const li = document.createElement("li");
    li.className = "comment-message";
    const meta = div("comment-message-meta");
    const avatar = document.createElement("span");
    avatar.className = "comment-avatar";
    avatar.dataset.kind = record.author;
    avatar.setAttribute("aria-hidden", "true");
    const name = authorLabel(record);
    avatar.textContent = name.slice(0, 2).toUpperCase();
    const who = document.createElement("b");
    who.textContent = name;
    const badge = document.createElement("span");
    badge.className = `comment-badge comment-badge--${record.author}`;
    badge.textContent = record.author === "agent" ? "Agent" : "Human";
    const time = document.createElement("time");
    time.dateTime = record.ts;
    time.title = record.ts;
    time.textContent = relativeTime(record.ts);
    meta.append(avatar, who, badge, time);
    const body = div("comment-message-body");
    body.textContent = record.text;
    li.append(meta, body);
    return li;
  }

  /** @param {ThreadInfo | null} t */
  function renderMenu(t) {
    menuEl.replaceChildren();
    menuEl.hidden = !menuOpen || !t;
    if (!t) return;
    const item = (iconName, label, onClick, danger = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `chrome-menu-item${danger ? " is-danger" : ""}`;
      b.setAttribute("role", "menuitem");
      b.append(icon(iconName), label);
      b.addEventListener("click", onClick);
      menuEl.append(b);
      return b;
    };
    item("my_location", "Re-anchor to element…", () => startReanchor(t.id));
    if (t.node_id) {
      item("content_copy", "Copy node ref", () => {
        actions.copy?.(/** @type {string} */ (t.node_id));
        setMenu(false);
      });
    }
    item("delete", confirmDelete ? "Click again to delete" : "Delete thread", () => {
      if (!confirmDelete) {
        confirmDelete = true;
        renderMenu(t);
        return;
      }
      void run(() => actions.remove(t.id), true);
    }, true);
  }

  function setMenu(on) {
    menuOpen = on;
    confirmDelete = false;
    renderPopover();
    if (on) /** @type {HTMLElement | null} */ (menuEl.querySelector("button"))?.focus();
  }

  /** Places the popover next to its element (or its pin, for a detached thread) inside the visible canvas area. */
  function placeNow() {
    if (!popoverEl.open) return;
    let anchor = null;
    if (activeId === "new") anchor = newTarget === undefined ? null : boxFor(newTarget);
    else {
      const t = thread(/** @type {string} */ (activeId));
      if (t && !t.detached) anchor = boxFor(bareId(t.node_id));
      if (!anchor) {
        const pin = pinFor(/** @type {string} */ (activeId));
        if (pin) {
          const x = Number.parseFloat(pin.style.left) || 0;
          const y = Number.parseFloat(pin.style.top) || 0;
          anchor = { left: x, top: y, right: x + PIN_SIZE, bottom: y + PIN_SIZE };
        }
      }
    }
    if (!anchor) {
      const m = metrics();
      anchor = { left: m.left, top: m.top, right: m.left, bottom: m.top };
    }
    const view = {
      left: canvasEl.scrollLeft,
      top: canvasEl.scrollTop,
      right: canvasEl.scrollLeft + canvasEl.clientWidth,
      bottom: canvasEl.scrollTop + canvasEl.clientHeight,
    };
    const size = { width: popoverEl.offsetWidth || 320, height: popoverEl.offsetHeight || 200 };
    const place = placePopover(anchor, size, view);
    popoverEl.style.left = `${place.left}px`;
    popoverEl.style.top = `${place.top}px`;
    popoverEl.dataset.side = place.side;
  }

  function pinFor(id) {
    return /** @type {HTMLElement | null} */ (pinsEl.querySelector(`.comment-pin[data-thread="${CSS.escape(id)}"]`));
  }

  function autosize() {
    textarea.style.height = "auto";
    if (textarea.scrollHeight) textarea.style.height = `${Math.min(160, textarea.scrollHeight)}px`;
  }

  // ---------------------------------------------------------------------------
  // @-mentions

  function knownAgents() {
    const names = new Set(["ux-agent"]);
    for (const c of comments) if (c.agent) names.add(c.agent);
    return [...names].sort();
  }

  let mentionIndex = 0;
  function renderMentions() {
    const at = mentionAt(textarea.value, textarea.selectionStart ?? textarea.value.length);
    const options = at ? knownAgents().filter((n) => n.toLowerCase().startsWith(at.query.toLowerCase())) : [];
    mentionList.replaceChildren();
    mentionList.hidden = options.length === 0;
    if (options.length === 0) return;
    mentionIndex = Math.min(mentionIndex, options.length - 1);
    options.forEach((name, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === mentionIndex));
      li.className = "comment-mention";
      li.dataset.name = name;
      const avatar = document.createElement("span");
      avatar.className = "comment-avatar";
      avatar.dataset.kind = "agent";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = name.slice(0, 2).toUpperCase();
      const badge = document.createElement("span");
      badge.className = "comment-badge comment-badge--agent";
      badge.textContent = "Agent";
      li.append(avatar, name, badge);
      li.addEventListener("pointerdown", (evt) => {
        evt.preventDefault();
        insertMention(name);
      });
      mentionList.append(li);
    });
  }

  /** @param {KeyboardEvent} evt @returns {boolean} consumed */
  function handleMentionKey(evt) {
    const options = [...mentionList.querySelectorAll(".comment-mention")];
    if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
      evt.preventDefault();
      mentionIndex = (mentionIndex + (evt.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
      renderMentions();
      return true;
    }
    if (evt.key === "Enter" || evt.key === "Tab") {
      evt.preventDefault();
      insertMention(/** @type {HTMLElement} */ (options[mentionIndex]).dataset.name ?? "");
      return true;
    }
    return false;
  }

  function insertMention(name) {
    const caret = textarea.selectionStart ?? textarea.value.length;
    const at = mentionAt(textarea.value, caret);
    if (!at) return;
    textarea.value = `${textarea.value.slice(0, at.start)}@${name} ${textarea.value.slice(caret)}`;
    const pos = at.start + name.length + 2;
    textarea.setSelectionRange(pos, pos);
    mentionList.hidden = true;
    mentionIndex = 0;
    textarea.focus();
  }

  // ---------------------------------------------------------------------------
  // Actions

  async function submit() {
    const text = textarea.value.trim();
    if (!text || busy || activeId === null) return;
    const result = await run(() => (activeId === "new" ? actions.create(newTarget ?? null, text) : actions.reply(/** @type {string} */ (activeId), text)), activeId === "new");
    if (result.ok) {
      textarea.value = "";
      autosize();
      if (activeId !== null) textarea.focus();
    }
  }

  /**
   * Runs one daemon action with the popover's busy/error state.
   * @param {() => Promise<ActionResult>} fn
   * @param {boolean} closeAfter
   */
  async function run(fn, closeAfter) {
    busy = true;
    errorText = "";
    renderPopover();
    const result = await fn();
    busy = false;
    if (result.ok) {
      menuOpen = false;
      confirmDelete = false;
      if (closeAfter) close(true);
    } else {
      errorText = result.message;
    }
    if (activeId !== null) renderPopover();
    return result;
  }

  function startReanchor(id) {
    reanchorFor = id;
    menuOpen = false;
    const back = id;
    close(false);
    reanchorFor = back;
    render();
  }

  // ---------------------------------------------------------------------------
  // Open / close

  function open(id) {
    if (activeId !== id) {
      textarea.value = "";
      errorText = "";
    }
    activeId = id;
    newTarget = undefined;
    menuOpen = false;
    confirmDelete = false;
    reanchorFor = null;
    render();
    textarea.focus();
  }

  /** @param {string | null} domId */
  function startNew(domId) {
    activeId = "new";
    newTarget = domId;
    textarea.value = "";
    errorText = "";
    menuOpen = false;
    render();
    textarea.focus();
  }

  /** @param {boolean} returnFocus */
  function close(returnFocus) {
    const was = activeId;
    activeId = null;
    newTarget = undefined;
    menuOpen = false;
    confirmDelete = false;
    errorText = "";
    mentionList.hidden = true;
    render();
    if (!returnFocus) return;
    // Back to the thread's pin; after a resolve or delete that pin is gone, so the first pin (or the Comment tool) takes focus instead.
    const target = (was && was !== "new" ? pinFor(was) : null) ?? /** @type {HTMLElement | null} */ (pinsEl.querySelector(".comment-pin")) ?? commentBtn;
    target.focus();
  }

  // ---------------------------------------------------------------------------
  // The screen document: hover outline, new-thread and re-anchor clicks

  /** @param {Document | null} doc the freshly loaded screen document */
  function attachDoc(doc) {
    detachDoc();
    attachedDoc = doc;
    hoverEl = null;
    if (!doc) {
      detachDoc = () => {};
      return;
    }
    const onMove = (evt) => {
      if (!modeOn && reanchorFor === null) return;
      const hit = commentTarget(doc, evt.target);
      hoverEl = hit?.el ?? null;
      renderHover();
    };
    const onLeave = () => {
      hoverEl = null;
      renderHover();
    };
    const onClick = (evt) => {
      if (!modeOn && reanchorFor === null) return;
      const hit = commentTarget(doc, evt.target);
      evt.preventDefault();
      evt.stopPropagation();
      if (!hit) return;
      if (reanchorFor !== null) {
        if (hit.id === null) return; // a thread re-anchors to an element, never back to the screen
        const id = reanchorFor;
        reanchorFor = null;
        hoverEl = null;
        render();
        void actions.reanchor(id, hit.id).then((result) => {
          if (result.ok) open(id);
          else {
            open(id);
            errorText = result.message;
            renderPopover();
          }
        });
        return;
      }
      startNew(hit.id);
    };
    const onPress = (evt) => {
      if (modeOn || reanchorFor !== null) return;
      onOutsidePress(evt);
    };
    // Fonts and images settle after load: re-measure when the screen's own layout moves.
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => api.layout()) : null;
    if (resizeObserver && doc.body) resizeObserver.observe(doc.body);
    doc.addEventListener("pointermove", onMove, true);
    doc.addEventListener("pointerleave", onLeave);
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("pointerdown", onPress, true);
    detachDoc = () => {
      resizeObserver?.disconnect();
      doc.removeEventListener("pointermove", onMove, true);
      doc.removeEventListener("pointerleave", onLeave);
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("pointerdown", onPress, true);
    };
  }

  function renderHover() {
    if ((!modeOn && reanchorFor === null) || !hoverEl || !attachedDoc) {
      hoverOutlineEl.hidden = true;
      return;
    }
    const root = attachedDoc.body.firstElementChild;
    setBox(hoverOutlineEl, boxOfElement(hoverEl), hoverEl === root ? "screen" : hoverEl.id);
  }

  render();

  const api = {
    /**
     * New data for the shown screen. A screen switch closes the popover; a
     * refresh of the same screen keeps it (and the text being typed).
     * @param {{ screen: string | null, comments: CommentRecord[], threads: ThreadInfo[] }} data
     */
    setData(data) {
      if (data.screen !== screen) {
        activeId = null;
        newTarget = undefined;
        reanchorFor = null;
        textarea.value = "";
      }
      screen = data.screen;
      comments = data.comments;
      threads = data.threads;
      render();
    },
    /** Comment mode on/off (the top-bar toggle, C, the toolbar). Leaving it cancels a new thread and a re-anchor pick. */
    setMode(on) {
      modeOn = on;
      if (!on) {
        reanchorFor = null;
        hoverEl = null;
        if (activeId === "new") activeId = null;
      }
      render();
      renderHover();
    },
    attachDoc,
    /** Re-measures pins, outline and popover — after a frame load, zoom or resize. */
    layout() {
      renderPins();
      renderOutline();
      placeNow();
      renderHover();
    },
    /**
     * Esc from outside the popover: cancels a re-anchor pick, then closes the
     * popover. False when there was nothing to close, so the caller can leave
     * comment mode instead.
     */
    handleEscape() {
      if (reanchorFor !== null) {
        const id = reanchorFor;
        reanchorFor = null;
        open(id);
        return true;
      }
      if (activeId !== null) {
        close(true);
        return true;
      }
      return false;
    },
    /** Focuses the first pin (the sidebar count row). */
    focusFirstPin() {
      if (hidePins) {
        hidePins = false;
        onPrefsChange?.({ showResolved, hidePins });
        render();
      }
      /** @type {HTMLElement | null} */ (pinsEl.querySelector(".comment-pin"))?.focus();
    },
    open,
    isOpen: () => activeId !== null,
    setToolbarHidden(hidden) {
      toolbarEl.hidden = hidden;
      layerEl.hidden = hidden;
      if (hidden) bannerEl.hidden = true;
      else renderBanner();
    },
  };
  return api;
}
