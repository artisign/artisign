// Use Cases tab — the dialog scaffold shared by every form (use case, persona, dimension, data object, generate) and the
// small field helpers. A native <dialog> opened with showModal() (no manual focus trap), labelled by its title, a header
// and footer that stay while the body scrolls. A dirty form asks before it discards (Esc, close button, Cancel).

import { h, icon } from "./usecases-dom.js";

let counter = 0;
export function nextId(prefix = "uc-f") {
  counter++;
  return `${prefix}-${counter}`;
}

/**
 * @param {{ title: string, chip?: string, wide?: boolean, marker?: string }} spec `chip`: the entity id shown next to the title; `marker`: a small badge ("Generated")
 */
export function createDialog({ title, chip, wide = false, marker }) {
  const titleId = nextId("uc-dialog-title");
  const dialog = h("dialog", { class: wide ? "uc-dialog is-wide" : "uc-dialog", "aria-labelledby": titleId });
  const body = h("div", { class: "uc-dialog-body" });
  const message = h("p", { class: "uc-foot-msg", role: "status", id: nextId("uc-foot-msg") });
  const actions = h("div", { class: "uc-foot-actions" });
  const foot = h("footer", { class: "uc-dialog-foot" }, message, actions);
  let dirty = false;
  let defaultActions = [];
  let closed = false;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const closeButton = h("button", { type: "button", class: "chrome-icon-btn chrome-icon-btn--sm", "aria-label": "Close", title: "Close", onClick: () => api.requestClose() }, icon("close"));
  dialog.append(h("header", { class: "uc-dialog-head" }, h("h1", { class: "uc-dialog-title", id: titleId }, title), chip ? h("span", { class: "uc-id-chip is-static" }, chip) : null, marker ? h("span", { class: "uc-generated" }, icon("auto_awesome"), marker) : null, h("span", { class: "uc-map-spacer" }), closeButton), body, foot);

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    api.requestClose();
  });

  const api = {
    el: dialog,
    body,
    closed: closedPromise,
    setDirty(value) {
      dirty = value;
      if (value) actions.querySelector("[data-action=discard]")?.remove(); // editing again withdraws the discard prompt
    },
    isDirty: () => dirty,
    setMessage(text, tone = "") {
      message.textContent = text;
      message.dataset.tone = tone;
    },
    /** The footer buttons: [{ label, primary, danger, disabled, onClick }]. They become the default set a discard prompt falls back to. */
    setActions(list) {
      defaultActions = list;
      this.showActions(list);
    },
    showActions(list) {
      actions.replaceChildren(
        ...list.map((a) => {
          if (a instanceof Node) return a;
          return h("button", { type: "button", class: `chrome-btn${a.primary ? " chrome-btn--primary" : ""}${a.danger ? " uc-btn-danger" : ""}`, disabled: a.disabled, onClick: a.onClick, autofocus: a.autofocus, dataset: { action: a.id ?? "" } }, a.label);
        }),
      );
      // A prompt that replaced the buttons (a delete confirmation): focus goes to its safe action.
      if (dialog.hasAttribute("open")) actions.querySelector("[autofocus]")?.focus();
    },
    open() {
      document.body.append(dialog);
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      const first = dialog.querySelector("[autofocus]");
      first?.focus();
      return closedPromise;
    },
    /** Back to the buttons the dialog started with (after a discard / delete prompt was declined). */
    restoreActions() {
      api.setMessage("");
      api.showActions(defaultActions);
    },
    /** Close now, without asking. */
    close(result = null) {
      if (closed) return;
      closed = true;
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      dialog.remove();
      resolveClosed(result);
    },
    /** Close, asking first when there are unsaved changes. */
    requestClose() {
      if (!dirty) return api.close(null);
      // The dialog stays open with a visible reason; the destructive button is added at the far left of the right-aligned row, so no button moves under the pointer, and it carries the reason as its description.
      api.setMessage("You have unsaved changes. Discard them?", "warning");
      let discard = actions.querySelector("[data-action=discard]");
      if (!discard) {
        discard = h("button", { type: "button", class: "chrome-btn uc-btn-danger", dataset: { action: "discard" }, "aria-describedby": message.id, onClick: () => api.close(null) }, "Discard");
        actions.prepend(discard);
      }
      discard.focus();
    },
  };
  return api;
}

/** A confirm dialog for destructive actions; resolves true on confirm. */
export function confirmDialog({ title, text, confirmLabel = "Delete" }) {
  const dialog = createDialog({ title });
  dialog.body.append(h("p", { class: "uc-confirm-text" }, text));
  let answer = false;
  dialog.setActions([
    { label: "Cancel", autofocus: true, onClick: () => dialog.close(false) }, // the safe action has the focus
    { label: confirmLabel, danger: true, onClick: () => { answer = true; dialog.close(true); } },
  ]);
  return dialog.open().then(() => answer);
}

/** label + control (+ hint) as one form field. `control` may be an element with an id; the label points at it. */
export function field(label, control, { hint, className = "" } = {}) {
  if (!control.id) control.id = nextId();
  return h("div", { class: `uc-field ${className}`.trim() }, h("label", { class: "uc-label", for: control.id }, label, hint ? h("span", { class: "uc-label-hint" }, ` · ${hint}`) : null), control);
}

export function textInput({ value = "", placeholder = "", mono = false, autofocus = false, list, readonly = false, onInput, ariaLabel }) {
  const input = h("input", { type: "text", class: `chrome-field${mono ? " uc-mono" : ""}`, value, placeholder, autofocus, list, readonly, autocomplete: "off", "aria-label": ariaLabel });
  input.value = value;
  if (onInput) input.addEventListener("input", () => onInput(input.value));
  return input;
}

export function textArea({ value = "", rows = 3, placeholder = "", onInput, ariaLabel }) {
  const area = h("textarea", { class: "chrome-field uc-textarea", rows: String(rows), placeholder, "aria-label": ariaLabel });
  area.value = value;
  if (onInput) area.addEventListener("input", () => onInput(area.value));
  return area;
}

/** A native <select> (keyboard and screen-reader behaviour for free). `options`: [{ value, label }]; a current value that is not among them is kept as an extra option. */
export function selectInput({ options, value = "", onChange, ariaLabel, className = "" }) {
  const select = h("select", { class: `chrome-field uc-select ${className}`.trim(), "aria-label": ariaLabel });
  const known = options.some((o) => o.value === value);
  const all = known || value === "" ? options : [...options, { value, label: `${value} (unknown)` }];
  for (const option of all) select.append(h("option", { value: option.value }, option.label));
  select.value = value;
  if (onChange) select.addEventListener("change", () => onChange(select.value));
  return select;
}

export function removeButton(label, onClick) {
  return h("button", { type: "button", class: "chrome-icon-btn chrome-icon-btn--sm", "aria-label": label, title: label, onClick }, icon("close"));
}
