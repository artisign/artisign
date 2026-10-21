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
    <button class="btn-new-folder"></button>
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

describe("folder browser: + New folder", () => {
  const PARENT = "/Users/example/Workspace";
  let folders;
  let scrimEl;
  let openSectionEl;
  let initSectionEl;
  let dialogs;
  let posts;
  let postReply;

  beforeEach(async () => {
    folders = [{ name: "notes-app", isArtisignProject: true }, { name: "scratch", isArtisignProject: false }];
    posts = [];
    postReply = null;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body);
        posts.push(body);
        if (postReply) return postReply;
        folders.push({ name: body.name, isArtisignProject: false });
        folders.sort((a, b) => a.name.localeCompare(b.name));
        return { ok: true, status: 201, json: async () => ({ name: body.name, path: `${body.parent}/${body.name}` }) };
      }
      return {
        ok: true,
        json: async () => ({
          path: PARENT,
          parent: "/Users/example",
          home: HOME,
          entries: folders.map((f) => ({ ...f, path: `${PARENT}/${f.name}` })),
        }),
      };
    });
    scrimEl = document.createElement("div");
    openSectionEl = section(false);
    initSectionEl = section(true);
    dialogs = createProjectDialogs(
      { scrimEl, openSectionEl, initSectionEl },
      { onOpen: async () => ({ ok: true }), onInit: async () => ({ ok: true }) },
    );
    document.body.append(openSectionEl, initSectionEl);
    dialogs.showInitDialog();
    await settle();
  });

  afterEach(() => {
    openSectionEl.remove();
    initSectionEl.remove();
    delete globalThis.fetch;
  });

  async function typeAndCreate(sectionEl, name, via = "button") {
    sectionEl.querySelector(".btn-new-folder").click();
    const input = sectionEl.querySelector(".new-folder-input");
    input.value = name;
    input.dispatchEvent(new Event("input"));
    if (via === "enter") input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    else sectionEl.querySelector(".new-folder-create").click();
    await settle();
    await settle();
  }

  const rowNames = (sectionEl) => [...sectionEl.querySelectorAll(".dir-row-name")].map((n) => n.textContent);

  it("creates inside the shown folder and inserts the new folder alphabetically, badged and selected", async () => {
    await typeAndCreate(initSectionEl, "clients");

    expect(posts).toEqual([{ parent: PARENT, name: "clients" }]);
    expect(rowNames(initSectionEl)).toEqual(["clients", "notes-app", "scratch"]);
    const row = initSectionEl.querySelector(".dir-row-selected");
    expect(row.querySelector(".dir-row-name").textContent).toBe("clients");
    expect(row.querySelector(".dir-row-badge-new").textContent).toBe("new");
    expect(initSectionEl.querySelector(".new-folder-row")).toBeNull();
  });

  it("creates on Enter", async () => {
    await typeAndCreate(initSectionEl, "clients", "enter");

    expect(posts).toHaveLength(1);
    expect(rowNames(initSectionEl)).toContain("clients");
  });

  it("in open mode the new folder is highlighted but Open stays disabled", async () => {
    dialogs.showOpenDialog();
    await settle();
    await typeAndCreate(openSectionEl, "clients");

    expect(openSectionEl.querySelector(".dir-row-selected .dir-row-name").textContent).toBe("clients");
    expect(openSectionEl.querySelector(".btn-confirm").disabled).toBe(true);
  });

  it("Escape closes only the row, not the dialog", async () => {
    initSectionEl.querySelector(".btn-new-folder").click();
    const input = initSectionEl.querySelector(".new-folder-input");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(initSectionEl.querySelector(".new-folder-row")).toBeNull();
    expect(scrimEl.hidden).toBe(false);

    // A second Escape, now outside the row, closes the dialog.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(scrimEl.hidden).toBe(true);
  });

  it("Escape with focus on the row's Create or Cancel button closes only the row and refocuses + New folder", () => {
    initSectionEl.querySelector(".btn-new-folder").click();
    initSectionEl.querySelector(".new-folder-cancel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(initSectionEl.querySelector(".new-folder-row")).toBeNull();
    expect(scrimEl.hidden).toBe(false);
    expect(document.activeElement).toBe(initSectionEl.querySelector(".btn-new-folder"));
  });

  it("focuses the new row after a successful create", async () => {
    await typeAndCreate(initSectionEl, "clients");

    expect(document.activeElement).toBe(initSectionEl.querySelector(".dir-row-created"));
  });

  it("ignores a second Create while the request is in flight", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (init?.method === "POST") await gate;
      return base(url, init);
    });
    initSectionEl.querySelector(".btn-new-folder").click();
    const input = initSectionEl.querySelector(".new-folder-input");
    input.value = "clients";
    const create = initSectionEl.querySelector(".new-folder-create");
    create.click();
    create.click();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(create.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    release();
    await settle();
    await settle();

    expect(posts).toHaveLength(1);
  });

  it("init mode: after creating a folder, confirm scaffolds into that folder, not its parent", async () => {
    const onInit = vi.fn(async () => ({ ok: true }));
    initSectionEl.remove();
    initSectionEl = section(true);
    document.body.append(initSectionEl);
    dialogs = createProjectDialogs({ scrimEl, openSectionEl, initSectionEl }, { onOpen: async () => ({ ok: true }), onInit });
    dialogs.showInitDialog();
    await settle();
    await typeAndCreate(initSectionEl, "acme");

    expect(initSectionEl.querySelector(".selection-path").textContent).toBe("~/Workspace/acme");
    expect(initSectionEl.querySelector(".field-name-input").value).toBe("acme");
    initSectionEl.querySelector(".btn-confirm").click();
    await settle();

    expect(onInit).toHaveBeenCalledWith(`${PARENT}/acme`, "acme");
  });

  it("init mode: without a created folder the hint and the confirm target are <current>/<name>", async () => {
    const onInit = vi.fn(async () => ({ ok: true }));
    initSectionEl.remove();
    initSectionEl = section(true);
    document.body.append(initSectionEl);
    dialogs = createProjectDialogs({ scrimEl, openSectionEl, initSectionEl }, { onOpen: async () => ({ ok: true }), onInit });
    dialogs.showInitDialog();
    await settle();
    const name = initSectionEl.querySelector(".field-name-input");
    name.value = "proj";
    name.dispatchEvent(new Event("input"));

    expect(initSectionEl.querySelector(".selection-path").textContent).toBe("~/Workspace/proj");
    initSectionEl.querySelector(".btn-confirm").click();
    await settle();
    expect(onInit).toHaveBeenCalledWith(`${PARENT}/proj`, "proj");
  });

  it("Cancel closes the row without a request", () => {
    initSectionEl.querySelector(".btn-new-folder").click();
    initSectionEl.querySelector(".new-folder-cancel").click();

    expect(initSectionEl.querySelector(".new-folder-row")).toBeNull();
    expect(posts).toEqual([]);
  });

  it.each([
    ["already_exists", 409, "A folder named \u201Cscratch\u201D already exists here."],
    ["validation_failed", 400, "Folder names can\u2019t start with \u201C.\u201D, contain / or \\, or be empty."],
    ["permission_denied", 403, "Can\u2019t create a folder in Workspace: permission denied."],
  ])("shows the designed copy for %s and keeps the row open", async (code, status, copy) => {
    postReply = { ok: false, status, statusText: "x", json: async () => ({ code, message: "raw server text" }) };
    await typeAndCreate(initSectionEl, "scratch");

    const message = initSectionEl.querySelector(".new-folder-message");
    expect(message.hidden).toBe(false);
    expect(message.textContent).toBe(copy);
    expect(initSectionEl.querySelector(".new-folder-row-error")).not.toBeNull();

    const input = initSectionEl.querySelector(".new-folder-input");
    input.dispatchEvent(new Event("input"));
    expect(message.hidden).toBe(true);
  });
});
