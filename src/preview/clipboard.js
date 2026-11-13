// Copy-to-clipboard with the "copied" feedback shared by the Connect AI tools dialog (CHR-926) and the update notice (CHR-927).

/** How long a copy button shows its check mark. */
const COPIED_MS = 1500;

/**
 * Writes `text` to the clipboard and, on success, turns the glyph of `iconEl` into a check mark for a moment. A clipboard that is missing or refuses is tolerated (nothing happens).
 *
 * @param {string} text
 * @param {HTMLElement} iconEl the `.icon` element showing `content_copy`
 */
export async function copyWithFeedback(text, iconEl) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  iconEl.textContent = "check";
  setTimeout(() => {
    iconEl.textContent = "content_copy";
  }, COPIED_MS);
}

/**
 * Writes `text` to the clipboard and, on success, switches the label of `button` to "Copied" for a moment (CHR-1048). A clipboard that is missing or refuses is tolerated.
 *
 * @param {string} text
 * @param {HTMLElement} button a button whose text is its label
 */
export async function copyWithLabel(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  button.dataset.label ??= button.textContent ?? "";
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = button.dataset.label ?? "";
  }, COPIED_MS);
}

/**
 * A compact chip showing a command with a copy icon — the whole chip is one button that copies the command.
 *
 * @param {string} command
 * @returns {HTMLButtonElement}
 */
export function createCopyChip(command) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "copy-chip";
  chip.setAttribute("aria-label", `Copy ${command}`);
  const code = document.createElement("code");
  code.textContent = command;
  const glyph = document.createElement("span");
  glyph.className = "icon";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "content_copy";
  chip.append(code, glyph);
  chip.addEventListener("click", () => copyWithFeedback(command, glyph));
  return chip;
}
