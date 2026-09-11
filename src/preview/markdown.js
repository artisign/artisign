// A hand-written Markdown-subset renderer for agent-written prose (notes,
// design-system idea/decisions/usage, mockup descriptions) — not a
// CommonMark implementation.
//
// Sanitization strategy: every element is built with `document.createElement`
// / `document.createTextNode`. There is no `innerHTML`, no
// `insertAdjacentHTML`, and no serialized-HTML string anywhere in this
// module — no HTML parser is ever in the path, so a `<script>` or
// `<img onerror>` in the source can only ever end up as a text node. This
// matters here specifically because the notes panel lives in the preview
// shell's own top document (unlike the screen iframe, which is sandboxed),
// on the same origin that serves the write API.
//
// Supported subset (block level):
//   - `#`…`######`            -> h3…h6 (level n -> h{min(n+2, 6)}; the
//                                panel heading is already an h2)
//   - fenced code (```)       -> pre > code, content verbatim, no inline
//                                parsing inside
//   - `-` / `*` / `+`         -> ul > li; `1.` -> ol > li; one level of
//                                nesting by leading-space depth
//   - GFM tables              -> table > thead/tbody, alignment from the
//                                delimiter row as a class (md-align-left /
//                                -center / -right)
//   - `---` / `***` alone     -> hr
//   - blank-line-separated text -> p; a soft line break -> br
//
// Supported inline (inside headings, paragraphs, list items, table cells;
// never inside a fence):
//   - `` `code` ``            -> code, highest precedence
//   - `**x**` / `__x__`       -> strong; `*x*` / `_x_` -> em (an opening
//                                delimiter must not be followed by
//                                whitespace; `_`/`__` additionally must not
//                                be preceded by an alphanumeric, so
//                                `data_flow_target` and `2 * 3 * 4` survive
//                                unmodified — this project's own vocabulary
//                                is full of snake_case identifiers)
//   - `[text](url)`           -> a, only if url matches ^(https?:|mailto:)
//                                or starts with "/" or "#"; anything else
//                                (javascript:, data:, //...) renders as
//                                plain text, not a stripped-href anchor.
//                                Parens inside the url are balanced, so
//                                `[docs](https://x.com/a_(b))` keeps its
//                                whole url.
//
// Deliberately unsupported: images `![]()` (keeps an `src` sink out of this
// module entirely), autolinks, blockquotes, reference links, backslash
// escapes, HTML passthrough, setext headings, footnotes.

/** @param {string} line @returns {{ indent: number, ordered: boolean, content: string } | null} */
function matchListItem(line) {
  if (line == null) return null;
  const m = /^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(line);
  if (!m) return null;
  return { indent: m[1].length, ordered: m[3] !== undefined, content: m[4] };
}

/** @param {string | undefined} line @returns {boolean} */
function isTableDelimiter(line) {
  if (line == null) return false;
  const trimmed = line.trim();
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(trimmed) && trimmed.includes("-");
}

/** @param {string} line @param {string | undefined} nextLine @returns {"blank"|"fence"|"hr"|"heading"|"table"|"list"|"paragraph"} */
function blockType(line, nextLine) {
  if (line.trim() === "") return "blank";
  if (line.trim().startsWith("```")) return "fence";
  if (/^(-{3,}|\*{3,})$/.test(line.trim())) return "hr";
  if (/^#{1,6}\s+/.test(line)) return "heading";
  if (line.includes("|") && isTableDelimiter(nextLine)) return "table";
  if (matchListItem(line)) return "list";
  return "paragraph";
}

/** @param {string} line @returns {string[]} */
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => cell.trim());
}

/** @param {string} cell @returns {string | null} */
function cellAlignmentClass(cell) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "md-align-center";
  if (right) return "md-align-right";
  if (left) return "md-align-left";
  return null;
}

