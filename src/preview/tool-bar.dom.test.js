// @vitest-environment jsdom
//
// CHR-1268 — the side tool bar: fold and grip are remembered, every tool gets a tooltip (shared, data-tooltip), a disabled tool stays focusable but never acts and says why.
import { describe, it, expect, vi } from "vitest";
import { createToolBar, hintText } from "./tool-bar.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), map };
}

function build({ storage = memoryStorage() } = {}) {
  document.body.innerHTML = `<div id="wrap">
    <div id="bar" role="toolbar" aria-orientation="vertical">
      <button id="grip"></button><button id="fold"><span class="icon">keyboard_arrow_up</span></button><span id="live"></span>
      <div id="tools">
        <button class="tool-btn" id="a" aria-label="Comment" data-shortcut-id="comment" aria-pressed="false"></button>
        <button class="tool-btn" id="b" aria-label="Inspect" data-shortcut-id="inspect"></button>
        <button class="tool-btn" id="c" aria-label="More actions" data-shortcut-id=""></button>
      </div>
    </div></div>`;
  const bar = createToolBar({ barEl: document.getElementById("bar"), toolsEl: document.getElementById("tools"), foldEl: document.getElementById("fold"), gripEl: document.getElementById("grip"), liveEl: document.getElementById("live"), storage, mac: false });
  return { bar, storage, $: (id) => document.getElementById(id) };
}

describe("hintText", () => {
  it("is the name, with the reason after a colon", () => {
    expect(hintText("Comment")).toBe("Comment");
    expect(hintText("Comment", "Not available for mockups")).toBe("Comment: Not available for mockups");
  });
});

describe("fold", () => {
  it("toggles the tools, the label and aria-expanded, and remembers the choice per viewer", () => {
    const { bar, storage, $ } = build();
    expect([$("bar").dataset.collapsed, $("fold").getAttribute("aria-expanded"), $("fold").getAttribute("aria-label")]).toEqual(["false", "true", "Fold tool bar"]);
    $("fold").click();
    expect([$("bar").dataset.collapsed, $("fold").getAttribute("aria-expanded"), $("fold").getAttribute("aria-label")]).toEqual(["true", "false", "Unfold tool bar"]);
    expect($("tools").hidden).toBe(false); // folded by CSS: the tools stay reachable for their keys (pressControl refuses [hidden])
    expect($("fold").querySelector(".icon").textContent).toBe("keyboard_arrow_down");
    expect(storage.map.get("artisign.tool-bar.collapsed")).toBe("true");
    expect(bar.isFolded()).toBe(true);
    // a fresh bar starts folded
    const again = build({ storage });
    expect(again.$("bar").dataset.collapsed).toBe("true");
    again.bar.toggleFold();
    expect(again.$("bar").dataset.collapsed).toBe("false");
  });
});

describe("grip", () => {
  it("restores the stored position and saves a keyboard move", () => {
    const storage = memoryStorage({ "artisign.tool-bar.position": "120,90" });
    const { $ } = build({ storage });
    expect([$("bar").style.left, $("bar").style.top]).toEqual(["120px", "90px"]);
    // jsdom lays nothing out: the bar's rect follows its inline left/top.
    $("bar").getBoundingClientRect = () => ({ left: parseFloat($("bar").style.left), top: parseFloat($("bar").style.top), width: 52, height: 300 });
    $("grip").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(storage.map.get("artisign.tool-bar.position")).toBe("120,106");
  });
});

