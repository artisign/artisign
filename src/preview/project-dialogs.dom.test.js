// @vitest-environment jsdom
//
// The folder browser of the open / new-project dialogs (CHR-1272: native modal <dialog>s in the floating look; the markup is the real one from index.html). The browser is the only way to name an absolute path — there is no path input — so the breadcrumb chain must reach `/`, or every path outside the home tree is unreachable. These tests drive the real module through a stubbed `/api/fs/dirs`, since fetchFsDirs (api.js) goes through global fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProjectDialogs } from "./project-dialogs.js";
import { installDialogStubs, pressEscape, clickScrim } from "./dialog-stub.test-helper.js";
import { mountProjectDialogs } from "./project-dialogs.test-helper.js";

const HOME = "/Users/example";

/** Waits out the promise chain in loadPath (fetch + the ~/Workspace probe). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const crumbLabels = (el) => [...el.querySelectorAll(".breadcrumb-list .crumb-item")].map((c) => c.textContent);
const hintText = (el) => el.querySelector(".selection-hint").textContent;
const rowNames = (el) => [...el.querySelectorAll(".dir-row-name")].map((n) => n.textContent);

let openEl;
let initEl;
let dialogs;

function create(callbacks = {}) {
  ({ openEl, initEl } = mountProjectDialogs());
  dialogs = createProjectDialogs({ openDialogEl: openEl, initDialogEl: initEl }, { onOpen: async () => ({ ok: true }), onInit: async () => ({ ok: true }), ...callbacks });
}

/** Serves any path as an existing, empty directory. */
function stubFs() {
  return vi.fn(async (url) => {
    const requested = new URL(url, "http://127.0.0.1").searchParams.get("path");
    return { ok: true, json: async () => ({ path: requested ?? HOME, parent: null, entries: [], home: HOME }) };
  });
}

beforeEach(() => {
  installDialogStubs();
  document.body.innerHTML = "";
});
afterEach(() => {
  delete globalThis.fetch;
});

describe("folder browser breadcrumbs", () => {
  beforeEach(async () => {
    globalThis.fetch = stubFs();
    create();
    dialogs.showOpenDialog();
    await settle();
  });

  it("is a nav with an ordered list of crumbs; the ancestor chain starts at the filesystem root", () => {
    expect(openEl.querySelector("nav.breadcrumbs").getAttribute("aria-label")).toBe("Folder path");
    expect(openEl.querySelector("nav.breadcrumbs > ol.breadcrumb-list")).not.toBeNull();
    expect(crumbLabels(openEl)).toEqual(["/", "Users", "example"]);
  });

  it("makes every ancestor a button and only the current segment plain text marked aria-current", () => {
    const items = [...openEl.querySelectorAll(".crumb-item")];
    expect(items.map((i) => i.querySelector("button.crumb") !== null)).toEqual([true, true, false]);
    expect(items.map((i) => i.getAttribute("aria-current"))).toEqual([null, null, "location"]);
  });

  it("navigates to / from the root crumb, so paths outside the home tree are reachable", async () => {
    openEl.querySelector(".crumb").click();
    await settle();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/fs/dirs?path=%2F");
    // At the root the chain is a single, current crumb — nothing above it.
    expect(crumbLabels(openEl)).toEqual(["/"]);
  });

  it("reaches a path outside the home tree by clicking down from the root", async () => {
    const tree = { "/": ["private"], "/private": ["tmp"], "/private/tmp": [] };
    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url, "http://127.0.0.1").searchParams.get("path") ?? HOME;
      const entries = (tree[path] ?? []).map((name) => ({ name, path: path === "/" ? `/${name}` : `${path}/${name}`, isArtisignProject: false }));
      return { ok: true, json: async () => ({ path, parent: null, entries, home: HOME }) };
    });
    openEl.querySelector(".crumb").click();
    await settle();
    openEl.querySelector(".dir-row.is-actionable").click();
    await settle();
    openEl.querySelector(".dir-row.is-actionable").click();
    await settle();
    expect(crumbLabels(openEl)).toEqual(["/", "private", "tmp"]);
  });

  it("puts a separator only between path segments, never right after the root crumb", () => {
    expect(openEl.querySelectorAll(".crumb-item--sep")).toHaveLength(1);
    expect(openEl.querySelector(".breadcrumb-list").textContent).not.toMatch(/chevron/); // the chevron is CSS, not a node
  });

  it("does not double the slash in the New project hint at the filesystem root", async () => {
    dialogs.showInitDialog();
    await settle();
    initEl.querySelector(".crumb").click();
    await settle();
    const nameInput = initEl.querySelector(".text-field-input");
    nameInput.value = "my-project";
    nameInput.dispatchEvent(new Event("input"));
    expect(hintText(initEl)).toBe("Will create: /my-project");
    expect(initEl.querySelector(".selection-path").textContent).toBe("my-project");
  });
});

