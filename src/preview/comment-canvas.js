// CHR-1248 — comments on the canvas: one numbered pin per thread on its
// anchored element, a popover with the thread next to it, comment mode's
// hover outline and new-thread flow, and re-anchoring. The tools that drive it
// (Comment, the thread list with its Open | Resolved tabs) live in the side tool
// bar and the right column (CHR-1268); app.js calls setMode and setShowResolved.
//
// Everything here is an editor overlay in the PARENT document (#comment-layer
// inside #canvas, in the canvas's scrolled content coordinates). The screen
// iframe's document is only measured and listened to, never written to —
// render determinism: no pin, outline or popover can leak into stored screen
// HTML or a get_screen response.
//
// One controller serves one or several documents (CHR-1263): a screen has one
// frame, a mockup one per variant. The host (comment-hosts.js) says where the
// layer, the scroll pane and the frames are; a thread belongs to the frame
// whose key is its `variant` (a screen's thread has none: key null).
//
// The module owns no data fetching: app.js hands it the shown scope's
// comments (GET /api/comments, events already applied server-side) and the
// actions that post to the daemon.

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
 * resolved" is on.
 * @template {{ status: "open" | "resolved" }} T
 * @param {T[]} threads
 * @param {{ showResolved: boolean }} opts
 * @returns {T[]}
 */
export function pinnedThreads(threads, { showResolved }) {
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
 * The element a comment-mode click or hover anchors to in a mockup variant
 * (ADR-012): the nearest element with an authored id, or the whole variant
 * (`el: null`, `id: null`) when there is none. A mockup has no screen root.
 * @param {EventTarget | null} target
 * @returns {{ el: Element | null, id: string | null }}
 */
export function mockupCommentTarget(target) {
  const start = /** @type {Element | null} */ (target && typeof (/** @type {Element} */ (target).closest) === "function" ? target : null);
  const el = start?.closest("[id]") ?? null;
  return { el, id: el ? el.id : null };
}

/** @param {string | null} ref `<screen>.<node-id>` or null */
export function bareId(ref) {
  if (ref === null) return null;
  const dot = ref.indexOf(".");
  return dot === -1 ? ref : ref.slice(dot + 1);
}

/**
 * One message of a thread: avatar, author, badge, age, text. Shared with the
 * board's read-only preview (CHR-1264).
 * @param {{ author: "human" | "agent", agent?: string, ts: string, text: string }} record
 * @returns {HTMLLIElement}
 */
export function renderCommentMessage(record) {
  const li = document.createElement("li");
  li.className = "comment-message";
  const meta = divEl("comment-message-meta");
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
  const body = divEl("comment-message-body");
  body.textContent = record.text;
  li.append(meta, body);
  return li;
}

function divEl(className) {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, variant?: string, node_id: string | null, author: "human" | "agent", agent?: string, status: "open" | "resolved", detached: boolean, reply_count: number }} ThreadInfo
 * @typedef {{ id: string, variant?: string, node_id: string | null, text: string, author: "human" | "agent", agent?: string, parent_id: string | null, resolved: boolean, ts: string }} CommentRecord
 * @typedef {{ ok: true } | { ok: false, message: string }} ActionResult
 * @typedef {{
 *   setMode: (on: boolean) => void,
 *   create: (nodeId: string | null, text: string, variant: string | null) => Promise<ActionResult>,
 *   reply: (rootId: string, text: string) => Promise<ActionResult>,
 *   resolve: (rootId: string) => Promise<ActionResult>,
 *   reopen: (rootId: string) => Promise<ActionResult>,
 *   remove: (rootId: string) => Promise<ActionResult>,
 *   reanchor: (rootId: string, domId: string, variant: string | null) => Promise<ActionResult>,
 *   copy?: (text: string) => void,
 * }} CanvasActions
 * @typedef {import("./comment-hosts.js").CommentHost} CommentHost
 * @typedef {import("./comment-hosts.js").CommentFrame} CommentFrame
 * @typedef {{ el: Element | null, id: string | null }} Hit
 */

/**
 * @param {{
 *   host: CommentHost,
 *   bannerEl: HTMLElement,
 *   actions: CanvasActions,
 *   fallbackFocus?: (threadId: string | null) => HTMLElement | null,
 *   prefs?: { showResolved: boolean },
 *   onPrefsChange?: (prefs: { showResolved: boolean }) => void,
 *   onActiveChange?: () => void,
 * }} opts
 */
