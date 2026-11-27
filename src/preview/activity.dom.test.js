// @vitest-environment jsdom
//
// Smoke tests for renderActivityFeed's DOM output — the actual logic (wording, variants, formatting, the pause state machine) is tested directly in activity.test.js under the fast node environment; this file exists solely because rendering needs a real `document`.
import { describe, it, expect, vi } from "vitest";
import { renderActivityFeed } from "./activity.js";

const screenEvent = (over = {}) => ({ tool: "get_node", kind: "read", ok: true, target: { kind: "screen", name: "checkout-cart" }, nodes: [], at: 0, ...over });

function render(feed, options = {}) {
  const listEl = document.createElement("ol");
  const emptyEl = document.createElement("div");
  document.body.append(listEl, emptyEl);
  renderActivityFeed(listEl, emptyEl, feed, { exists: () => true, onSelect: () => {}, now: () => 0, ...options });
  return { listEl, emptyEl };
}

describe("renderActivityFeed", () => {
  it("shows the empty state when the feed is empty", () => {
    const { listEl, emptyEl } = render([]);
    expect(emptyEl.hidden).toBe(false);
    expect(listEl.hidden).toBe(true);
    expect(listEl.children).toHaveLength(0);
  });

  it("renders one row per event, newest first, with the words, a bold target and the time", () => {
    const feed = [
      { tool: "write_html", kind: "write", ok: true, target: { kind: "screen", name: "checkout-cart" }, nodes: ["checkout-cart.root"], at: 1000 },
      { tool: "get_screen", kind: "read", ok: true, target: { kind: "screen", name: "checkout-cart" }, nodes: [], at: 500 },
    ];
    const { listEl, emptyEl } = render(feed, { now: () => 1000 });
    expect(emptyEl.hidden).toBe(true);
    const rows = [...listEl.querySelectorAll(".agent-activity")];
    expect(rows).toHaveLength(2);
    expect(rows[0].dataset.variant).toBe("write");
    expect(rows[0].querySelector(".agent-activity-text").textContent).toBe("Wrote checkout-cart");
    expect(rows[0].querySelector(".agent-activity-text b").textContent).toBe("checkout-cart");
    expect(rows[0].querySelector(".agent-activity-time").textContent).toBe("now");
    expect(rows[1].dataset.variant).toBe("default");
  });

  it("renders a row the view can open as a real <button>", () => {
    const { listEl } = render([screenEvent()]);
    const button = listEl.querySelector(".agent-activity");
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
  });

  it("renders a failed call as plain text: error variant, no button, nothing to click", () => {
    const onSelect = vi.fn();
    const { listEl } = render([screenEvent({ tool: "patch_html", kind: "write", ok: false })], { onSelect });
    const row = listEl.querySelector(".agent-activity");
    expect(row.dataset.variant).toBe("error");
    expect(row.tagName).toBe("DIV");
    expect(row.querySelector(".agent-activity-text").textContent).toBe("Could not update checkout-cart");
    row.dispatchEvent(new Event("click", { bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders a deleted-target entry as plain text that says the target is gone", () => {
    const onSelect = vi.fn();
    const { listEl } = render([screenEvent({ tool: "inspect_node", nodes: ["checkout-cart.note"] })], { exists: () => false, onSelect });
    const row = listEl.querySelector(".agent-activity");
    expect(row.dataset.variant).toBe("deleted");
    expect(row.tagName).toBe("DIV");
    expect(row.querySelector(".agent-activity-text").textContent).toBe("Inspected checkout-cart, note, which no longer exists");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders a broad read as plain text too", () => {
    const { listEl } = render([screenEvent({ tool: "get_project", target: null })]);
    const row = listEl.querySelector(".agent-activity");
    expect(row.tagName).toBe("DIV");
    expect(row.querySelector(".agent-activity-text").textContent).toBe("Read the project");
  });

  it("calls onSelect with the event on a live row's click", () => {
    const onSelect = vi.fn();
    const event = screenEvent();
    const { listEl } = render([event], { onSelect });
    listEl.querySelector("button.agent-activity").click();
    expect(onSelect).toHaveBeenCalledWith(event);
  });

  describe("keyboard", () => {
    const three = [screenEvent({ at: 3 }), screenEvent({ at: 2 }), screenEvent({ at: 1 })];
    const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

    it("makes the feed one tab stop: only the first row is tabbable", () => {
      const { listEl } = render(three);
      expect([...listEl.querySelectorAll("button.agent-activity")].map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    });

    it("moves between rows with the arrow keys, Home and End, and the tab stop follows", () => {
      const { listEl } = render(three);
      const rows = [...listEl.querySelectorAll("button.agent-activity")];
      rows[0].focus();
      key(rows[0], "ArrowDown");
      expect(document.activeElement).toBe(rows[1]);
      expect(rows.map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
      key(rows[1], "End");
      expect(document.activeElement).toBe(rows[2]);
      key(rows[2], "ArrowUp");
      expect(document.activeElement).toBe(rows[1]);
      key(rows[1], "Home");
      expect(document.activeElement).toBe(rows[0]);
    });

    it("keeps focus on the same entry when the feed re-renders around it (a new call arrives)", () => {
      const { listEl, emptyEl } = render(three);
      const options = { exists: () => true, onSelect: () => {}, now: () => 0 };
      listEl.querySelectorAll("button.agent-activity")[1].focus();
      renderActivityFeed(listEl, emptyEl, [screenEvent({ at: 4 }), ...three], options);
      const rows = [...listEl.querySelectorAll("button.agent-activity")];
      expect(rows).toHaveLength(4);
      expect(document.activeElement).toBe(rows[2]); // the entry that was second is third now
      expect(rows.map((b) => b.tabIndex)).toEqual([-1, -1, 0, -1]);
    });
  });
});