describe("the dialogs", () => {
  beforeEach(() => {
    globalThis.fetch = stubFs();
    create();
  });

  it("are native <dialog>s named by their h1 and described by the sub line, with closedby=any", () => {
    for (const [el, title, sub] of [[openEl, "Open project", "Pick the folder that holds the project."], [initEl, "New project", "Choose where the new project folder is created."]]) {
      expect(el.tagName).toBe("DIALOG");
      expect(el.getAttribute("closedby")).toBe("any");
      expect(document.getElementById(el.getAttribute("aria-labelledby")).textContent).toBe(title);
      expect(document.getElementById(el.getAttribute("aria-describedby")).textContent).toBe(sub);
      expect(el.querySelector("h1").textContent).toBe(title);
    }
  });

  it("show as modal dialogs: one at a time, showModal() not show()", async () => {
    dialogs.showOpenDialog();
    expect(openEl.open).toBe(true);
    expect(openEl.hasAttribute("data-modal")).toBe(true);
    expect(initEl.open).toBe(false);
    await settle();
  });

  it("have the design's footers: Cancel and Open / Create & open, the confirm off until it can act", async () => {
    dialogs.showOpenDialog();
    await settle();
    expect([...openEl.querySelectorAll("footer button")].map((b) => b.textContent)).toEqual(["Cancel", "Open"]);
    expect(openEl.querySelector(".btn-confirm").disabled).toBe(true);
    dialogs.hide();
    dialogs.showInitDialog();
    await settle();
    expect([...initEl.querySelectorAll("footer button")].map((b) => b.textContent)).toEqual(["Cancel", "Create & open"]);
    expect(initEl.querySelector(".btn-confirm").disabled).toBe(true);
  });

  it("offer Places as a labelled group of toggle chips and the folder tray as a labelled listbox", async () => {
    dialogs.showOpenDialog();
    await settle();
    expect(openEl.querySelector(".quick-access").getAttribute("role")).toBe("group");
    expect(openEl.querySelector(".quick-access").getAttribute("aria-label")).toBe("Places");
    expect([...openEl.querySelectorAll(".quick-chip")].map((c) => c.textContent.replace(/^[a-z_]+/, ""))).toEqual(["Home", "Workspace", "Desktop"]);
    expect([...openEl.querySelectorAll(".quick-chip")].map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]); // Home is where it starts
    expect(openEl.querySelector(".dir-list").getAttribute("role")).toBe("listbox");
  });
});

