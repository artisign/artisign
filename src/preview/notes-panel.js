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
 * @param {Set<string>} [expandedTags] — tags the reader has opened, mutated
 *   in place as they toggle, so the state survives the next re-render.
 */
export function renderTagNotes(container, screenTags, allTagNotes, expandedTags = new Set()) {
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
    // expand state and of every other tag section's. `expandedTags` carries
    // the reader's own choice across a re-render: this runs again on every
    // SSE screen event and on every keystroke in the sidebar filter, and a
    // spec that snapped shut while the agent wrote one line of HTML would be
    // unreadable in exactly the situation it exists for.
    const isExpanded = expandedTags.has(tag);
    header.setAttribute("aria-expanded", String(isExpanded));

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
      if (expanded) expandedTags.delete(tag);
      else expandedTags.add(tag);
    });

    section.appendChild(header);

    const body = document.createElement("div");
    body.className = "tag-notes-body md";
    setMarkdown(body, notes);
    section.appendChild(body);

    container.appendChild(section);
  }
}
