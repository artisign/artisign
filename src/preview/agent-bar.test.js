import { describe, it, expect } from "vitest";
import { agentStatus, noteState, IDLE_AFTER_MS } from "./agent-bar.js";

const NOW = 1_000_000;
const write = { tool: "write_html", kind: "write", ok: true, target: { kind: "screen", name: "home" }, nodes: [], at: NOW - 1000 };
const status = (over = {}) => {
  const s = agentStatus({ feed: [write], follow: { enabled: true, paused: false }, connected: true, now: NOW, exists: () => true, ...over });
  return { ...s, said: `${s.text.before}${s.text.name ?? ""}${s.text.after}` };
};

describe("agentStatus", () => {
  it("says what the agent is doing now from the newest feed entry", () => {
    expect(status()).toMatchObject({ look: "active", said: "Writing home", detail: "Following: the canvas shows each screen the agent touches" });
  });

  it("is idle with an empty feed, and idle once the newest entry is older than the timeout", () => {
    expect(status({ feed: [] })).toMatchObject({ look: "idle", said: "Idle", detail: "No agent call in this session yet" });
    const old = { ...write, at: NOW - IDLE_AFTER_MS - 1000 };
    expect(status({ feed: [old] })).toMatchObject({ look: "idle", said: "Idle", detail: "Last activity 1 min ago" });
    expect(status({ feed: [{ ...write, at: NOW - IDLE_AFTER_MS + 1000 }] }).look).toBe("active");
  });

  it("waits for the connection while the live connection is down, even with a fresh entry", () => {
    expect(status({ connected: false })).toMatchObject({ look: "active", said: "Waiting for the connection", detail: "Last activity now" });
    expect(status({ connected: false, feed: [] }).detail).toBe("No agent call in this session yet");
  });

  it("explains a paused follow and a follow that is off", () => {
    expect(status({ follow: { enabled: true, paused: true } }).detail).toBe("You moved away, so the canvas stays where you are");
    expect(status({ follow: { enabled: false, paused: false } }).detail).toBe("Follow is off, the canvas stays where you are");
  });

  it("names the mockup row cue while following a mockup", () => {
    const mockup = { ...write, tool: "write_mockup", target: { kind: "mockup", name: "orders-layout" } };
    expect(status({ feed: [mockup] })).toMatchObject({ said: "Writing mockup orders-layout", detail: "Following: mockups have no node ids, so the row lights up" });
  });

  it("says a failed call and a gone target as they are", () => {
    expect(status({ feed: [{ ...write, ok: false }] }).said).toBe("Could not write home");
    expect(status({ exists: () => false, feed: [{ ...write, tool: "get_screen", kind: "read" }] }).said).toBe("Reading home, which no longer exists");
  });
});

describe("noteState", () => {
  const where = { view: "screens", showMockup: false, comparing: false, screen: "home", screenLabel: "home, default", mockup: null, boardCount: 5 };

  it("is on for the open screen, scoped by the screen's name", () => {
    expect(noteState(where)).toEqual({ enabled: true, key: "screen:home", icon: "desktop_windows", scope: "On home, default", reason: "" });
  });

  it("is off on the Board with the design's scope line, and says why", () => {
    expect(noteState({ ...where, view: "board" })).toMatchObject({ enabled: false, icon: "grid_view", scope: "On the Board, 5 screens", reason: "Not available on the Board" });
    expect(noteState({ ...where, view: "board", boardCount: 1 }).scope).toBe("On the Board, 1 screen");
  });

  it("is on for the selected variant of an open mockup, scoped by mockup and variant", () => {
    expect(noteState({ ...where, showMockup: true, mockup: "orders-layout", mockupVariant: { id: "b", label: "Order cards" } })).toEqual({
      enabled: true,
      key: "mockup:orders-layout#b",
      icon: "view_column",
      scope: "On orders-layout, Order cards",
      reason: "",
    });
  });

  it("is off for a mockup without variants, and while comparing, with a reason", () => {
    expect(noteState({ ...where, showMockup: true, mockup: "orders-layout" })).toMatchObject({ enabled: false, icon: "view_column", scope: "On orders-layout", reason: "This mockup has no variants" });
    expect(noteState({ ...where, comparing: true })).toMatchObject({ enabled: false, reason: "Not available while comparing variants" });
  });

  it("is off with no screen open", () => {
    expect(noteState({ ...where, screen: null, screenLabel: "" })).toMatchObject({ enabled: false, key: "none", reason: "No screen is open" });
  });
});
