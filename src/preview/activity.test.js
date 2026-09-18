import { describe, it, expect } from "vitest";
import {
  ACTIVITY_FEED_LIMIT,
  pushActivityEntry,
  activityNavigationTarget,
  highlightDurationMs,
  activityEntryVariant,
  activityTargetExists,
  activityIsNavigable,
  canFollowNavigate,
  resolveFollowNavigation,
  formatActivityTarget,
  formatActivityTime,
  nextFollowState,
  followToggleClickAction,
  FOLLOW_OFF,
} from "./activity.js";

describe("pushActivityEntry", () => {
  it("prepends the new event — newest first", () => {
    const feed = pushActivityEntry([{ tool: "a" }], { tool: "b" });
    expect(feed.map((e) => e.tool)).toEqual(["b", "a"]);
  });

  it("caps the feed at ACTIVITY_FEED_LIMIT, dropping the oldest", () => {
    const full = Array.from({ length: ACTIVITY_FEED_LIMIT }, (_, i) => ({ tool: `t${i}` }));
    const feed = pushActivityEntry(full, { tool: "newest" });
    expect(feed).toHaveLength(ACTIVITY_FEED_LIMIT);
    expect(feed[0].tool).toBe("newest");
    expect(feed.some((e) => e.tool === `t${ACTIVITY_FEED_LIMIT - 1}`)).toBe(false); // the oldest fell off
  });

  it("never exceeds the cap even starting under it", () => {
    const feed = pushActivityEntry([], { tool: "a" });
    expect(feed).toHaveLength(1);
  });
});

describe("activityNavigationTarget", () => {
  it("returns a screen target", () => {
    const event = { target: { kind: "screen", name: "checkout-cart" } };
    expect(activityNavigationTarget(event)).toEqual({ kind: "screen", name: "checkout-cart" });
  });

  it("returns a mockup target", () => {
    const event = { target: { kind: "mockup", name: "checkout-flow", variant: "option-b" } };
    expect(activityNavigationTarget(event)).toEqual({ kind: "mockup", name: "checkout-flow", variant: "option-b" });
  });

  it("returns null for a broad read (no target)", () => {
    expect(activityNavigationTarget({ target: null })).toBeNull();
  });

  it("returns null for a component/pattern target — no navigable view for those yet", () => {
    expect(activityNavigationTarget({ target: { kind: "component", name: "tag-chip", variant: "active" } })).toBeNull();
    expect(activityNavigationTarget({ target: { kind: "pattern", name: "checkout-layout" } })).toBeNull();
  });
});

describe("highlightDurationMs", () => {
  it("is 2.5s for a write and 1.2s for a read", () => {
    expect(highlightDurationMs("write")).toBe(2500);
    expect(highlightDurationMs("read")).toBe(1200);
  });
});

describe("activityEntryVariant", () => {
  it("is error for a failed call regardless of kind", () => {
    expect(activityEntryVariant({ ok: false, kind: "read" })).toBe("error");
    expect(activityEntryVariant({ ok: false, kind: "write" })).toBe("error");
  });

  it("is write for a successful write, default for a successful read", () => {
    expect(activityEntryVariant({ ok: true, kind: "write" })).toBe("write");
    expect(activityEntryVariant({ ok: true, kind: "read" })).toBe("default");
  });
});

describe("activityTargetExists", () => {
  const lists = { screenNames: ["checkout-cart"], mockupNames: ["checkout-flow"] };

  it("is true for a broad read (nothing to check)", () => {
    expect(activityTargetExists({ target: null }, lists)).toBe(true);
  });

  it("checks a screen target against screenNames", () => {
    expect(activityTargetExists({ target: { kind: "screen", name: "checkout-cart" } }, lists)).toBe(true);
    expect(activityTargetExists({ target: { kind: "screen", name: "deleted-screen" } }, lists)).toBe(false);
  });

  it("checks a mockup target against mockupNames", () => {
    expect(activityTargetExists({ target: { kind: "mockup", name: "checkout-flow" } }, lists)).toBe(true);
    expect(activityTargetExists({ target: { kind: "mockup", name: "gone" } }, lists)).toBe(false);
  });

  it("is always true for a component/pattern target — not tracked", () => {
    expect(activityTargetExists({ target: { kind: "component", name: "tag-chip" } }, lists)).toBe(true);
  });
});

