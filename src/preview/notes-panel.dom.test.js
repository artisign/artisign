// @vitest-environment jsdom
//
// Smoke tests for renderTagNotes's DOM output — structure, aria state and
// click wiring only. Mirrors mockups.dom.test.js.
import { describe, it, expect } from "vitest";
import { renderTagNotes } from "./notes-panel.js";

describe("renderTagNotes", () => {
  const allTagNotes = [
    { tag: "chr-244", notes: "spec lives here" },
    { tag: "release-1", notes: "launch checklist" },
  ];

  it("renders one section per screen tag that has notes, in allTagNotes order", () => {
    const container = document.createElement("div");
    renderTagNotes(container, ["chr-244", "release-1"], allTagNotes);

    const sections = container.querySelectorAll(".tag-notes-section");
    expect(sections).toHaveLength(2);
    expect([...sections].map((s) => s.querySelector(".tag-notes-title").textContent)).toEqual(["chr-244", "release-1"]);
  });

  it("only renders sections for tags the screen actually carries", () => {
    const container = document.createElement("div");
    renderTagNotes(container, ["chr-244"], allTagNotes);

    const sections = container.querySelectorAll(".tag-notes-section");
    expect(sections).toHaveLength(1);
    expect(sections[0].querySelector(".tag-notes-title").textContent).toBe("chr-244");
  });

  it("matches screen tags case-insensitively", () => {
    const container = document.createElement("div");
    renderTagNotes(container, ["CHR-244"], allTagNotes);

    expect(container.querySelectorAll(".tag-notes-section")).toHaveLength(1);
  });

  it("renders no sections for a screen with no tags, or when no matching tag has notes", () => {
    const container = document.createElement("div");
    renderTagNotes(container, [], allTagNotes);
    expect(container.querySelectorAll(".tag-notes-section")).toHaveLength(0);

    renderTagNotes(container, ["untagged-elsewhere"], allTagNotes);
    expect(container.querySelectorAll(".tag-notes-section")).toHaveLength(0);
  });

  it("renders each section collapsed by default", () => {
    const container = document.createElement("div");
    renderTagNotes(container, ["chr-244"], allTagNotes);

    const header = container.querySelector(".tag-notes-header");
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles a section's own aria-expanded on header click, independently of other sections", () => {
    const container = document.createElement("div");
    renderTagNotes(container, ["chr-244", "release-1"], allTagNotes);

    const [first, second] = container.querySelectorAll(".tag-notes-header");
    first.click();
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(second.getAttribute("aria-expanded")).toBe("false");

    first.click();
    expect(first.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the notes body as Markdown via setMarkdown", () => {
    const container = document.createElement("div");
    renderTagNotes(container, ["chr-244"], [{ tag: "chr-244", notes: "# Heading\n\nbody text" }]);

    const body = container.querySelector(".tag-notes-body");
    expect(body.querySelector("h3").textContent).toBe("Heading");
    expect(body.textContent).toContain("body text");
  });

  it("clears previous content on re-render", () => {
    const container = document.createElement("div");
    renderTagNotes(container, ["chr-244", "release-1"], allTagNotes);
    renderTagNotes(container, ["chr-244"], allTagNotes);
    expect(container.querySelectorAll(".tag-notes-section")).toHaveLength(1);
  });
});

describe("renderTagNotes — expand state across re-renders (CHR-596)", () => {
  const allTagNotes = [{ tag: "chr-244", notes: "spec lives here" }];

  it("keeps a section the reader opened open when the panel re-renders", () => {
    // updateNotesPanel runs again on every SSE screen event and on every
    // sidebar filter keystroke — a spec must not snap shut mid-read.
    const container = document.createElement("div");
    const expanded = new Set();
    renderTagNotes(container, ["chr-244"], allTagNotes, expanded);
    container.querySelector(".tag-notes-header").click();
    expect(container.querySelector(".tag-notes-header").getAttribute("aria-expanded")).toBe("true");
    expect([...expanded]).toEqual(["chr-244"]);

    renderTagNotes(container, ["chr-244"], allTagNotes, expanded);
    expect(container.querySelector(".tag-notes-header").getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses again on a second click, and stays collapsed across a re-render", () => {
    const container = document.createElement("div");
    const expanded = new Set();
    renderTagNotes(container, ["chr-244"], allTagNotes, expanded);
    container.querySelector(".tag-notes-header").click();
    container.querySelector(".tag-notes-header").click();
    expect([...expanded]).toEqual([]);
    renderTagNotes(container, ["chr-244"], allTagNotes, expanded);
    expect(container.querySelector(".tag-notes-header").getAttribute("aria-expanded")).toBe("false");
  });
});