describe("folder list: options, badges, selection", () => {
  const PARENT = "/Users/example/Workspace";
  let folders;

  beforeEach(async () => {
    folders = [{ name: "alpha", isArtisignProject: false }, { name: "notes-app", isArtisignProject: true }, { name: "scratch", isArtisignProject: false }];
    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url, "http://127.0.0.1").searchParams.get("path") ?? PARENT;
      return { ok: true, json: async () => ({ path, parent: null, home: HOME, entries: folders.map((f) => ({ ...f, path: `${path}/${f.name}` })) }) };
    });
    create();
  });

  it("every folder is an option; a project folder carries the Project badge and is selected by activating it (Open mode)", async () => {
    dialogs.showOpenDialog();
    await settle();
    const rows = [...openEl.querySelectorAll(".dir-row")];
    expect(rows.every((r) => r.getAttribute("role") === "option")).toBe(true);
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "false", "false"]);
    expect(rows[1].querySelector(".dir-row-badge").textContent).toBe("deployed_codeProject");
    expect(openEl.querySelector(".dir-list").getAttribute("aria-label")).toBe("Folders in Workspace");
    expect(hintText(openEl)).toBe("Selected: ~/Workspace. No project here yet.");
    expect(openEl.querySelector(".btn-confirm").disabled).toBe(true);

    rows[1].click();
    const picked = openEl.querySelectorAll(".dir-row")[1];
    expect(picked.getAttribute("aria-selected")).toBe("true");
    expect(hintText(openEl)).toBe("Selected: ~/Workspace/notes-app. Folders that already hold a project carry the Project badge.");
    expect(openEl.querySelector(".btn-confirm").disabled).toBe(false);
  });

  it("Open confirms the selected project and closes the dialog", async () => {
    const onOpen = vi.fn(async () => ({ ok: true }));
    document.body.innerHTML = "";
    create({ onOpen });
    dialogs.showOpenDialog();
    await settle();
    openEl.querySelectorAll(".dir-row")[1].click();
    openEl.querySelector(".btn-confirm").click();
    await settle();
    expect(onOpen).toHaveBeenCalledWith(`${PARENT}/notes-app`);
    expect(openEl.open).toBe(false);
  });

  it("New project: a project folder is inert (aria-disabled), another folder is entered", async () => {
    dialogs.showInitDialog();
    await settle();
    const rows = [...initEl.querySelectorAll(".dir-row")];
    expect(rows.map((r) => r.getAttribute("aria-disabled"))).toEqual([null, "true", null]);
    rows[1].click();
    await settle();
    expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent(`${PARENT}/notes-app`)));
    rows[0].click();
    await settle();
    expect(globalThis.fetch).toHaveBeenLastCalledWith(expect.stringContaining(encodeURIComponent(`${PARENT}/alpha`)));
  });

  it("an empty folder says so outside the listbox", async () => {
    folders = [];
    dialogs.showOpenDialog();
    await settle();
    expect(openEl.querySelector(".dir-list").hidden).toBe(true);
    expect(openEl.querySelector(".dir-list-empty").hidden).toBe(false);
    expect(openEl.querySelector(".dir-list-empty").textContent).toBe("No subfolders.");
    expect(openEl.querySelector(".dir-list-empty").closest('[role="listbox"]')).toBeNull();
  });

  it("the name field shows the placeholder path in the hint while empty, and the typed name in strong", async () => {
    dialogs.showInitDialog();
    await settle();
    expect(initEl.querySelector(".text-field-label").textContent).toBe("Project name");
    expect(initEl.querySelector(".text-field-input").placeholder).toBe("my-new-project");
    expect(initEl.querySelector(".text-field-input").getAttribute("aria-describedby")).toBe(initEl.querySelector(".text-field-hint").id);
    expect(hintText(initEl)).toBe("Will create: ~/Workspace/my-new-project");
    expect(initEl.querySelector(".selection-path")).toBeNull();
    const input = initEl.querySelector(".text-field-input");
    input.value = "acme";
    input.dispatchEvent(new Event("input"));
    expect(hintText(initEl)).toBe("Will create: ~/Workspace/acme");
    expect(initEl.querySelector(".selection-path").textContent).toBe("acme");
    expect(initEl.querySelector(".btn-confirm").disabled).toBe(false);
  });
});

