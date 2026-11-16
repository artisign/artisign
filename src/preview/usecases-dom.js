// Use Cases tab — a small element builder. Text always goes in as text nodes, never as markup, so persona names, step
// actions and example values (agent- or human-authored) cannot inject HTML into the shell.

/**
 * @param {string} tag
 * @param {Record<string, any> | null} [props] `class`, `dataset`, `style` (object of CSS custom properties / properties), `onClick`-style handlers, `text`; `true` sets a boolean attribute, `false`/`null`/`undefined` skips
 * @param {...any} children strings, nodes, arrays (flattened) or nothing
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "style") for (const [name, v] of Object.entries(value)) el.style.setProperty(name, String(v));
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** A Material Symbols ligature (the shell's icon font). */
export function icon(name, extra = "") {
  return h("span", { class: extra ? `icon ${extra}` : "icon", "aria-hidden": "true" }, name);
}

/** Replaces the children of `el` — like replaceChildren, but null / false / nested arrays are tolerated (replaceChildren would write the text "null"). */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}
