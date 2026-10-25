// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import html from "./index.html?raw";
import { SHORTCUTS, SHORTCUT_GROUPS, applyShortcutHints, formatShortcut, isMacPlatform, resolveShortcut, shortcutById } from "./shortcuts.js";

/** A KeyboardEvent look-alike: the resolver only reads these fields. */
function key(k, init = {}) {
  return { key: k, code: init.code ?? "", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 0, repeat: false, target: null, ...init };
}
const ctx = (over = {}) => ({ view: "screens", overlay: null, ...over });
const press = (k, init, c) => resolveShortcut(key(k, init), ctx(c));

describe("mapping", () => {
  it("covers every group and has unique ids", () => {
    expect(new Set(SHORTCUTS.map((d) => d.id)).size).toBe(SHORTCUTS.length);
    for (const group of SHORTCUT_GROUPS) expect(SHORTCUTS.some((d) => d.group === group)).toBe(true);
  });

  it("never binds the same key combination twice for one view and overlay", () => {
    const seen = new Map();
    for (const def of SHORTCUTS) {
      for (const view of ["screens", "board"]) {
        if (def.view && def.view !== (view === "board" ? "board" : "screens")) continue;
        const combo = [view, def.overlay ?? "", def.code ?? def.key?.toLowerCase(), Boolean(def.shift)].join("|");
        expect(seen.has(combo), `${def.id} collides with ${seen.get(combo)}`).toBe(false);
        seen.set(combo, def.id);
      }
    }
  });
});

describe("resolveShortcut", () => {
  it("resolves plain keys to their ids, letters case-insensitively", () => {
    expect(press("f")).toBe("flow");
    expect(press("F")).toBe("flow"); // Caps Lock
    expect(press("c")).toBe("comment");
    expect(press("i")).toBe("inspect");
    expect(press("s")).toBe("status-bar");
    expect(press("w")).toBe("follow");
    expect(press("r")).toBe("follow-resume");
    expect(press("1")).toBe("view-screens");
    expect(press("2")).toBe("view-design-system");
    expect(press("3")).toBe("view-board");
    expect(press("[")).toBe("panel-screens");
    expect(press("\\")).toBe("panel-context");
    expect(press("]")).toBe("panel-elements");
    expect(press("p")).toBe("project-menu");
    expect(press("/")).toBe("filter");
    expect(press("t")).toBe("theme");
    expect(press("?", { shiftKey: true })).toBe("help");
    expect(press("Escape")).toBe("leave");
  });

  it("zoom presets are Shift+digit (by code, any layout) in Screens, Fit all / 100% on the Board", () => {
    expect(press("!", { shiftKey: true, code: "Digit1" })).toBe("zoom-fit");
    expect(press("%", { shiftKey: true, code: "Digit5" })).toBe("zoom-50");
    expect(press(")", { shiftKey: true, code: "Digit0" })).toBe("zoom-100");
    expect(press("@", { shiftKey: true, code: "Digit2" })).toBe("zoom-200");
    expect(press("!", { shiftKey: true, code: "Digit1" }, { view: "board" })).toBe("board-fit-all");
    expect(press(")", { shiftKey: true, code: "Digit0" }, { view: "board" })).toBe("board-100");
    expect(press("%", { shiftKey: true, code: "Digit5" }, { view: "board" })).toBeNull(); // no 50% on the Board
  });

  it("+ and - zoom (the unshifted = counts as +)", () => {
    expect(press("+", { shiftKey: true })).toBe("zoom-in");
    expect(press("=")).toBe("zoom-in");
    expect(press("-")).toBe("zoom-out");
    expect(press("+", { repeat: true })).toBe("zoom-in"); // zoom keeps stepping while held
  });

  it("E / G / Shift+G are Board only", () => {
    expect(press("e", {}, { view: "board" })).toBe("board-edges");
    expect(press("g", {}, { view: "board" })).toBe("board-clusters");
    expect(press("G", { shiftKey: true }, { view: "board" })).toBe("board-collapse-all");
    expect(press("e")).toBeNull();
    expect(press("g")).toBeNull();
    expect(press("G", { shiftKey: true })).toBeNull();
  });

  it("O and N exist only while the project menu is open", () => {
    expect(press("o")).toBeNull();
    expect(press("n")).toBeNull();
    expect(press("o", {}, { overlay: "project-menu" })).toBe("menu-open");
    expect(press("n", {}, { overlay: "project-menu" })).toBe("menu-new");
  });

  it("modifier guard: nothing fires with Ctrl, Cmd or Alt held", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey"]) {
      for (const k of ["f", "o", "n", "1", "p", "t", "/", "+", "-"]) expect(press(k, { [mod]: true })).toBeNull();
    }
  });

  it("IME guard: composition events never trigger", () => {
    expect(press("f", { isComposing: true })).toBeNull();
    expect(press("Process", { keyCode: 229 })).toBeNull();
    expect(press("f", { keyCode: 229 })).toBeNull();
  });

  it("repeat guard: a held key fires once, except +/-", () => {
    expect(press("f", { repeat: true })).toBeNull();
    expect(press("t", { repeat: true })).toBeNull();
  });

  it("typing guard: text inputs, textareas, selects and contenteditable swallow every key", () => {
    const el = (html) => {
      const holder = document.createElement("div");
      holder.innerHTML = html;
      document.body.appendChild(holder);
      return holder.firstElementChild;
    };
    for (const target of [el('<input type="text">'), el("<input>"), el('<input type="search">'), el("<textarea></textarea>"), el("<select></select>"), el('<div contenteditable="true"><span>x</span></div>').firstElementChild]) {
      expect(press("f", { target })).toBeNull();
      expect(press("Escape", { target })).toBeNull();
    }
    // Controls that take no text do not block the keys.
    expect(press("f", { target: el('<input type="range">') })).toBe("flow");
    expect(press("f", { target: el('<input type="checkbox">') })).toBe("flow");
    expect(press("f", { target: el("<button>b</button>") })).toBe("flow");
  });

  it("overlay guard: while a dialog, popover or menu is open only its own keys act", () => {
    for (const k of ["f", "1", "p", "t", "/", "?", "Escape"]) expect(press(k, k === "?" ? { shiftKey: true } : {}, { overlay: "other" })).toBeNull();
    expect(press("f", {}, { overlay: "project-menu" })).toBeNull();
    expect(press("t", {}, { overlay: "zoom-menu" })).toBeNull();
    // The zoom menu's own keys: presets and +/-.
    expect(press("!", { shiftKey: true, code: "Digit1" }, { overlay: "zoom-menu" })).toBe("zoom-fit");
    expect(press("-", {}, { overlay: "zoom-menu" })).toBe("zoom-out");
  });
});

