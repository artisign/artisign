// @vitest-environment jsdom
//
// CHR-775 — the project picker is tab-local: the real index.html body, the
// real modules, a stubbed daemon (fetch + EventSource). The daemon's
// `active` is only the default for a fresh tab; it must never drag a tab.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import html from "./index.html?raw";

const bodyHtml = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf('<script type="module"'));

let calls;
let sources;
let projects;

const memoryStorage = new Map();
const storageStub = {
  getItem: (k) => memoryStorage.get(k) ?? null,
  setItem: (k, v) => void memoryStorage.set(k, String(v)),
  removeItem: (k) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
};

function stubDaemon() {
  vi.stubGlobal("localStorage", storageStub);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storageStub });
  calls = [];
  sources = [];
  vi.stubGlobal(
    "EventSource",
    class {
      constructor(url) {
        this.url = url;
        this.closed = false;
        sources.push(this);
      }
      close() {
        this.closed = true;
      }
    },
  );
  vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  vi.stubGlobal("CSS", { escape: (s) => s });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const path = String(url).split("?")[0];
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (path === "/api/projects") return json(projects);
    if (path === "/api/projects/open") {
      projects = { active: "/r", open: [...projects.open, { root: "/r", name: "gamma" }], recent: [] };
      return json(projects);
    }
    if (path === "/api/screens") return json({ screens: [] });
    if (path === "/api/board-state") return json({ filter: null, pinned: [], expanded: [] });
    if (path === "/api/mockups") return json({ mockups: [] });
    if (path === "/api/tags") return json({ tags: [] });
    if (path === "/api/flows") return json({ flows: [] });
    if (path === "/api/comments") return json({ comments: [] });
    throw new Error(`unstubbed ${init?.method ?? "GET"} ${url}`);
  });
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (sel) => document.querySelector(sel);
const liveSource = () => sources.filter((s) => !s.closed).at(-1);
const emit = (source, event) => source.onmessage({ data: JSON.stringify(event) });
const pickerName = () => $("#project-picker-name").textContent;
const menuRow = (name) => [...document.querySelectorAll("#menu-open-list .menu-item")].find((r) => r.textContent.includes(name));

async function boot() {
  await import("./app.js");
  await flush();
}