/**
 * Whether a delimiter run starting at `text[i]` (length `delimLen`, first
 * character `delimChar`) is allowed to *open* emphasis/strong. Two flanking
 * rules, both required so `data_flow_target` and `2 * 3 * 4` read back
 * unmodified instead of silently losing characters:
 *   - the content must not start with whitespace (also rejects an
 *     immediately-closing empty run)
 *   - for `_`/`__` specifically, the character before the delimiter must
 *     not be alphanumeric (GFM's intraword-underscore rule) — `*`/`**` stay
 *     intraword-legal, matching this project's own `$token`-in-prose style
 * @param {string} text @param {number} i @param {number} delimLen @param {string} delimChar
 * @returns {boolean}
 */
function canOpenEmphasis(text, i, delimLen, delimChar) {
  const nextChar = text[i + delimLen];
  if (nextChar === undefined || /\s/.test(nextChar)) return false;
  if (delimChar === "_") {
    const prevChar = text[i - 1];
    if (prevChar !== undefined && /[A-Za-z0-9]/.test(prevChar)) return false;
  }
  return true;
}

/**
 * Matches `[label](url)` at `text[i]`, counting balanced parens inside the
 * url so `[docs](https://x.com/a_(b))` keeps its whole url instead of
 * truncating at the first `)`.
 * @param {string} text @param {number} i
 * @returns {{ whole: string, label: string, url: string } | null}
 */
function matchLink(text, i) {
  if (text[i] !== "[") return null;
  const closeBracket = text.indexOf("]", i + 1);
  if (closeBracket === -1 || text[closeBracket + 1] !== "(") return null;
  const label = text.slice(i + 1, closeBracket);
  let depth = 0;
  let j = closeBracket + 2;
  while (j < text.length) {
    if (text[j] === "(") {
      depth++;
    } else if (text[j] === ")") {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (text[j] !== ")") return null;
  return { whole: text.slice(i, j + 1), label, url: text.slice(closeBracket + 2, j) };
}

/** Parses one run of inline text and appends the resulting nodes to `el`. */
function appendInline(el, text) {
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        const code = document.createElement("code");
        code.textContent = text.slice(i + 1, end);
        el.appendChild(code);
        i = end + 1;
        continue;
      }
    }

    if (text[i] === "[") {
      const m = matchLink(text, i);
      if (m) {
        const { whole, label, url } = m;
        if (/^(https?:|mailto:)/.test(url) || url.startsWith("/") || url.startsWith("#")) {
          const a = document.createElement("a");
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          appendInline(a, label);
          el.appendChild(a);
        } else {
          el.appendChild(document.createTextNode(label));
        }
        i += whole.length;
        continue;
      }
    }

    const strongMatch = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (strongMatch && canOpenEmphasis(text, i, 2, strongMatch[1][0])) {
      const strong = document.createElement("strong");
      appendInline(strong, strongMatch[2]);
      el.appendChild(strong);
      i += strongMatch[0].length;
      continue;
    }

    const emMatch = /^(\*|_)(.+?)\1/.exec(rest);
    if (emMatch && canOpenEmphasis(text, i, 1, emMatch[1])) {
      const em = document.createElement("em");
      appendInline(em, emMatch[2]);
      el.appendChild(em);
      i += emMatch[0].length;
      continue;
    }

    // Plain text run up to the next character that could start a special
    // span — always at least one character, so the loop makes progress
    // even for an unmatched `, [, * or _.
    let j = i + 1;
    while (j < text.length && !"`[*_".includes(text[j])) j++;
    el.appendChild(document.createTextNode(text.slice(i, j)));
    i = j;
  }
}

/** @param {string[]} lines @param {number} start @returns {{ element: HTMLElement, next: number }} */
function consumeFence(lines, start) {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  const body = [];
  let i = start + 1;
  while (i < lines.length && lines[i].trim() !== "```") {
    body.push(lines[i]);
    i++;
  }
  if (i < lines.length) i++; // skip the closing fence
  code.textContent = body.join("\n");
  pre.appendChild(code);
  return { element: pre, next: i };
}

