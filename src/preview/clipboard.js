// Copy-to-clipboard with visible feedback, shared by the Connect AI tools dialog (CHR-926), the update notice (CHR-927), the settings menu and the no-project card (CHR-1272). Success shows a check mark for a moment; a clipboard that is missing or refuses shows an error mark, names the failure in the control's title and selects the text, so it can still be copied by hand.

/** How long a copy button shows its check (or error) mark. */
const COPIED_MS = 1500;
/** The failure stays a little longer: it has to be read. */
const FAILED_MS = 3000;

/** The timer that puts a glyph or a label back, per element: a second press restarts it instead of racing the first. @type {WeakMap<Element, ReturnType<typeof setTimeout>>} */
const restoreTimers = new WeakMap();

/**
 * @param {Element} el
 * @param {() => void} restore
 * @param {number} ms
 */
function restoreLater(el, restore, ms) {
  clearTimeout(restoreTimers.get(el));
  restoreTimers.set(
    el,
    setTimeout(() => {
      restoreTimers.delete(el);
      restore();
    }, ms),
  );
}

/** @param {Element | null | undefined} el the element whose text becomes the selection */
function selectText(el) {
  if (!el) return;
  const selection = window.getSelection?.();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Writes `text` to the clipboard. Never throws: a missing or refusing clipboard answers `false`.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes `text` to the clipboard and turns the glyph of `iconEl` into a check mark for a moment. When the clipboard refuses the glyph turns into an error mark, the button's title says so, and `selectEl` (the text that was to be copied) is selected for a manual copy.
 *
 * @param {string} text
 * @param {HTMLElement} iconEl the `.icon` element showing `content_copy`
 * @param {Element | null} [selectEl] the visible text to select when the clipboard fails
 * @returns {Promise<boolean>} whether the text reached the clipboard
 */
export async function copyWithFeedback(text, iconEl, selectEl = null) {
  const button = iconEl.closest("button");
  const title = button?.dataset.copyTitle ?? button?.title ?? "";
  if (button) button.dataset.copyTitle = title;
  const ok = await writeClipboard(text);
  iconEl.textContent = ok ? "check" : "error";
  iconEl.dataset.copyState = ok ? "copied" : "failed";
  if (button) button.title = ok ? title : "Copy failed. The text is selected: copy it by hand.";
  if (!ok) selectText(selectEl);
  restoreLater(iconEl, () => {
    iconEl.textContent = "content_copy";
    delete iconEl.dataset.copyState;
    if (button) button.title = title;
  }, ok ? COPIED_MS : FAILED_MS);
  return ok;
}

/**
 * Writes `text` to the clipboard and switches the label of `button` to "Copied" (or "Copy failed") for a moment (CHR-1048).
 *
 * @param {string} text
 * @param {HTMLElement} button a button whose text is its label
 * @returns {Promise<boolean>} whether the text reached the clipboard
 */
export async function copyWithLabel(text, button) {
  button.dataset.label ??= button.textContent ?? "";
  const ok = await writeClipboard(text);
  button.textContent = ok ? "Copied" : "Copy failed";
  restoreLater(button, () => {
    button.textContent = button.dataset.label ?? "";
  }, ok ? COPIED_MS : FAILED_MS);
  return ok;
}

/**
 * A read-only code box with a copy button (design `code-field`): the text in the code font, the copy icon button at its right edge. `compact` hugs its text (the update toast), `block` wraps long text and aligns the button to the top (a command or config in an expanded row); the default fills the width. The code is not a button: only the icon copies.
 *
 * @param {string} text
 * @param {{ variant?: "default" | "compact" | "block", label?: string }} [options] `label`: the copy button's accessible name (default `Copy <text>`)
 * @returns {HTMLDivElement}
 */
export function createCodeField(text, { variant = "default", label } = {}) {
  const field = document.createElement("div");
  field.className = `code-field${variant === "default" ? "" : ` code-field--${variant}`}`;
  const code = document.createElement("code");
  code.className = "code-field-text";
  code.textContent = text;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "float-icon-btn code-field-copy";
  copy.setAttribute("aria-label", label ?? `Copy ${text}`);
  copy.title = "Copy";
  const glyph = document.createElement("span");
  glyph.className = "icon";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "content_copy";
  copy.append(glyph);
  copy.addEventListener("click", () => void copyWithFeedback(text, glyph, code));
  field.append(code, copy);
  return field;
}