describe("display strings", () => {
  const flow = shortcutById("flow");
  const fit = shortcutById("zoom-fit");
  it("plain keys have no modifier prefix", () => {
    expect(formatShortcut(flow, true)).toBe("F");
    expect(formatShortcut(flow, false)).toBe("F");
  });
  it("Shift shows as the symbol on macOS and as the word elsewhere", () => {
    expect(formatShortcut(fit, true)).toBe("⇧1");
    expect(formatShortcut(fit, false)).toBe("Shift+1");
    expect(formatShortcut(shortcutById("board-collapse-all"), false)).toBe("Shift+G");
  });
  it("detects the platform", () => {
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
    expect(isMacPlatform({ platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" })).toBe(true);
    expect(isMacPlatform({ platform: "Win32" })).toBe(false);
    expect(isMacPlatform({ platform: "Linux x86_64" })).toBe(false);
  });
});

describe("mapping ↔ rendered hints", () => {
  const body = html.slice(html.indexOf("<body>") + 6);

  it("every data-shortcut-id in the markup names a bound shortcut, and its hint is filled", () => {
    const root = document.createElement("div");
    root.innerHTML = body;
    const hinted = [...root.querySelectorAll("[data-shortcut-id]")];
    expect(hinted.length).toBeGreaterThan(15);
    applyShortcutHints(root, false);
    for (const el of hinted) {
      const def = shortcutById(el.dataset.shortcutId);
      expect(def, `unknown id ${el.dataset.shortcutId}`).toBeDefined();
      expect(def.unbound).toBeFalsy();
      const shown = el.classList.contains("chrome-menu-hint") ? el.textContent : el.dataset.shortcut;
      expect(shown).toBe(formatShortcut(def, false));
    }
  });

  it("no tooltip trigger is left with an empty shortcut slot that the mapping could fill", () => {
    const root = document.createElement("div");
    root.innerHTML = body;
    for (const el of root.querySelectorAll("[data-shortcut]")) {
      // Only the controls without a key (Add comment) keep an empty slot; they carry no id.
      expect(el.dataset.shortcutId).toBeUndefined();
      expect(el.dataset.shortcut).toBe("");
    }
  });
});