describe("tool tooltips (the shared tooltip, CHR-1285)", () => {
  it("each tool carries its name and key as data-tooltip / data-shortcut, and no native title", () => {
    const { $ } = build();
    expect([$("a").dataset.tooltip, $("a").dataset.shortcut]).toEqual(["Comment", "C"]);
    expect($("a").hasAttribute("title")).toBe(false);
    expect($("a").hasAttribute("interestfor")).toBe(false);
    // a tool without a shortcut has no key
    expect([$("c").dataset.tooltip, $("c").dataset.shortcut]).toEqual(["More actions", undefined]);
  });

  it("a disabled tool's tooltip says why", () => {
    const { bar, $ } = build();
    bar.setState($("b"), { disabled: true, reason: "Not available for mockups" });
    expect($("b").dataset.tooltip).toBe("Inspect: Not available for mockups");
    expect($("b").getAttribute("aria-disabled")).toBe("true");
    bar.setState($("b"), {});
    expect($("b").hasAttribute("aria-disabled")).toBe(false);
    expect($("b").dataset.tooltip).toBe("Inspect");
  });

  it("a tool the design gives its own tooltip words shows those, while disabled", () => {
    const { bar, $ } = build();
    bar.setState($("b"), { disabled: true, reason: "Nothing on the board", name: "Inspect, nothing on the board", hint: "Nothing on the board" });
    expect($("b").getAttribute("aria-label")).toBe("Inspect, nothing on the board");
    expect($("b").dataset.tooltip).toBe("Nothing on the board");
    // Enabled again, the default words are back.
    bar.setState($("b"), { name: "Inspect" });
    expect($("b").dataset.tooltip).toBe("Inspect");
  });

  it("a tooltip that repeats the whole accessible name is announced once", () => {
    const { bar, $ } = build();
    const label = "Comment, read-only on the Board: comment in the Screens view";
    bar.setState($("a"), { disabled: true, reason: label, name: label, hint: label });
    $("a").click();
    expect($("live").textContent).toBe(label); // announced once, not "name: name"
  });

  it("the key follows the shortcut the tool answers to now (Flow is F in Screens, E on the Board)", () => {
    const { bar, $ } = build();
    expect($("a").dataset.shortcut).toBe("C");
    bar.setState($("a"), { shortcut: "board-edges" });
    expect($("a").dataset.shortcutId).toBe("board-edges");
    expect([$("a").getAttribute("aria-keyshortcuts"), $("a").dataset.shortcut]).toEqual(["E", "E"]); // for assistive tech too
    bar.setState($("a"), { shortcut: "comment" });
    expect([$("a").getAttribute("aria-keyshortcuts"), $("a").dataset.shortcut]).toEqual(["C", "C"]);
    bar.setState($("a"), { shortcut: "" });
    expect($("a").hasAttribute("aria-keyshortcuts")).toBe(false);
    expect($("a").dataset.shortcut).toBeUndefined();
  });

  it("a new accessible name (the count on Comments) reaches the tooltip", () => {
    const { bar, $ } = build();
    bar.setState($("a"), { name: "Comments, 3 open" });
    expect($("a").dataset.tooltip).toBe("Comments, 3 open");
  });

  it("the tools ask for the side (vertical bar) or the top (docked horizontal bar)", () => {
    const { $ } = build();
    expect($("tools").dataset.tooltipSide).toBe("end");
  });
});

describe("the roving tab stop (where the browser has no focusgroup)", () => {
  it("skips hidden tools and moves its tab stop off a tool that went away", () => {
    const { bar, $ } = build();
    $("b").hidden = true;
    $("a").focus();
    $("a").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe($("c")); // not the hidden b
    $("a").tabIndex = 0;
    $("c").tabIndex = -1;
    $("a").hidden = true;
    bar.syncRoving();
    expect([$("a").tabIndex, $("b").tabIndex, $("c").tabIndex]).toEqual([-1, -1, 0]);
  });
});

describe("a disabled tool", () => {
  it("stays a focusable button but no click handler runs, and the reason is announced", () => {
    const { bar, $ } = build();
    const handler = vi.fn();
    $("a").addEventListener("click", handler);
    bar.setState($("a"), { disabled: true, reason: "No screen is open" });
    $("a").focus();
    expect(document.activeElement).toBe($("a"));
    $("a").click();
    expect(handler).not.toHaveBeenCalled();
    expect($("live").textContent).toBe("Comment: No screen is open");
    bar.setState($("a"), {});
    $("a").click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("setState keeps a toggle's pressed state in step", () => {
    const { bar, $ } = build();
    bar.setState($("a"), { pressed: true });
    expect($("a").getAttribute("aria-pressed")).toBe("true");
    bar.setState($("a"), {});
    expect($("a").getAttribute("aria-pressed")).toBe("true"); // untouched when not given
  });
});
