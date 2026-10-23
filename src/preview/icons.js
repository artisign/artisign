// Shared Material Symbols builder for the preview chrome (the `.icon` ligature font, style.css).

/**
 * An aria-hidden icon span; the ligature name is its text.
 *
 * @param {string} name Material Symbols ligature, e.g. "chevron_right"
 * @param {string} [className] extra classes next to "icon"
 * @returns {HTMLSpanElement}
 */
export function icon(name, className = "") {
  const node = document.createElement("span");
  node.className = `icon ${className}`.trim();
  node.setAttribute("aria-hidden", "true");
  node.textContent = name;
  return node;
}