export function createCommentCanvas({ host: initialHost, bannerEl, actions, prefs, onPrefsChange, onActiveChange, fallbackFocus }) {
  let host = initialHost;
  /** @type {string | null} what the data belongs to ("screen:<name>" / "mockup:<name>"); a change closes the popover */
  let scope = null;
  /** @type {CommentRecord[]} */
  let comments = [];
  /** @type {ThreadInfo[]} */
  let threads = [];
  let modeOn = false;
  let showResolved = prefs?.showResolved ?? false;
  /** @type {string | null} the open thread's id, or "new" for a new thread */
  let activeId = null;
  /** @type {string | null | undefined} the new thread's DOM id (null = whole screen / whole variant) */
  let newTarget;
  /** @type {string | null} the frame the new thread is being started in */
  let newKey = null;
  /** @type {string | null} thread waiting for the element to re-anchor to */
  let reanchorFor = null;
  /** @type {{ key: string | null, hit: Hit } | null} */
  let hover = null;
  let busy = false;
  let errorText = "";
  let menuOpen = false;
  let confirmDelete = false;
  /** The attached documents, one per frame key, each with its listener cleanup. @type {Map<string | null, () => void>} */
  const attached = new Map();

  // Layer parts. The popover is kept across re-renders so a reply being typed survives an SSE refresh.
  const outlineEl = div("comment-target-outline");
  const hoverOutlineEl = div("comment-hover-outline");
  const pinsEl = div("comment-pins");
  const dimsEl = div("comment-dims");
  // A native non-modal <dialog>, opened with show(): it must stay out of the top layer to scroll with the canvas next to its element.
  const popoverEl = document.createElement("dialog");
  popoverEl.className = "comment-popover";
  outlineEl.hidden = true;
  hoverOutlineEl.hidden = true;
  mount();

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
    if (popoverEl.contains(target) || pinsEl.contains(target)) return;
    // A column header's count chip and a row of the Comments panel open a thread themselves: closing first would rebuild them away from under the press.
    if (typeof (/** @type {Element} */ (target).closest) === "function" && /** @type {Element} */ (target).closest(".comment-count-chip, .comment-row")) return;
    close(false);
  };
  document.addEventListener("pointerdown", onOutsidePress, true);

  // ---------------------------------------------------------------------------

  function div(className) {
    const el = document.createElement("div");
    el.className = className;
    return el;
  }

  /** Puts the layer parts, the toolbar and the banner where the host says (the host's layer, its stage). */
  function mount() {
    host.layerEl.replaceChildren(dimsEl, outlineEl, hoverOutlineEl, pinsEl, popoverEl);
    host.stageEl.append(bannerEl);
    bannerEl.dataset.placement = host.placement ?? "top";
  }

  /** @param {string | null} key @returns {CommentFrame | null} */
  function frameOf(key) {
    return host.frames().find((f) => f.key === key) ?? null;
  }

  /** A thread's frame key: its variant for a mockup thread, null on a screen. */
  const keyOf = (t) => t.variant ?? null;

  /** The frame a thread's pin sits in: its own, or — when its variant no longer exists — the first one, in the detached stack. @returns {CommentFrame | null} */
  function homeFrame(t) {
    return frameOf(keyOf(t)) ?? (keyOf(t) === null ? null : (host.frames()[0] ?? null));
  }

  /** @param {CommentFrame} frame @returns {{ left: number, top: number, right: number, bottom: number } | null} the whole frame's box in layer coordinates */
  function wholeBox(frame) {
    const m = frame.box();
    return m ? { left: m.left, top: m.top, right: m.left + m.width, bottom: m.top + m.height } : null;
  }

  /** @param {string | null} key @param {string | null} domId @returns {{ left: number, top: number, right: number, bottom: number } | null} */
  function boxFor(key, domId) {
    const frame = frameOf(key);
    if (!frame) return null;
    if (domId === null) return wholeBox(frame);
    const el = frame.getDoc()?.getElementById(domId);
    return el ? boxOfElement(frame, el) : null;
  }

  /** @param {CommentFrame} frame @param {Element} el */
  function boxOfElement(frame, el) {
    const m = frame.box();
    if (!m) return null;
    const r = el.getBoundingClientRect();
    return { left: m.left + r.left * m.scale, top: m.top + r.top * m.scale, right: m.left + r.right * m.scale, bottom: m.top + r.bottom * m.scale };
  }

  function thread(id) {
    return threads.find((t) => t.id === id) ?? null;
  }

  /** What a frame is called in a label: the variant's letter on a mockup, nothing on a screen. */
  function frameName(key) {
    return key === null ? null : (frameOf(key)?.label ?? key);
  }

  function threadLabel(t) {
    const number = numberThreads(threads).get(t.id);
    const name = frameName(keyOf(t));
    const node = bareId(t.node_id);
    const target = name === null ? (node ?? "screen") : `${name}${node ? `, ${node}` : ""}`;
    return `Comment ${number} on ${target}${t.detached ? ", detached" : ""}${t.status === "resolved" ? ", resolved" : ""}`;
  }

  // ---------------------------------------------------------------------------
  // Rendering

  function render() {
    renderBanner();
    renderPins();
    renderDims();
    renderOutline();
    renderPopover();
    renderHover();
  }

  /** While a re-anchor pick waits, the frames it may not pick from dim fully. */
  function renderDims() {
    dimsEl.replaceChildren();
    if (reanchorFor === null) return;
    for (const frame of host.frames()) {
      if (pickable(frame.key)) continue;
      const box = wholeBox(frame);
      if (!box) continue;
      const dim = div("comment-dim");
      dim.style.left = `${box.left}px`;
      dim.style.top = `${box.top}px`;
      dim.style.width = `${box.right - box.left}px`;
      dim.style.height = `${box.bottom - box.top}px`;
      dimsEl.append(dim);
    }
  }

  function renderBanner() {
    bannerEl.replaceChildren();
    if (reanchorFor !== null) {
      const number = numberThreads(threads).get(reanchorFor);
      bannerEl.append(icon("my_location"), `Click the element to move #${number} to`, kbd("Esc"), muted("cancels"));
      bannerEl.hidden = false;
    } else if (modeOn) {
      bannerEl.append(icon("chat_bubble"), host.modeText ?? "Comment mode — click an element to start a thread", kbd("Esc"), muted("to exit"));
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
    const perElement = new Map();
    const pinned = pinnedThreads(threads, { showResolved });
    // DOM order follows the frames (a mockup's columns A, B, C), then the log.
    const ordered = host.frames().flatMap((frame) => pinned.filter((t) => homeFrame(t)?.key === frame.key));
    for (const t of ordered) {
      let x;
      let y;
      const frame = /** @type {CommentFrame} */ (homeFrame(t));
      if (!t.detached && frameOf(keyOf(t)) !== null) {
        const domId = bareId(t.node_id);
        const box = boxFor(keyOf(t), domId);
        if (!box) continue; // not in this document (yet): the next layout() places it
        const slot = `${keyOf(t) ?? ""}/${domId ?? ""}`;
        const index = perElement.get(slot) ?? 0;
        perElement.set(slot, index + 1);
        x = box.right - index * (PIN_SIZE - 4);
        y = box.top;
      } else {
        // Detached pins stack at the frame's top-left.
        const box = wholeBox(frame);
        if (!box) continue;
        const slot = `${frame.key ?? ""}/detached`;
        const index = perElement.get(slot) ?? 0;
        perElement.set(slot, index + 1);
        x = box.left;
        y = box.top + index * DETACHED_STEP;
      }
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "comment-pin";
      pin.dataset.thread = t.id;
      pin.dataset.kind = t.author;
      if (t.variant !== undefined) pin.dataset.variant = t.variant;
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
    if (activeId === "new" && newTarget !== undefined) box = boxFor(newKey, newTarget);
    else if (activeId !== null && activeId !== "new") {
      const t = thread(activeId);
      if (t && !t.detached) box = boxFor(keyOf(t), bareId(t.node_id));
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
    const popKey = isNew ? newKey : keyOf(/** @type {ThreadInfo} */ (t));
    const popFrame = popKey === null ? null : frameName(popKey);
    popoverEl.setAttribute("aria-label", isNew ? `New comment on ${popFrame === null ? (newTarget ?? "screen") : `${popFrame}${newTarget ? `, ${newTarget}` : ""}`}` : threadLabel(/** @type {ThreadInfo} */ (t)));

    // Header.
    popHeader.replaceChildren();
    const title = document.createElement("b");
    title.textContent = isNew ? "New thread" : `#${numberThreads(threads).get(/** @type {ThreadInfo} */ (t).id)}`;
    const node = document.createElement("code");
    node.className = "comment-popover-node";
    node.textContent = (isNew ? newTarget : bareId(/** @type {ThreadInfo} */ (t).node_id)) ?? (popKey === null ? "screen" : "variant");
    // A mockup thread names its variant after the number, so it reads without looking at the column.
    if (popFrame !== null) {
      const badge = document.createElement("span");
      badge.className = "comment-variant-badge";
      badge.textContent = popFrame;
      popHeader.append(title, badge, node);
    } else popHeader.append(title, node);
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
      const where = popKey === null ? "on this screen" : `in variant ${popFrame}`;
      text.textContent = `${bareId(t.node_id)} no longer exists ${where}. Move the thread to the element that replaced it, or resolve it.`;
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
      for (const record of records) popMessages.append(renderCommentMessage(record));
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
    if (activeId === "new") anchor = newTarget === undefined ? null : boxFor(newKey, newTarget);
    else {
      const t = thread(/** @type {string} */ (activeId));
      if (t && !t.detached) anchor = boxFor(keyOf(t), bareId(t.node_id));
      if (!anchor) {
        const pin = pinFor(/** @type {string} */ (activeId));
        if (pin) {
          const x = Number.parseFloat(pin.style.left) || 0;
          const y = Number.parseFloat(pin.style.top) || 0;
          anchor = { left: x, top: y, right: x + PIN_SIZE, bottom: y + PIN_SIZE };
        }
      }
    }
    const view = host.view();
    if (!anchor) anchor = { left: view.left, top: view.top, right: view.left, bottom: view.top };
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
    const result = await run(() => (activeId === "new" ? actions.create(newTarget ?? null, text, newKey) : actions.reply(/** @type {string} */ (activeId), text)), activeId === "new");
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
    onActiveChange?.();
    textarea.focus();
  }

  /** @param {string | null} key the frame @param {string | null} domId */
  function startNew(key, domId) {
    activeId = "new";
    newKey = key;
    newTarget = domId;
    textarea.value = "";
    errorText = "";
    menuOpen = false;
    render();
    onActiveChange?.();
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
    onActiveChange?.();
    if (!returnFocus) return;
    // Back to the thread's pin; after a resolve or delete that pin is gone, so the first pin takes focus, else what the owner names (the Comments row or tool it was opened from, the Comment tool).
    const target = (was && was !== "new" ? pinFor(was) : null) ?? /** @type {HTMLElement | null} */ (pinsEl.querySelector(".comment-pin")) ?? fallbackFocus?.(was && was !== "new" ? was : null) ?? null;
    target?.focus();
  }

  // ---------------------------------------------------------------------------
  // The documents: hover outline, new-thread and re-anchor clicks

  /** The frame a click or hover may pick in right now: any frame, or — while re-anchoring — the thread's own (any, if its variant is gone). */
  function pickable(key) {
    if (reanchorFor === null) return true;
    const own = keyOf(thread(reanchorFor) ?? {});
    return frameOf(own) === null || key === own; // a thread whose variant is gone may move to any frame
  }

  /**
   * Listens on one frame's freshly loaded document (nothing is written into
   * it). Called again for the same key when the frame reloads: the previous
   * document's listeners go first.
   * @param {string | null} key the frame's key (null: the screen)
   * @param {Document | null} doc
   */
  function attachDoc(key, doc) {
    attached.get(key)?.();
    attached.delete(key);
    if (hover?.key === key) hover = null;
    if (!doc) return;
    const picks = (target) => frameOf(key)?.pick(target, doc) ?? null;
    const onMove = (evt) => {
      if ((!modeOn && reanchorFor === null) || !pickable(key)) return;
      const hit = picks(evt.target);
      hover = hit ? { key, hit } : null;
      renderHover();
    };
    const onLeave = () => {
      if (hover?.key === key) hover = null;
      renderHover();
    };
    const onClick = (evt) => {
      if (!modeOn && reanchorFor === null) return;
      evt.preventDefault();
      evt.stopPropagation();
      if (!pickable(key)) return;
      const hit = picks(evt.target);
      if (!hit) return;
      if (reanchorFor !== null) {
        if (hit.id === null) return; // a thread re-anchors to an element, never back to the whole screen or variant
        const id = reanchorFor;
        reanchorFor = null;
        hover = null;
        render();
        void actions.reanchor(id, hit.id, key).then((result) => {
          if (result.ok) open(id);
          else {
            open(id);
            errorText = result.message;
            renderPopover();
          }
        });
        return;
      }
      startNew(key, hit.id);
    };
    const onPress = (evt) => {
      if (modeOn || reanchorFor !== null) return;
      onOutsidePress(evt);
    };
    // Fonts and images settle after load: re-measure when the document's own layout moves.
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => api.layout()) : null;
    if (resizeObserver && doc.body) resizeObserver.observe(doc.body);
    doc.addEventListener("pointermove", onMove, true);
    doc.addEventListener("pointerleave", onLeave);
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("pointerdown", onPress, true);
    attached.set(key, () => {
      resizeObserver?.disconnect();
      doc.removeEventListener("pointermove", onMove, true);
      doc.removeEventListener("pointerleave", onLeave);
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("pointerdown", onPress, true);
    });
  }

  function detachAll() {
    for (const cleanup of attached.values()) cleanup();
    attached.clear();
    hover = null;
  }

  function renderHover() {
    const frame = hover ? frameOf(hover.key) : null;
    if ((!modeOn && reanchorFor === null) || !hover || !frame) {
      hoverOutlineEl.hidden = true;
      return;
    }
    const box = hover.hit.el ? boxOfElement(frame, hover.hit.el) : wholeBox(frame);
    setBox(hoverOutlineEl, box, frame.hoverLabel(hover.hit));
  }

  render();

  const api = {
    /**
     * New data for the shown scope. A scope switch closes the popover; a
     * refresh of the same scope keeps it (and the text being typed).
     * @param {{ scope: string | null, comments: CommentRecord[], threads: ThreadInfo[] }} data
     */
    setData(data) {
      if (data.scope !== scope) {
        activeId = null;
        newTarget = undefined;
        reanchorFor = null;
        textarea.value = "";
      }
      scope = data.scope;
      comments = data.comments;
      threads = data.threads;
      render();
    },
    /**
     * Moves the controller to another host (the screen canvas, the mockup
     * columns): the layer parts, toolbar and banner follow, and everything
     * tied to the old documents goes. The next setData and attachDoc calls
     * fill the new one.
     * @param {CommentHost} next
     */
    setHost(next) {
      if (next === host) return;
      detachAll();
      host = next;
      activeId = null;
      newTarget = undefined;
      reanchorFor = null;
      scope = null;
      threads = [];
      comments = [];
      mount();
      render();
      onActiveChange?.();
    },
    /** Comment mode on/off (the top-bar toggle, C, the toolbar). Leaving it cancels a new thread and a re-anchor pick. */
    setMode(on) {
      modeOn = on;
      if (!on) {
        reanchorFor = null;
        hover = null;
        if (activeId === "new") activeId = null;
      }
      render();
      renderHover();
    },
    attachDoc,
    /** Re-measures pins, outline and popover — after a frame load, zoom, scroll or resize. */
    layout() {
      renderPins();
      renderDims();
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
    /**
     * Opens the first thread of one kind in one frame (a column header's
     * count chip): "open" (not detached), "detached" or "resolved".
     * @param {string | null} key
     * @param {"open" | "detached" | "resolved"} kind
     */
    openFirst(key, kind) {
      const match = threads.find((t) => homeFrame(t)?.key === key && threadKind(t) === kind);
      if (!match) return;
      open(match.id);
    },
    open,
    /** Opens one thread by id — the Board's "Open in Screens" (CHR-1264); @param {string} id */
    openThread(id) {
      if (!threads.some((t) => t.id === id)) return;
      open(id);
    },
    isOpen: () => activeId !== null,
    /** The open thread's id, or null (also for a new thread). */
    activeThread: () => (activeId === "new" ? null : activeId),
    prefs: () => ({ showResolved }),
    /** Resolved threads get a pin too (the Comments panel's Resolved tab). @param {boolean} on */
    setShowResolved(on) {
      if (on === showResolved) return;
      showResolved = on;
      onPrefsChange?.({ showResolved });
      render();
    },
    /** Hides the whole comment layer and the banner (no screen to comment on, Compare, another view). @param {boolean} hidden */
    setLayerHidden(hidden) {
      host.layerEl.hidden = hidden;
      if (hidden) bannerEl.hidden = true;
      else renderBanner();
    },
  };

  return api;
}

/**
 * Which count a thread belongs to: "resolved", else "detached", else "open".
 * @param {{ status: "open" | "resolved", detached: boolean }} t
 * @returns {"open" | "detached" | "resolved"}
 */
export function threadKind(t) {
  if (t.status === "resolved") return "resolved";
  return t.detached ? "detached" : "open";
}