describe("folder browser: New folder", () => {
  const PARENT = "/Users/example/Workspace";
  let folders;
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
      return { ok: true, json: async () => ({ path: PARENT, parent: "/Users/example", home: HOME, entries: folders.map((f) => ({ ...f, path: `${PARENT}/${f.name}` })) }) };
    });
    create();
    dialogs.showInitDialog();
    await settle();
  });

  async function typeAndCreate(el, name, via = "button") {
    el.querySelector(".btn-new-folder").click();
    const input = el.querySelector(".new-folder-input");
    input.value = name;
    input.dispatchEvent(new Event("input"));
    if (via === "enter") input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    else el.querySelector(".new-folder-create").click();
    await settle();
    await settle();
  }

  it("the button toggles an inline row outside the listbox, aria-expanded follows, a second press folds it", () => {
    const button = initEl.querySelector(".btn-new-folder");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    button.click();
    const row = initEl.querySelector(".new-folder-row");
    expect(row).not.toBeNull();
    expect(row.closest('[role="listbox"]')).toBeNull();
    expect(row.nextElementSibling).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(row.querySelector("input").getAttribute("aria-label")).toBe("New folder name");
    expect([...row.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Create", "Cancel"]);
    expect(document.activeElement).toBe(row.querySelector("input"));
    button.click();
    expect(initEl.querySelector(".new-folder-row")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("creates inside the shown folder and inserts the new folder alphabetically, selected and marked Created", async () => {
    await typeAndCreate(initEl, "clients");
    expect(posts).toEqual([{ parent: PARENT, name: "clients" }]);
    expect(rowNames(initEl)).toEqual(["clients", "notes-app", "scratch"]);
    const row = initEl.querySelector(".dir-row.is-selected");
    expect(row.querySelector(".dir-row-name").textContent).toBe("clients");
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.querySelector(".dir-row-badge--created").textContent).toBe("checkCreated");
    expect(initEl.querySelector(".new-folder-row")).toBeNull();
  });

  it("creates on Enter", async () => {
    await typeAndCreate(initEl, "clients", "enter");
    expect(posts).toHaveLength(1);
    expect(rowNames(initEl)).toContain("clients");
  });

  it("in Open mode the new folder is highlighted but Open stays disabled, and the hint says what to do", async () => {
    dialogs.hide();
    dialogs.showOpenDialog();
    await settle();
    await typeAndCreate(openEl, "clients");
    expect(openEl.querySelector(".dir-row.is-selected .dir-row-name").textContent).toBe("clients");
    expect(openEl.querySelector(".btn-confirm").disabled).toBe(true);
    expect(hintText(openEl)).toBe("Selected: ~/Workspace/clients. No project here yet. Browse into a folder that holds one, or create a project from the empty state.");
  });

  it("Escape closes only the row, not the dialog (the browser's own close is prevented)", () => {
    initEl.querySelector(".btn-new-folder").click();
    const input = initEl.querySelector(".new-folder-input");
    const evt = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true); // a prevented keydown keeps the browser from closing the dialog
    expect(initEl.querySelector(".new-folder-row")).toBeNull();
    expect(initEl.open).toBe(true);
    // A second Escape, now outside the row, closes the dialog.
    expect(pressEscape(initEl)).toBe(true);
    expect(initEl.open).toBe(false);
  });

  it("Escape with focus on the row's Create or Cancel button closes only the row and refocuses New folder", () => {
    initEl.querySelector(".btn-new-folder").click();
    initEl.querySelector(".new-folder-cancel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(initEl.querySelector(".new-folder-row")).toBeNull();
    expect(initEl.open).toBe(true);
    expect(document.activeElement).toBe(initEl.querySelector(".btn-new-folder"));
  });

  it("focuses the new row after a successful create", async () => {
    await typeAndCreate(initEl, "clients");
    expect(document.activeElement).toBe(initEl.querySelector(".dir-row.is-created"));
  });

  it("keeps Enter and Space on the just-created row from navigating into it", async () => {
    await typeAndCreate(initEl, "clients");
    const row = initEl.querySelector(".dir-row.is-created");
    for (const [type, key] of [["keydown", "Enter"], ["keyup", " "], ["keydown", " "]]) {
      const evt = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
      row.dispatchEvent(evt);
      expect(evt.defaultPrevented).toBe(true);
    }
    const other = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    row.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it("ignores a second Create while the request is in flight", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (init?.method === "POST") await gate;
      return base(url, init);
    });
    initEl.querySelector(".btn-new-folder").click();
    const input = initEl.querySelector(".new-folder-input");
    input.value = "clients";
    const createButton = initEl.querySelector(".new-folder-create");
    createButton.click();
    createButton.click();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(createButton.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    release();
    await settle();
    await settle();
    expect(posts).toHaveLength(1);
  });

  it("New project: the created folder is the parent of the new project — confirm scaffolds into <folder>/<name>", async () => {
    const onInit = vi.fn(async () => ({ ok: true }));
    document.body.innerHTML = "";
    create({ onInit });
    dialogs.showInitDialog();
    await settle();
    await typeAndCreate(initEl, "clients");
    const name = initEl.querySelector(".text-field-input");
    expect(name.value).toBe("");
    name.value = "acme";
    name.dispatchEvent(new Event("input"));
    expect(hintText(initEl)).toBe("Will create: ~/Workspace/clients/acme");
    initEl.querySelector(".btn-confirm").click();
    await settle();
    expect(onInit).toHaveBeenCalledWith(`${PARENT}/clients/acme`, "acme");
  });

  it("New project: without a created folder the hint and the confirm target are <current>/<name>", async () => {
    const onInit = vi.fn(async () => ({ ok: true }));
    document.body.innerHTML = "";
    create({ onInit });
    dialogs.showInitDialog();
    await settle();
    const name = initEl.querySelector(".text-field-input");
    name.value = "proj";
    name.dispatchEvent(new Event("input"));
    expect(hintText(initEl)).toBe("Will create: ~/Workspace/proj");
    initEl.querySelector(".btn-confirm").click();
    await settle();
    expect(onInit).toHaveBeenCalledWith(`${PARENT}/proj`, "proj");
  });

  it("Cancel closes the row without a request", () => {
    initEl.querySelector(".btn-new-folder").click();
    initEl.querySelector(".new-folder-cancel").click();
    expect(initEl.querySelector(".new-folder-row")).toBeNull();
    expect(posts).toEqual([]);
  });

  it.each([
    ["already_exists", 409, "scratch", "A folder named “scratch” already exists here."],
    ["validation_failed", 400, "clients/2026", "Folder names can’t contain / or \\ and can’t be empty, “.” or “..”."],
    ["permission_denied", 403, "clients", "Can’t create a folder in Workspace: permission denied."],
  ])("shows the designed copy for %s, marks the field invalid and described, and keeps the row open", async (code, status, name, copy) => {
    postReply = { ok: false, status, statusText: "x", json: async () => ({ code, message: "raw server text" }) };
    await typeAndCreate(initEl, name);
    const message = initEl.querySelector(".new-folder-message");
    const input = initEl.querySelector(".new-folder-input");
    expect(message.hidden).toBe(false);
    expect(message.textContent).toBe(`error${copy}`);
    expect(initEl.querySelector(".new-folder-row.is-error")).not.toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(message.id);
    expect(input.disabled).toBe(false); // never stuck
    expect(document.activeElement).toBe(input);
    expect(initEl.querySelector(".new-folder-create").disabled).toBe(false);

    input.dispatchEvent(new Event("input"));
    expect(message.hidden).toBe(true);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(input.hasAttribute("aria-describedby")).toBe(false);
  });

  it("a request that breaks says so in the row, and the controls come back", async () => {
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (init?.method === "POST") throw new Error("network down");
      return base(url, init);
    });
    await typeAndCreate(initEl, "clients");
    expect(initEl.querySelector(".new-folder-message").textContent).toBe("errornetwork down");
    expect(initEl.querySelector(".new-folder-input").disabled).toBe(false);
    expect(initEl.querySelector(".new-folder-create").disabled).toBe(false);
  });
});

