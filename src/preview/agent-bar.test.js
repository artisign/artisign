import { describe, it, expect } from "vitest";
import { agentStatus, writingScreen, IDLE_AFTER_MS } from "./agent-bar.js";

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

describe("writingScreen", () => {
  const state = (over = {}) => ({ feed: [write], connected: true, now: NOW, ...over });
  it("is the screen of the newest feed entry when it is a recent screen write that worked", () => {
    expect(writingScreen(state())).toBe("home");
  });
  it("is nobody once the agent went idle, while the connection is down, or for a read", () => {
    expect(writingScreen(state({ now: NOW + IDLE_AFTER_MS + 5000 }))).toBeNull();
    expect(writingScreen(state({ connected: false }))).toBeNull();
    expect(writingScreen(state({ feed: [{ ...write, kind: "read", tool: "get_screen" }] }))).toBeNull();
    expect(writingScreen(state({ feed: [] }))).toBeNull();
  });
  it("is nobody for a failed write, a delete, or a write that is not on a screen", () => {
    expect(writingScreen(state({ feed: [{ ...write, ok: false }] }))).toBeNull();
    expect(writingScreen(state({ feed: [{ ...write, tool: "delete_entity" }] }))).toBeNull();
    expect(writingScreen(state({ feed: [{ ...write, target: { kind: "mockup", name: "m" } }] }))).toBeNull();
  });
});
