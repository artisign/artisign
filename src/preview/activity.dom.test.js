// @vitest-environment jsdom
//
// Smoke tests for renderActivityFeed/renderFollowToggle's DOM output — the
// actual logic (classification, formatting, the pause state machine) is
// tested directly in activity.test.js under the fast node environment; this
// file exists solely because rendering needs a real `document`.
import { describe, it, expect, vi } from "vitest";
import { renderActivityFeed, renderFollowToggle } from "./activity.js";

describe("renderActivityFeed", () => {
  it("shows the empty state when the feed is empty", () => {
    const listEl = document.createElement("ul");
    const emptyEl = document.createElement("p");
    renderActivityFeed(listEl, emptyEl, [], { exists: () => true, onSelect: () => {} });
    expect(emptyEl.hidden).toBe(false);
    expect(listEl.children).toHaveLength(0);
  });

  it("renders one row per event, newest first, with tool/target/time text", () => {
    const listEl = document.createElement("ul");
    const emptyEl = document.createElement("p");
    const feed = [
      { tool: "write_html", kind: "write", ok: true, target: { kind: "screen", name: "checkout-cart" }, nodes: ["checkout-cart.root"], at: 1000 },
      { tool: "get_screen", kind: "read", ok: true, target: { kind: "screen", name: "checkout-cart" }, nodes: [], at: 500 },
    ];
    renderActivityFeed(listEl, emptyEl, feed, { exists: () => true, onSelect: () => {}, now: () => 1000 });
    expect(emptyEl.hidden).toBe(true);
    const buttons = [...listEl.querySelectorAll(".activity-entry")];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].className).toContain("activity-entry-write");
    expect(buttons[0].querySelector(".activity-entry-tool").textContent).toBe("write_html");
    expect(buttons[0].querySelector(".activity-entry-target").textContent).toBe("screen · checkout-cart");
    expect(buttons[0].querySelector(".activity-entry-time").textContent).toBe("just now");
    expect(buttons[1].className).toContain("activity-entry-default");
  });

  it("renders each row as a real <button> — keyboard-focusable and Enter/Space-activatable for free, no hand-rolled keydown handler needed (review fix 4)", () => {
    const listEl = document.createElement("ul");
    const emptyEl = document.createElement("p");
    const event = { tool: "get_node", kind: "read", ok: true, target: { kind: "screen", name: "checkout-cart" }, nodes: [], at: 0 };
    renderActivityFeed(listEl, emptyEl, [event], { exists: () => true, onSelect: () => {}, now: () => 0 });
    const button = listEl.querySelector(".activity-entry");
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.hasAttribute("aria-disabled")).toBe(false);
  });

  it("renders a failed call inert — error variant, aria-disabled for assistive tech, no click handler fires", () => {
    const listEl = document.createElement("ul");
    const emptyEl = document.createElement("p");
    const onSelect = vi.fn();
    const feed = [{ tool: "patch_html", kind: "write", ok: false, target: { kind: "screen", name: "checkout-cart" }, nodes: [], at: 0 }];
    renderActivityFeed(listEl, emptyEl, feed, { exists: () => true, onSelect, now: () => 0 });
    const button = listEl.querySelector(".activity-entry");
    expect(button.className).toContain("activity-entry-error");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.dispatchEvent(new Event("click", { bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders a deleted-target entry inert, aria-disabled, without throwing on click", () => {
    const listEl = document.createElement("ul");
    const emptyEl = document.createElement("p");
    const onSelect = vi.fn();
    const feed = [{ tool: "inspect_node", kind: "read", ok: true, target: { kind: "screen", name: "gone" }, nodes: [], at: 0 }];
    renderActivityFeed(listEl, emptyEl, feed, { exists: () => false, onSelect, now: () => 0 });
    const button = listEl.querySelector(".activity-entry");
    expect(button.className).toContain("activity-entry-deleted");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.querySelector(".activity-entry-target").textContent).toBe("target removed");
    expect(() => button.dispatchEvent(new Event("click", { bubbles: true }))).not.toThrow();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("calls onSelect with the event on a live row's click", () => {
    const listEl = document.createElement("ul");
    const emptyEl = document.createElement("p");
    const onSelect = vi.fn();
    const event = { tool: "get_node", kind: "read", ok: true, target: { kind: "screen", name: "checkout-cart" }, nodes: [], at: 0 };
    renderActivityFeed(listEl, emptyEl, [event], { exists: () => true, onSelect, now: () => 0 });
    listEl.querySelector(".activity-entry").dispatchEvent(new Event("click", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith(event);
  });
});

describe("renderFollowToggle", () => {
  it("renders the off state", () => {
    const containerEl = document.createElement("span");
    const toggleButtonEl = document.createElement("button");
    const labelEl = document.createElement("span");
    renderFollowToggle(containerEl, toggleButtonEl, labelEl, { enabled: false, paused: false });
    expect(containerEl.dataset.state).toBe("off");
    expect(toggleButtonEl.getAttribute("aria-pressed")).toBe("false");
    expect(labelEl.textContent).toBe("Follow");
  });

  it("renders the following state", () => {
    const containerEl = document.createElement("span");
    const toggleButtonEl = document.createElement("button");
    const labelEl = document.createElement("span");
    renderFollowToggle(containerEl, toggleButtonEl, labelEl, { enabled: true, paused: false });
    expect(containerEl.dataset.state).toBe("following");
    expect(toggleButtonEl.getAttribute("aria-pressed")).toBe("true");
    expect(labelEl.textContent).toBe("Following");
  });

  it("renders the paused state", () => {
    const containerEl = document.createElement("span");
    const toggleButtonEl = document.createElement("button");
    const labelEl = document.createElement("span");
    renderFollowToggle(containerEl, toggleButtonEl, labelEl, { enabled: true, paused: true });
    expect(containerEl.dataset.state).toBe("paused");
    expect(toggleButtonEl.getAttribute("aria-pressed")).toBe("false");
    expect(labelEl.textContent).toBe("Follow paused");
  });
});