/** @param {string[]} lines @param {number} start @returns {{ element: HTMLElement, next: number }} */
function consumeHeading(lines, start) {
  const m = /^(#{1,6})\s+(.*)$/.exec(lines[start]);
  const level = m[1].length;
  const heading = document.createElement(`h${Math.min(level + 2, 6)}`);
  appendInline(heading, m[2].trim());
  return { element: heading, next: start + 1 };
}

/** @param {string[]} lines @param {number} start @returns {{ element: HTMLElement, next: number }} */
function consumeTable(lines, start) {
  const table = document.createElement("table");
  const aligns = splitTableRow(lines[start + 1]).map(cellAlignmentClass);

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  splitTableRow(lines[start]).forEach((cellText, idx) => {
    const th = document.createElement("th");
    if (aligns[idx]) th.classList.add(aligns[idx]);
    appendInline(th, cellText);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  let i = start + 2;
  while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
    const tr = document.createElement("tr");
    splitTableRow(lines[i]).forEach((cellText, idx) => {
      const td = document.createElement("td");
      if (aligns[idx]) td.classList.add(aligns[idx]);
      appendInline(td, cellText);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
    i++;
  }
  table.appendChild(tbody);
  return { element: table, next: i };
}

/**
 * @param {string[]} lines @param {number} start @returns {{ element: HTMLElement, next: number }}
 *
 * Indent is normalized against `lines[start]`'s own indent, not against
 * column 0 — an indented line that *opens* a block (e.g. a bullet under a
 * heading) is this list's top level, not an orphaned nested item. That
 * normalization is also what guarantees progress: `lines[start]` always
 * matches at `indent === baseIndent`, so the first loop iteration always
 * takes the top-level branch and advances `i`.
 */
function consumeList(lines, start) {
  const baseIndent = matchListItem(lines[start]).indent;
  const top = matchListItem(lines[start]);
  const list = document.createElement(top.ordered ? "ol" : "ul");
  let currentLi = null;
  let nestedList = null;
  let i = start;
  while (i < lines.length) {
    const item = matchListItem(lines[i]);
    if (!item || item.indent < baseIndent) break;
    if (item.indent === baseIndent) {
      currentLi = document.createElement("li");
      appendInline(currentLi, item.content);
      list.appendChild(currentLi);
      nestedList = null;
    } else if (currentLi) {
      if (!nestedList) {
        nestedList = document.createElement(item.ordered ? "ol" : "ul");
        currentLi.appendChild(nestedList);
      }
      const li = document.createElement("li");
      appendInline(li, item.content);
      nestedList.appendChild(li);
    } else {
      break;
    }
    i++;
  }
  return { element: list, next: i };
}

/** @param {string[]} lines @param {number} start @returns {{ element: HTMLElement, next: number }} */
function consumeParagraph(lines, start) {
  const p = document.createElement("p");
  let i = start;
  let firstLine = true;
  while (i < lines.length && blockType(lines[i], lines[i + 1]) === "paragraph") {
    if (!firstLine) p.appendChild(document.createElement("br"));
    appendInline(p, lines[i].trim());
    firstLine = false;
    i++;
  }
  return { element: p, next: i };
}

/**
 * Renders a Markdown-subset string to a DocumentFragment, built entirely
 * from `createElement`/`createTextNode` — see the module docstring.
 *
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function renderMarkdown(text) {
  const fragment = document.createDocumentFragment();
  if (!text || text.trim() === "") return fragment;

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const type = blockType(lines[i], lines[i + 1]);
    if (type === "blank") {
      i++;
      continue;
    }

    let element;
    let next;
    switch (type) {
      case "fence":
        ({ element, next } = consumeFence(lines, i));
        break;
      case "hr":
        element = document.createElement("hr");
        next = i + 1;
        break;
      case "heading":
        ({ element, next } = consumeHeading(lines, i));
        break;
      case "table":
        ({ element, next } = consumeTable(lines, i));
        break;
      case "list":
        ({ element, next } = consumeList(lines, i));
        break;
      default:
        ({ element, next } = consumeParagraph(lines, i));
    }
    fragment.appendChild(element);
    // Safety net: no consume* function is allowed to stand still. A bug
    // that returns next <= i would otherwise re-dispatch the same line
    // forever instead of just mis-rendering it.
    i = next > i ? next : i + 1;
  }
  return fragment;
}

/** @param {HTMLElement} el @param {string} text */
export function setMarkdown(el, text) {
  el.replaceChildren(renderMarkdown(text));
}