describe("confirming an open / init: async, visible errors, never stuck", () => {
  const PARENT = "/Users/example/Workspace";

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url, "http://127.0.0.1").searchParams.get("path") ?? PARENT;
      return { ok: true, json: async () => ({ path, parent: null, home: HOME, entries: [{ name: "notes-app", path: `${path}/notes-app`, isArtisignProject: true }] }) };
    });
  });

  async function openWith(onOpen) {
    create({ onOpen });
    dialogs.showOpenDialog();
    await settle();
    openEl.querySelector(".dir-row").click();
  }

  it("a refused open shows the server's message in an alert, keeps the dialog and enables Open again", async () => {
    await openWith(async () => ({ ok: false, message: "That folder is no longer a project." }));
    openEl.querySelector(".btn-confirm").click();
    await settle();
    const error = openEl.querySelector(".dialog-error");
    expect(error.hidden).toBe(false);
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe("That folder is no longer a project.");
    expect(openEl.open).toBe(true);
    expect(openEl.querySelector(".btn-confirm").disabled).toBe(false);
  });

  it("a request that throws says so and the button comes back", async () => {
    await openWith(async () => {
      throw new Error("daemon gone");
    });
    openEl.querySelector(".btn-confirm").click();
    await settle();
    expect(openEl.querySelector(".dialog-error").textContent).toBe("daemon gone");
    expect(openEl.querySelector(".btn-confirm").disabled).toBe(false);
  });

  it("the button is off while the request runs, and a second press does not send a second request", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const onOpen = vi.fn(async () => {
      await gate;
      return { ok: true };
    });
    await openWith(onOpen);
    const confirm = openEl.querySelector(".btn-confirm");
    confirm.click();
    confirm.click();
    expect(confirm.disabled).toBe(true);
    release();
    await settle();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(openEl.open).toBe(false);
  });

  it("an unreadable folder listing is said in the dialog instead of leaving it blank", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("daemon gone");
    });
    create();
    dialogs.showOpenDialog();
    await settle();
    expect(openEl.querySelector(".dialog-error").textContent).toBe("daemon gone");
  });
});

