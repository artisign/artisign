// Renders one collapsible section per project tag that both applies to the
// selected screen AND carries its own notes (CHR-596) — a spec that spans
// several screens, set once via set_meta({target:{kind:"tag",tag}}) instead
// of duplicated into every tagged screen's own notes. Pure DOM rendering;
// app.js owns fetching /api/tags and wiring SSE refresh.

import { setMarkdown } from "./markdown.js";

/**
 * @param {HTMLElement} container — a sibling holder for tag sections, never
 *   #notes-panel-text itself: `setMarkdown` replaces an element's children
 *   wholesale, so rendering tag sections inside the screen-notes element
 *   would wipe them on the next screen-notes update.
 * @param {string[]} screenTags — the selected screen's own tags.
 * @param {{ tag: string, notes: string }[]} allTagNotes — every tag in the
 *   project that carries notes (fetchTags()); entries whose tag isn't in
 *   `screenTags` are not rendered here.
 */
export function renderTagNotes(container, screenTags, allTagNotes) {
  container.innerHTML = "";
  const screenTagsLower = new Set(screenTags.map((t) => t.toLowerCase()));
  const matches = allTagNotes.filter((t) => screenTagsLower.has(t.tag.toLowerCase()));

  for (const { tag, notes } of matches) {
    const section = document.createElement("section");
    section.className = "tag-notes-section";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "tag-notes-header";
    // Collapsed by default, independently of the screen-notes header's own
    // expand state and of every other tag section's — no shared state here.
    header.setAttribute("aria-expanded", "false");

    const chevron = document.createElement("span");
    chevron.className = "tag-notes-chevron";
    chevron.setAttribute("aria-hidden", "true");
    header.appendChild(chevron);

    const title = document.createElement("span");
    title.className = "tag-notes-title";
    title.textContent = tag;
    header.appendChild(title);

    header.addEventListener("click", () => {
      const expanded = header.getAttribute("aria-expanded") === "true";
      header.setAttribute("aria-expanded", String(!expanded));
    });

    section.appendChild(header);

    const body = document.createElement("div");
    body.className = "tag-notes-body md";
    setMarkdown(body, notes);
    section.appendChild(body);

    container.appendChild(section);
  }
}