describe("activityIsNavigable", () => {
  const lists = { screenNames: ["checkout-cart"], mockupNames: ["checkout-flow"] };

  it("returns the target for a screen/mockup target that still exists", () => {
    const screenEvent = { target: { kind: "screen", name: "checkout-cart" } };
    expect(activityIsNavigable(screenEvent, lists)).toEqual({ kind: "screen", name: "checkout-cart" });
    const mockupEvent = { target: { kind: "mockup", name: "checkout-flow" } };
    expect(activityIsNavigable(mockupEvent, lists)).toEqual({ kind: "mockup", name: "checkout-flow" });
  });

  it("returns null for a write whose own target has already vanished from the (now up to date) lists — review fix 2", () => {
    const event = { tool: "patch_html", target: { kind: "screen", name: "checkout-cart" } };
    const listsAfterDelete = { screenNames: [], mockupNames: [] };
    expect(activityIsNavigable(event, listsAfterDelete)).toBeNull();
  });

  it("never navigates for delete_entity, even while `lists` is stale and still lists the target — the ordering race between the activity and change SSE events (review fix 2)", () => {
    const event = { tool: "delete_entity", target: { kind: "screen", name: "checkout-cart" } };
    expect(activityIsNavigable(event, lists)).toBeNull(); // lists still says "checkout-cart" exists — must not matter
  });

  it("returns null for a broad read (no target) and a component/pattern target, same as activityNavigationTarget alone", () => {
    expect(activityIsNavigable({ target: null }, lists)).toBeNull();
    expect(activityIsNavigable({ target: { kind: "component", name: "tag-chip" } }, lists)).toBeNull();
  });
});

describe("formatActivityTarget", () => {
  it("labels a broad read project-wide", () => {
    expect(formatActivityTarget({ target: null, tool: "find_nodes", nodes: [] })).toBe("project-wide");
  });

  it("labels a screen target, appending the node id when exactly one is affected", () => {
    const event = { target: { kind: "screen", name: "checkout-cart" }, tool: "patch_html", nodes: ["checkout-cart.line-4"] };
    expect(formatActivityTarget(event)).toBe("screen · checkout-cart · line-4");
  });

  it("omits the node suffix for write_html — its node is the whole screen, not a specific element", () => {
    const event = { target: { kind: "screen", name: "checkout-cart" }, tool: "write_html", nodes: ["checkout-cart.root"] };
    expect(formatActivityTarget(event)).toBe("screen · checkout-cart");
  });

  it("omits the node suffix when more than one node is affected", () => {
    const event = {
      target: { kind: "screen", name: "checkout-cart" },
      tool: "patch_html",
      nodes: ["checkout-cart.line-1", "checkout-cart.line-2"],
    };
    expect(formatActivityTarget(event)).toBe("screen · checkout-cart");
  });

  it("labels a mockup target, with variant when present", () => {
    expect(formatActivityTarget({ target: { kind: "mockup", name: "checkout-flow" }, tool: "write_mockup", nodes: [] })).toBe(
      "mockup · checkout-flow",
    );
    expect(
      formatActivityTarget({ target: { kind: "mockup", name: "checkout-flow", variant: "option-b" }, tool: "write_mockup", nodes: [] }),
    ).toBe("mockup · checkout-flow / option-b");
  });

  it("labels a component target, with variant when present", () => {
    expect(formatActivityTarget({ target: { kind: "component", name: "tag-chip", variant: "active" }, tool: "promote_to_system", nodes: [] })).toBe(
      "component · tag-chip#active",
    );
  });

  it("labels a pattern target", () => {
    expect(formatActivityTarget({ target: { kind: "pattern", name: "checkout-layout" }, tool: "set_meta", nodes: [] })).toBe(
      "pattern · checkout-layout",
    );
  });
});

describe("formatActivityTime", () => {
  it("reads 'just now' for anything under a second old", () => {
    expect(formatActivityTime(1000, 1000)).toBe("just now");
  });

  it("reads '<n>s ago' under a minute", () => {
    expect(formatActivityTime(1000, 1000 + 4000)).toBe("4s ago");
  });

  it("reads '<n>m ago' at a minute or more", () => {
    expect(formatActivityTime(0, 90_000)).toBe("2m ago");
  });

  it("reads '<n>h ago' at an hour or more", () => {
    expect(formatActivityTime(0, 2 * 3600_000)).toBe("2h ago");
  });
});

describe("canFollowNavigate", () => {
  it("is true only while enabled and not paused", () => {
    expect(canFollowNavigate({ enabled: true, paused: false })).toBe(true);
  });

  it("is false while off", () => {
    expect(canFollowNavigate(FOLLOW_OFF)).toBe(false);
  });

  it("is false while paused — the re-check a throttled navigate must pass before it fires (review fix 1)", () => {
    expect(canFollowNavigate({ enabled: true, paused: true })).toBe(false);
  });
});