describe("a confirm that outlives its dialog session", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url, "http://127.0.0.1").searchParams.get("path") ?? HOME;
      return { ok: true, json: async () => ({ path, parent: null, home: HOME, entries: [{ name: "notes-app", path: `${path}/notes-app`, isArtisignProject: true }] }) };
    });
  });

  async function pending(outcome) {
    let release;
    const gate = new Promise((r) => (release = r));
    create({ onOpen: async () => (await gate, outcome()) });
    dialogs.showOpenDialog();
    await settle();
    openEl.querySelector(".dir-row").click();
    openEl.querySelector(".btn-confirm").click();
    return release;
  }

  it("a success that arrives after close and reopen does not close the new session", async () => {
    const release = await pending(() => ({ ok: true }));
    dialogs.hide();
    dialogs.showOpenDialog();
    await settle();
    release();
    await settle();
    expect(openEl.open).toBe(true);
  });

  it("an error that arrives after close and reopen paints nothing and leaves the new session's button alone", async () => {
    const release = await pending(() => ({ ok: false, message: "old failure" }));
    dialogs.hide();
    dialogs.showOpenDialog();
    await settle();
    openEl.querySelector(".dir-row").click(); // the new session picks its own project
    release();
    await settle();
    expect(openEl.querySelector(".dialog-error").hidden).toBe(true);
    expect(openEl.querySelector(".btn-confirm").disabled).toBe(false);
  });
});

