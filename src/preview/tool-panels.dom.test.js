// @vitest-environment jsdom
//
// CHR-1268 — the right column's panel: one at a time, Compare's Differences show by themselves and give way to a tool panel.
import { describe, it, expect, beforeEach } from "vitest";
import { createToolPanels } from "./tool-panels.js";

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), map };
}

let ctx;
beforeEach(() => {
  document.body.innerHTML = `<aside id="panel" hidden><button id="grip"></button><h2 id="title"></h2><span id="ctx"></span><button id="close"></button><span id="live"></span>
    <section id="inspect" hidden></section><section id="notes" hidden></section><section id="comments" hidden></section><section id="compare" hidden></section></aside>`;
  const $ = (id) => document.getElementById(id);
  const calls = { change: [], close: [], leave: [] };
  const panels = createToolPanels({
    panelEl: $("panel"), titleEl: $("title"), contextEl: $("ctx"), closeEl: $("close"), gripEl: $("grip"), liveEl: $("live"),
    sections: { inspect: $("inspect"), notes: $("notes"), comments: $("comments"), compare: $("compare") },
    storage: memoryStorage(),
    onChange: (shown, opened) => calls.change.push([shown, opened]),
    onClose: (id, returnFocus) => calls.close.push([id, returnFocus]),
    onLeaveCompare: () => calls.leave.push(true),
  });
  ctx = { $, panels, calls };
});

const visible = () => ["inspect", "notes", "comments", "compare"].filter((id) => !ctx.$(id).hidden);

describe("one panel at a time", () => {
  it("opens a panel with its title, shows only its section, and replaces the previous one (telling its owner, without moving focus)", () => {
    ctx.panels.open("notes");
    expect([ctx.$("panel").hidden, ctx.$("title").textContent, visible()]).toEqual([false, "Notes", ["notes"]]);
    ctx.panels.open("comments");
    expect([ctx.$("title").textContent, visible()]).toEqual(["Comments", ["comments"]]);
    expect(ctx.calls.close).toEqual([["notes", false]]);
    expect(ctx.panels.opened()).toBe("comments");
  });

  it("toggle opens and closes; close hands the focus back to the owner", () => {
    ctx.panels.toggle("inspect");
    expect(ctx.panels.shown()).toBe("inspect");
    ctx.panels.toggle("inspect");
    expect([ctx.$("panel").hidden, ctx.panels.opened()]).toEqual([true, null]);
    ctx.panels.open("notes");
    ctx.$("close").click();
    expect(ctx.calls.close.at(-1)).toEqual(["notes", true]);
    expect(ctx.$("panel").hidden).toBe(true);
    expect(ctx.panels.close()).toBe(false); // nothing left to close
  });

  it("reports every change of what shows", () => {
    ctx.panels.open("notes");
    ctx.panels.open("notes"); // no change
    ctx.panels.close(false);
    expect(ctx.calls.change).toEqual([["notes", "notes"], [null, null]]);
  });

  it("the context line is cleared by a new panel and set by the owner", () => {
    ctx.panels.open("notes");
    ctx.panels.setContext("home");
    expect(ctx.$("ctx").textContent).toBe("home");
    ctx.panels.open("comments");
    expect(ctx.$("ctx").textContent).toBe("");
  });
});

describe("Compare's Differences", () => {
  it("show by themselves while comparing; their cross leaves Compare (it is not a tool panel)", () => {
    ctx.panels.setComparing(true);
    expect([ctx.$("panel").hidden, ctx.$("title").textContent, visible(), ctx.$("close").hidden]).toEqual([false, "Differences", ["compare"], false]);
    expect(ctx.$("close").getAttribute("aria-label")).toBe("Close Differences and leave Compare");
    expect(ctx.panels.opened()).toBeNull();
    ctx.$("close").click();
    expect(ctx.calls.leave).toEqual([true]);
    expect(ctx.calls.close).toEqual([]);
  });

  it("give way to a tool panel and come back when it closes", () => {
    ctx.panels.setComparing(true);
    ctx.panels.open("notes");
    expect([ctx.$("title").textContent, visible(), ctx.$("close").getAttribute("aria-label")]).toEqual(["Notes", ["notes"], "Close panel"]);
    ctx.panels.close(true);
    expect([ctx.$("title").textContent, visible()]).toEqual(["Differences", ["compare"]]);
    ctx.panels.setComparing(false);
    expect(ctx.$("panel").hidden).toBe(true);
  });
});