describe("resolveFollowNavigation", () => {
  const lists = { screenNames: ["checkout-cart"], mockupNames: [] };
  const followingEvent = { tool: "write_html", ok: true, target: { kind: "screen", name: "checkout-cart" } };

  it("returns the target while following and the target exists", () => {
    expect(resolveFollowNavigation(followingEvent, { enabled: true, paused: false }, lists)).toEqual({
      kind: "screen",
      name: "checkout-cart",
    });
  });

  it("returns null while off, even with a perfectly good target", () => {
    expect(resolveFollowNavigation(followingEvent, FOLLOW_OFF, lists)).toBeNull();
  });

  it("suppresses the navigation once a pause has arrived — the exact re-check a throttled navigate's timer callback relies on (review fix 1/8): the SAME event, queued while following, is re-resolved against a NOW-paused state and must not navigate", () => {
    // Simulates a navigate queued inside the 300ms throttle window (still
    // following at queue time), then re-resolved once the window closes —
    // by which point a human navigation (or an agent Board presentation)
    // has paused follow in between. The queued navigate must lose.
    const queuedAt = resolveFollowNavigation(followingEvent, { enabled: true, paused: false }, lists);
    expect(queuedAt).not.toBeNull(); // sanity: it WOULD have navigated, absent the pause
    const resolvedAtFireTime = resolveFollowNavigation(followingEvent, { enabled: true, paused: true }, lists);
    expect(resolvedAtFireTime).toBeNull();
  });

  it("returns null once the target has vanished, even while still following", () => {
    const listsAfterDelete = { screenNames: [], mockupNames: [] };
    expect(resolveFollowNavigation(followingEvent, { enabled: true, paused: false }, listsAfterDelete)).toBeNull();
  });

  it("never navigates for delete_entity, even while following and the (stale) lists still say the target exists", () => {
    const deleteEvent = { tool: "delete_entity", ok: true, target: { kind: "screen", name: "checkout-cart" } };
    expect(resolveFollowNavigation(deleteEvent, { enabled: true, paused: false }, lists)).toBeNull();
  });
});

describe("nextFollowState", () => {
  it("toggle-on always enables, unpaused", () => {
    expect(nextFollowState(FOLLOW_OFF, "toggle-on")).toEqual({ enabled: true, paused: false });
    expect(nextFollowState({ enabled: true, paused: true }, "toggle-on")).toEqual({ enabled: true, paused: false });
  });

  it("toggle-off always resets to FOLLOW_OFF", () => {
    expect(nextFollowState({ enabled: true, paused: true }, "toggle-off")).toEqual(FOLLOW_OFF);
    expect(nextFollowState({ enabled: true, paused: false }, "toggle-off")).toEqual(FOLLOW_OFF);
  });

  // A feed click now takes this exact "pause" transition too (ADR-005, the
  // 2026-09-18 feed exemption reversed the same day) — app.js's
  // handleActivityFeedSelect calls pauseFollow() unconditionally, same as a
  // sidebar click or a tab switch, so there is no separate pure fact left
  // to pin for the feed specifically; this is the one it now shares.
  it("pause only takes effect while enabled and not already paused", () => {
    const following = { enabled: true, paused: false };
    expect(nextFollowState(following, "pause")).toEqual({ enabled: true, paused: true });
    expect(nextFollowState(FOLLOW_OFF, "pause")).toBe(FOLLOW_OFF); // no-op — nothing to pause
    const paused = { enabled: true, paused: true };
    expect(nextFollowState(paused, "pause")).toBe(paused); // no-op — already paused
  });

  it("resume only takes effect while enabled and paused", () => {
    const paused = { enabled: true, paused: true };
    expect(nextFollowState(paused, "resume")).toEqual({ enabled: true, paused: false });
    expect(nextFollowState(FOLLOW_OFF, "resume")).toBe(FOLLOW_OFF); // no-op — was never on
    const following = { enabled: true, paused: false };
    expect(nextFollowState(following, "resume")).toBe(following); // no-op — nothing to resume
  });
});

describe("followToggleClickAction", () => {
  it("turns on from off, regardless of where the click landed", () => {
    expect(followToggleClickAction(FOLLOW_OFF, false)).toBe("toggle-on");
    expect(followToggleClickAction(FOLLOW_OFF, true)).toBe("toggle-on");
  });

  it("turns off from following", () => {
    expect(followToggleClickAction({ enabled: true, paused: false }, false)).toBe("toggle-off");
  });

  it("resumes from paused only when the click hit the Resume affordance", () => {
    const paused = { enabled: true, paused: true };
    expect(followToggleClickAction(paused, true)).toBe("resume");
  });

  it("turns off from paused when the click missed the Resume affordance", () => {
    const paused = { enabled: true, paused: true };
    expect(followToggleClickAction(paused, false)).toBe("toggle-off");
  });
});