describe("closing: state resets, nothing stale stays", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url, "http://127.0.0.1").searchParams.get("path") ?? HOME;
      return { ok: true, json: async () => ({ path, parent: null, home: HOME, entries: [{ name: "plain", path: `${path}/plain`, isArtisignProject: false }] }) };
    });
    create();
  });

  it.each([
    ["Cancel", () => openEl.querySelector(".btn-cancel").click()],
    ["the close button", () => openEl.querySelector(".dialog-close").click()],
    ["the scrim", () => clickScrim(openEl)],
    ["Escape (the first closes the open new-folder row, the second the dialog)", () => (pressEscape(openEl), pressEscape(openEl))],
  ])("%s closes it and clears the folders, the hint, the error and the new-folder row", async (_name, close) => {
    dialogs.showOpenDialog();
    await settle();
    openEl.querySelector(".btn-new-folder").click();
    openEl.querySelector(".dialog-error").textContent = "x";
    openEl.querySelector(".dialog-error").hidden = false;
    close();
    expect(openEl.open).toBe(false);
    expect(openEl.querySelectorAll(".dir-row")).toHaveLength(0);
    expect(openEl.querySelector(".new-folder-row")).toBeNull();
    expect(openEl.querySelector(".dialog-error").hidden).toBe(true);
    expect(hintText(openEl)).toBe("");
    expect(openEl.querySelector(".breadcrumb-list").children).toHaveLength(0);
  });

  it("the New project name is dropped on close", async () => {
    dialogs.showInitDialog();
    await settle();
    const name = initEl.querySelector(".text-field-input");
    name.value = "acme";
    name.dispatchEvent(new Event("input"));
    pressEscape(initEl);
    expect(name.value).toBe("");
    dialogs.showInitDialog();
    await settle();
    expect(hintText(initEl)).toBe("Will create: ~/my-new-project");
  });

  it("a folder listing that arrives after the dialog was closed paints nothing", async () => {
    let finish;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => (finish = () => resolve({ ok: true, json: async () => ({ path: HOME, parent: null, home: HOME, entries: [{ name: "late", path: `${HOME}/late`, isArtisignProject: false }] }) }))));
    dialogs.showOpenDialog();
    dialogs.hide();
    finish();
    await settle();
    await settle();
    expect(openEl.querySelectorAll(".dir-row")).toHaveLength(0);
  });
});

describe("light dismiss", () => {
  beforeEach(() => {
    globalThis.fetch = stubFs();
  });

  it("without closedby support a click on the scrim closes the dialog, a click inside does not", async () => {
    create();
    dialogs.showOpenDialog();
    await settle();
    openEl.querySelector(".dir-tray").click();
    expect(openEl.open).toBe(true);
    clickScrim(openEl);
    expect(openEl.open).toBe(false);
  });

  it("a text-selection drag that starts inside and ends on the scrim does not dismiss", async () => {
    create();
    dialogs.showOpenDialog();
    await settle();
    openEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100 }); // jsdom does no layout: a box to be inside of
    openEl.querySelector(".dir-tray").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    openEl.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: -10, clientY: -10 }));
    expect(openEl.open).toBe(true);
  });

  it("with native closedby the browser does it: this code adds no scrim handler of its own", async () => {
    ({ openEl, initEl } = mountProjectDialogs());
    openEl.closedBy = "any";
    initEl.closedBy = "any";
    dialogs = createProjectDialogs({ openDialogEl: openEl, initDialogEl: initEl }, { onOpen: async () => ({ ok: true }), onInit: async () => ({ ok: true }) });
    dialogs.showOpenDialog();
    await settle();
    clickScrim(openEl);
    expect(openEl.open).toBe(true); // the browser's light dismiss, not ours, would have closed it
  });
});