beforeEach(() => {
  memoryStorage.clear();
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  projects = {
    active: "/p",
    open: [
      { root: "/p", name: "alpha" },
      { root: "/q", name: "beta" },
    ],
    recent: [],
  };
  stubDaemon();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("project picker is tab-local (CHR-775)", () => {
  it("switching in the picker changes this tab only and never activates on the daemon", async () => {
    await boot();
    expect(liveSource().url).toBe("/events?project=%2Fp");

    menuRow("beta").click();
    await flush();

    expect(calls.some((c) => c.includes("activate"))).toBe(false);
    expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
    expect(liveSource().url).toBe("/events?project=%2Fq");
    expect(pickerName()).toBe("beta");
    expect(calls).toContain("GET /api/screens?project=%2Fq");
  });

  it("ignores project-switched: another tab's choice does not move this one", async () => {
    await boot();
    const before = sources.length;
    const callsBefore = calls.length;
    projects = { ...projects, active: "/q" }; // the daemon default moved, e.g. because of another tab

    emit(liveSource(), { type: "project-switched", root: "/q" });
    await flush();

    expect(sources.length).toBe(before);
    expect(liveSource().url).toBe("/events?project=%2Fp");
    expect(pickerName()).toBe("alpha");
    expect(calls.slice(callsBefore).some((c) => c.includes("/api/screens"))).toBe(false);
  });

  it("project-closed moves the tab only when its own project closed", async () => {
    await boot();
    menuRow("beta").click(); // tab shows /q
    await flush();

    projects = { active: "/q", open: [{ root: "/q", name: "beta" }], recent: [] };
    emit(liveSource(), { type: "project-closed", root: "/p" }); // some other project
    await flush();
    expect(liveSource().url).toBe("/events?project=%2Fq");

    projects = { active: "/p", open: [{ root: "/p", name: "alpha" }], recent: [] };
    emit(liveSource(), { type: "project-closed", root: "/q" }); // this tab's own project
    await flush();
    expect(liveSource().url).toBe("/events?project=%2Fp");
    expect(pickerName()).toBe("alpha");
  });

  it("opening a project from the picker switches the opening tab to it and highlights it", async () => {
    projects = { ...projects, recent: ["/r"] };
    await boot();
    const sourcesBefore = sources.length;

    document.querySelector("#menu-recent-list .menu-item").click();
    await flush();

    expect(calls).toContain("POST /api/projects/open");
    expect(sources.length).toBeGreaterThan(sourcesBefore);
    expect(liveSource().url).toBe("/events?project=%2Fr");
    expect(pickerName()).toBe("gamma");
    expect(menuRow("gamma").classList.contains("menu-item-active")).toBe(true);
    expect(menuRow("alpha").classList.contains("menu-item-active")).toBe(false);
  });

  it("an empty tab picks up the daemon default on a lifecycle event", async () => {
    projects = { active: null, open: [], recent: [] };
    await boot();
    expect(pickerName()).toBe("No project open");

    projects = { active: "/p", open: [{ root: "/p", name: "alpha" }], recent: [] };
    emit(liveSource(), { type: "project-opened", root: "/p" });
    await flush();

    expect(liveSource().url).toBe("/events?project=%2Fp");
    expect(pickerName()).toBe("alpha");
  });

  it("the picker names the new project before its screens finish loading", async () => {
    await boot();
    let release;
    const gate = new Promise((r) => (release = r));
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url, init) => {
      if (String(url).startsWith("/api/screens?project=%2Fq")) await gate;
      return realFetch(url, init);
    });

    menuRow("beta").click();
    await flush();
    expect(pickerName()).toBe("beta");
    release();
    await flush();
  });

  it("a lifecycle sync that was in flight when the user opened a project does not move the tab back", async () => {
    projects = { ...projects, recent: ["/r"] };
    await boot();
    let release;
    const gate = new Promise((r) => (release = r));
    const realFetch = globalThis.fetch;
    let gated = false;
    vi.stubGlobal("fetch", async (url, init) => {
      if (String(url) === "/api/projects" && !init && !gated) {
        gated = true;
        const stale = JSON.parse(JSON.stringify(projects)); // computed before /r was opened
        await gate;
        return { ok: true, status: 200, json: async () => stale };
      }
      return realFetch(url, init);
    });

    emit(liveSource(), { type: "project-switched", root: "/q" }); // sync starts, response held back
    await flush();
    document.querySelector("#menu-recent-list .menu-item").click(); // user opens /r meanwhile
    await flush();
    release();
    await flush();

    expect(liveSource().url).toBe("/events?project=%2Fr");
    expect(pickerName()).toBe("gamma");
  });

  it("a failed /api/projects refresh from an SSE event is logged, not left unhandled", async () => {
    await boot();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url, init) => {
      if (String(url) === "/api/projects") throw new Error("daemon gone");
      return realFetch(url, init);
    });

    emit(liveSource(), { type: "project-closed", root: "/q" });
    await flush();

    expect(err).toHaveBeenCalledWith("failed to refresh projects:", "daemon gone");
  });
});

describe("menu and empty-state rows are buttons without glyph icons (CHR-911)", () => {
  const GLYPH_ICON = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFF0B\u25B8\u25BE]/u;

  it("renders project-menu rows as buttons with a check icon on the current one", async () => {
    projects = { ...projects, recent: ["/r"] };
    await boot();
    const rows = [...document.querySelectorAll("#project-menu .menu-item")];
    expect(rows).toHaveLength(3);
    // Every row is a button, the current project included (CHR-920: it must be keyboard-reachable).
    expect(rows.map((r) => r.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON"]);
    expect(menuRow("alpha").classList.contains("menu-item-active")).toBe(true);
    expect(menuRow("alpha").querySelector(".menu-item-check").textContent).toBe("check");
    expect(menuRow("alpha").getAttribute("aria-current")).toBe("true");
    expect($("#project-menu").textContent).not.toMatch(GLYPH_ICON);
  });

  it("renders the empty-state recent rows as buttons", async () => {
    projects = { active: null, open: [], recent: ["/work/acme"] };
    await boot();
    const row = $("#empty-recent-list .empty-recent-row");
    expect(row.tagName).toBe("BUTTON");
    expect(row.querySelector(".empty-recent-name").textContent).toBe("acme");
    expect($("#no-project-state").textContent).not.toMatch(GLYPH_ICON);
  });

  it("tells recents that share a base name apart by their shortened path, with the full path as title", async () => {
    projects = { active: "/p", open: [{ root: "/p", name: "alpha" }], recent: ["/work/acme/design", "/work/other/design"] };
    await boot();
    const rows = [...document.querySelectorAll("#menu-recent-list .menu-item")];
    expect(rows.map((r) => r.querySelector(".menu-item-name").textContent)).toEqual(["design", "design"]);
    expect(rows.map((r) => r.querySelector(".menu-item-path").textContent)).toEqual(["\u2026/acme/design", "\u2026/other/design"]);
    expect(rows.map((r) => r.title)).toEqual(["/work/acme/design", "/work/other/design"]);
  });
});
