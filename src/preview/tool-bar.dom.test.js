// @vitest-environment jsdom
//
// CHR-1268 — the side tool bar: fold and grip are remembered, every tool gets a hint (interest invoker) or a title, a disabled tool stays focusable but never acts and says why.
import { describe, it, expect, vi } from "vitest";
import { createToolBar, hintText } from "./tool-bar.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), map };
}

function build({ interest, storage = memoryStorage() }) {
  document.body.innerHTML = `<div id="wrap">
    <div id="bar" role="toolbar" aria-orientation="vertical">
      <button id="grip"></button><button id="fold"><span class="icon">keyboard_arrow_up</span></button><span id="live"></span>
      <div id="tools">
        <button class="tool-btn" id="a" aria-label="Comment" data-shortcut-id="comment" aria-pressed="false"></button>
        <button class="tool-btn" id="b" aria-label="Inspect" data-shortcut-id="inspect"></button>
        <button class="tool-btn" id="c" aria-label="More actions" data-shortcut-id=""></button>
      </div>
    </div></div>`;
  const bar = createToolBar({ barEl: document.getElementById("bar"), toolsEl: document.getElementById("tools"), foldEl: document.getElementById("fold"), gripEl: document.getElementById("grip"), liveEl: document.getElementById("live"), storage, mac: false, interest });
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
    const { bar, storage, $ } = build({ interest: false });
    expect([$("bar").dataset.collapsed, $("fold").getAttribute("aria-expanded"), $("fold").getAttribute("aria-label")]).toEqual(["false", "true", "Fold tool bar"]);
    $("fold").click();
    expect([$("bar").dataset.collapsed, $("fold").getAttribute("aria-expanded"), $("fold").getAttribute("aria-label")]).toEqual(["true", "false", "Unfold tool bar"]);
    expect($("tools").hidden).toBe(false); // folded by CSS: the tools stay reachable for their keys (pressControl refuses [hidden])
    expect($("fold").querySelector(".icon").textContent).toBe("keyboard_arrow_down");
    expect(storage.map.get("artisign.tool-bar.collapsed")).toBe("true");
    expect(bar.isFolded()).toBe(true);
    // a fresh bar starts folded
    const again = build({ interest: false, storage });
    expect(again.$("bar").dataset.collapsed).toBe("true");
    again.bar.toggleFold();
    expect(again.$("bar").dataset.collapsed).toBe("false");
  });
});

describe("grip", () => {
  it("restores the stored position and saves a keyboard move", () => {
    const storage = memoryStorage({ "artisign.tool-bar.position": "120,90" });
    const { $ } = build({ interest: false, storage });
    expect([$("bar").style.left, $("bar").style.top]).toEqual(["120px", "90px"]);
    // jsdom lays nothing out: the bar's rect follows its inline left/top.
    $("bar").getBoundingClientRect = () => ({ left: parseFloat($("bar").style.left), top: parseFloat($("bar").style.top), width: 52, height: 300 });
    $("grip").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(storage.map.get("artisign.tool-bar.position")).toBe("120,106");
  });
});

describe("hints where interest invokers work", () => {
  it("each tool gets a popover=hint tooltip with its name and key, outside the toolbar, wired with interestfor", () => {
    const { $ } = build({ interest: true });
    const hint = document.getElementById($("a").getAttribute("interestfor"));
    expect(hint.getAttribute("popover")).toBe("hint");
    expect($("bar").contains(hint)).toBe(false);
    expect(hint.textContent).toBe("CommentC");
    expect(hint.querySelector("kbd").getAttribute("aria-hidden")).toBe("true");
    expect($("a").hasAttribute("title")).toBe(false); // no second, native tooltip
    // the hint repeats the accessible name: nothing extra for assistive tech
    expect($("a").hasAttribute("aria-describedby")).toBe(false);
    expect(hint.hasAttribute("role")).toBe(false);
    // a tool without a shortcut has no key chip
    expect(document.getElementById($("c").getAttribute("interestfor")).querySelector("kbd")).toBeNull();
  });

  it("a disabled tool's hint says why, and describes the tool for assistive tech", () => {
    const { bar, $ } = build({ interest: true });
    bar.setState($("b"), { disabled: true, reason: "Not available for mockups" });
    const hint = document.getElementById($("b").getAttribute("interestfor"));
    expect(hint.querySelector(".tool-hint-label").textContent).toBe("Inspect: Not available for mockups");
    expect(hint.getAttribute("role")).toBe("tooltip");
    expect($("b").getAttribute("aria-describedby")).toBe(hint.id);
    expect($("b").getAttribute("aria-disabled")).toBe("true");
    bar.setState($("b"), {});
    expect($("b").hasAttribute("aria-disabled")).toBe(false);
    expect(hint.querySelector(".tool-hint-label").textContent).toBe("Inspect");
    expect($("b").hasAttribute("aria-describedby")).toBe(false);
  });

  it("a new accessible name (the count on Comments) reaches the hint", () => {
    const { bar, $ } = build({ interest: true });
    bar.setState($("a"), { name: "Comments, 3 open" });
    expect(document.getElementById($("a").getAttribute("interestfor")).querySelector(".tool-hint-label").textContent).toBe("Comments, 3 open");
  });
});

describe("hints where they do not (the native title stays)", () => {
  it("sets a title with the key, and the reason when disabled", () => {
    const { bar, $ } = build({ interest: false });
    expect($("a").title).toBe("Comment (C)");
    expect($("c").title).toBe("More actions");
    expect($("a").hasAttribute("interestfor")).toBe(false);
    bar.setState($("a"), { disabled: true, reason: "No screen is open" });
    expect($("a").title).toBe("Comment: No screen is open (C)");
  });
});

describe("a disabled tool", () => {
  it("stays a focusable button but no click handler runs, and the reason is announced", () => {
    const { bar, $ } = build({ interest: false });
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
    const { bar, $ } = build({ interest: false });
    bar.setState($("a"), { pressed: true });
    expect($("a").getAttribute("aria-pressed")).toBe("true");
    bar.setState($("a"), {});
    expect($("a").getAttribute("aria-pressed")).toBe("true"); // untouched when not given
  });
});
