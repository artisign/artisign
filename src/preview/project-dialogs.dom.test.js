// @vitest-environment jsdom
//
// Breadcrumb ancestor chain of the shared folder browser. The
// browser is the only way to name an absolute path — there is no path input —
// so a chain that does not reach `/` makes every path outside the home tree
// unreachable. These tests drive the real module through a stubbed
// `/api/fs/dirs`, since fetchFsDirs (api.js) goes through global fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProjectDialogs } from "./project-dialogs.js";

const HOME = "/Users/example";

function section(withNameInput) {
  const el = document.createElement("div");
  el.innerHTML = `
    <button class="quick-chip" data-quick="home"></button>
    <button class="quick-chip" data-quick="workspace"></button>
    <div class="breadcrumbs"></div>
    <div class="dir-list"></div>
    <span class="selection-path"></span>
    <p class="dialog-error"></p>
    <button class="btn-confirm"></button>
    <button class="btn-cancel"></button>
    ${withNameInput ? '<input class="field-name-input" />' : ""}
  `;
  return el;
}

/** Serves any path as an existing, empty directory. */
function stubFs() {
  return vi.fn(async (url) => {
    const requested = new URL(url, "http://127.0.0.1").searchParams.get("path");
    return {
      ok: true,
      json: async () => ({ path: requested ?? HOME, parent: null, entries: [], home: HOME }),
    };
  });
}

/** Waits out the promise chain in loadPath (fetch + the ~/Workspace probe). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function crumbLabels(sectionEl) {
  return [...sectionEl.querySelectorAll(".breadcrumbs .crumb")].map((c) => c.textContent);
}

describe("folder browser breadcrumbs", () => {
  let openSectionEl;
  let initSectionEl;
  let dialogs;

  beforeEach(async () => {
    globalThis.fetch = stubFs();
    openSectionEl = section(false);
    initSectionEl = section(true);
    dialogs = createProjectDialogs(
      { scrimEl: document.createElement("div"), openSectionEl, initSectionEl },
      { onOpen: async () => ({ ok: true }), onInit: async () => ({ ok: true }) },
    );
    dialogs.showOpenDialog();
    await settle();
  });

  afterEach(() => {
    delete globalThis.fetch;
  });

  it("starts the ancestor chain at the filesystem root, not at the first segment", () => {
    expect(crumbLabels(openSectionEl)).toEqual(["/", "Users", "example"]);
  });

  it("makes every ancestor clickable and only the current segment inert", () => {
    const crumbs = [...openSectionEl.querySelectorAll(".breadcrumbs .crumb")];
    expect(crumbs.map((c) => c.classList.contains("crumb-current"))).toEqual([false, false, true]);
  });

  it("navigates to / from the root crumb, so paths outside the home tree are reachable", async () => {
    openSectionEl.querySelector(".breadcrumbs .crumb").click();
    await settle();

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/fs/dirs?path=%2F");
    // At the root the chain is a single, current crumb — nothing above it.
    expect(crumbLabels(openSectionEl)).toEqual(["/"]);
  });

  it("reaches a path outside the home tree by clicking down from the root", async () => {
    // From "/" the listing offers /private, the ancestor of the eval projects
    // under /private/tmp that were unreachable before the root ancestor chain fix.
    const tree = { "/": ["private"], "/private": ["tmp"], "/private/tmp": [] };
    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url, "http://127.0.0.1").searchParams.get("path") ?? HOME;
      const entries = (tree[path] ?? []).map((name) => ({
        name,
        path: path === "/" ? `/${name}` : `${path}/${name}`,
        isArtisignProject: false,
      }));
      return { ok: true, json: async () => ({ path, parent: null, entries, home: HOME }) };
    });

    openSectionEl.querySelector(".breadcrumbs .crumb").click();
    await settle();
    openSectionEl.querySelector(".dir-row-navigable").click();
    await settle();
    openSectionEl.querySelector(".dir-row-navigable").click();
    await settle();

    expect(crumbLabels(openSectionEl)).toEqual(["/", "private", "tmp"]);
  });

  it("separates only the path segments, never right after the root crumb", () => {
    expect(openSectionEl.querySelectorAll(".breadcrumbs .crumb-sep")).toHaveLength(1);
  });

  it("does not double the slash in the init hint at the filesystem root", async () => {
    dialogs.showInitDialog();
    await settle();
    initSectionEl.querySelector(".breadcrumbs .crumb").click();
    await settle();

    const nameInput = initSectionEl.querySelector(".field-name-input");
    nameInput.value = "my-project";
    nameInput.dispatchEvent(new Event("input"));

    expect(initSectionEl.querySelector(".selection-path").textContent).toBe("/my-project");
  });
});
