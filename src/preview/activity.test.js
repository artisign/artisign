import { describe, it, expect } from "vitest";
import {
  ACTIVITY_FEED_LIMIT,
  pushActivityEntry,
  activityNavigationTarget,
  highlightDurationMs,
  activityVariant,
  activityIsActionable,
  describeActivity,
  activityTargetExists,
  activityIsNavigable,
  canFollowNavigate,
  resolveFollowNavigation,
  followAwaitsTarget,
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

describe("activityVariant", () => {
  it("is error for a failed call regardless of kind", () => {
    expect(activityVariant({ ok: false, kind: "read" })).toBe("error");
    expect(activityVariant({ ok: false, kind: "write" })).toBe("error");
  });

  it("is write for a successful write, default for a successful read", () => {
    expect(activityVariant({ ok: true, kind: "write" })).toBe("write");
    expect(activityVariant({ ok: true, kind: "read" })).toBe("default");
  });

  it("is deleted when the target is gone, except for the delete itself (its target is gone by definition)", () => {
    expect(activityVariant({ ok: true, kind: "read", tool: "get_screen" }, true)).toBe("deleted");
    expect(activityVariant({ ok: true, kind: "write", tool: "delete_entity" }, true)).toBe("write");
  });

  it("is agent-comment for the agent's comment tools", () => {
    expect(activityVariant({ ok: true, kind: "write", tool: "create_comment" })).toBe("agent-comment");
    expect(activityVariant({ ok: true, kind: "write", tool: "reply_comment" })).toBe("agent-comment");
  });
});

describe("activityIsActionable", () => {
  const ok = { ok: true, tool: "get_screen", kind: "read", target: { kind: "screen", name: "home" } };

  it("is true for a call that worked on a screen, mockup, component or pattern that exists", () => {
    expect(activityIsActionable(ok, true)).toBe(true);
    expect(activityIsActionable({ ...ok, target: { kind: "mockup", name: "m" } }, true)).toBe(true);
    expect(activityIsActionable({ ...ok, target: { kind: "component", name: "btn" } }, true)).toBe(true);
    expect(activityIsActionable({ ...ok, target: { kind: "pattern", name: "p" } }, true)).toBe(true);
  });

  it("is false for a failed call, a gone target, a delete and a broad read", () => {
    expect(activityIsActionable({ ...ok, ok: false }, true)).toBe(false);
    expect(activityIsActionable(ok, false)).toBe(false);
    expect(activityIsActionable({ ...ok, tool: "delete_entity" }, true)).toBe(false);
    expect(activityIsActionable({ ...ok, target: null }, true)).toBe(false);
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

describe("describeActivity", () => {
  const say = (event, options) => {
    const { before, name, after } = describeActivity({ ok: true, nodes: [], ...event }, options);
    return `${before}${name ?? ""}${after}`;
  };

  it("says what a write did and what it is doing now", () => {
    const event = { tool: "write_html", kind: "write", target: { kind: "screen", name: "home" } };
    expect(say(event)).toBe("Wrote home");
    expect(say(event, { progressive: true })).toBe("Writing home");
    expect(describeActivity({ ...event, ok: true, nodes: [] }).name).toBe("home"); // the one bold part
  });

  it("names the one affected node after a patch, but not after write_html (its node is the screen root)", () => {
    expect(say({ tool: "patch_html", kind: "write", target: { kind: "screen", name: "home" }, nodes: ["home.btn-new"] })).toBe("Updated home, btn-new");
    expect(say({ tool: "write_html", kind: "write", target: { kind: "screen", name: "home" }, nodes: ["home.root"] })).toBe("Wrote home");
    expect(say({ tool: "patch_html", kind: "write", target: { kind: "screen", name: "home" }, nodes: ["home.a", "home.b"] })).toBe("Updated home");
  });

  it("reads, inspects, and says broad calls in a few words", () => {
    expect(say({ tool: "get_screen", kind: "read", target: { kind: "screen", name: "home" } })).toBe("Read home");
    expect(say({ tool: "inspect_node", kind: "read", target: { kind: "screen", name: "cart" }, nodes: ["cart.note"] })).toBe("Inspected cart, note");
    expect(say({ tool: "get_project", kind: "read", target: null })).toBe("Read the project");
    expect(say({ tool: "get_design_system", kind: "read", target: null })).toBe("Read the design system");
    expect(describeActivity({ ok: true, tool: "get_project", kind: "read", target: null, nodes: [] }).name).toBeNull();
  });

  it("names a mockup with its variant, a component and a pattern with their kind", () => {
    expect(say({ tool: "write_mockup", kind: "write", target: { kind: "mockup", name: "orders", variant: "b" } })).toBe("Wrote mockup orders, variant b");
    expect(say({ tool: "set_meta", kind: "write", target: { kind: "component", name: "tag-chip" } })).toBe("Updated component tag-chip");
    expect(say({ tool: "set_meta", kind: "write", target: { kind: "pattern", name: "checkout-layout" } })).toBe("Updated pattern checkout-layout");
  });

  it("says a failed call in plain words (the daemon sends no reason)", () => {
    expect(say({ tool: "patch_html", kind: "write", ok: false, target: { kind: "screen", name: "settings" } })).toBe("Could not update settings");
    expect(say({ tool: "get_screen", kind: "read", ok: false, target: { kind: "screen", name: "settings" } }, { progressive: true })).toBe("Could not read settings");
  });

  it("says a gone target, but not for the delete that removed it", () => {
    expect(say({ tool: "get_screen", kind: "read", target: { kind: "screen", name: "cart" } }, { gone: true })).toBe("Read cart, which no longer exists");
    expect(say({ tool: "delete_entity", kind: "write", target: { kind: "screen", name: "cart" } }, { gone: true })).toBe("Deleted cart");
  });
});

describe("formatActivityTime", () => {
  it("reads 'now' under a minute", () => {
    expect(formatActivityTime(1000, 1000)).toBe("now");
    expect(formatActivityTime(1000, 1000 + 59_000)).toBe("now");
  });

  it("reads '<n> min ago' from a minute to an hour", () => {
    expect(formatActivityTime(0, 60_000)).toBe("1 min ago");
    expect(formatActivityTime(0, 125_000)).toBe("2 min ago");
  });

  it("reads '<n> h ago' at an hour or more", () => {
    expect(formatActivityTime(0, 2 * 3600_000)).toBe("2 h ago");
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
  it("turns on from off", () => {
    expect(followToggleClickAction(FOLLOW_OFF)).toBe("toggle-on");
  });

  it("turns off from following and from paused (a paused follow is resumed by its own button)", () => {
    expect(followToggleClickAction({ enabled: true, paused: false })).toBe("toggle-off");
    expect(followToggleClickAction({ enabled: true, paused: true })).toBe("toggle-off");
  });
});

describe("resolveFollowNavigation — component/pattern targets (CHR-779)", () => {
  const lists = { screenNames: [], mockupNames: [] };
  const following = { enabled: true, paused: false };
  it("navigates to a component/pattern target while following", () => {
    expect(resolveFollowNavigation({ tool: "write_html", target: { kind: "component", name: "btn" } }, following, lists)).toEqual({ kind: "component", name: "btn" });
    expect(resolveFollowNavigation({ tool: "set_meta", target: { kind: "pattern", name: "hero" } }, following, lists)).toEqual({ kind: "pattern", name: "hero" });
  });
  it("never when paused/off or for delete_entity", () => {
    const event = { tool: "write_html", target: { kind: "component", name: "btn" } };
    expect(resolveFollowNavigation(event, { enabled: true, paused: true }, lists)).toBeNull();
    expect(resolveFollowNavigation(event, FOLLOW_OFF, lists)).toBeNull();
    expect(resolveFollowNavigation({ ...event, tool: "delete_entity" }, following, lists)).toBeNull();
  });
});

describe("followAwaitsTarget (CHR-779)", () => {
  const lists = { screenNames: ["a"], mockupNames: [] };
  const following = { enabled: true, paused: false };
  const screenEvent = (name, tool = "write_html") => ({ tool, target: { kind: "screen", name } });
  it("holds a screen/mockup target the lists do not contain yet", () => {
    expect(followAwaitsTarget(screenEvent("fresh"), following, lists)).toBe(true);
    expect(followAwaitsTarget({ tool: "promote_mockup", target: { kind: "mockup", name: "m" } }, following, lists)).toBe(true);
  });
  it("does not hold an existing target, a component target, a broad read, a delete, or when not following", () => {
    expect(followAwaitsTarget(screenEvent("a"), following, lists)).toBe(false);
    expect(followAwaitsTarget({ tool: "write_html", target: { kind: "component", name: "x" } }, following, lists)).toBe(false);
    expect(followAwaitsTarget({ tool: "get_project", target: null }, following, lists)).toBe(false);
    expect(followAwaitsTarget(screenEvent("fresh", "delete_entity"), following, lists)).toBe(false);
    expect(followAwaitsTarget(screenEvent("fresh"), { enabled: true, paused: true }, lists)).toBe(false);
  });
});
