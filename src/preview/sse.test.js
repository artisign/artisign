import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectEvents } from "./sse.js";

/** Minimal fake standing in for the browser's EventSource. */
class FakeEventSource {
  constructor(url) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  open() {
    this.onopen?.();
  }
  error() {
    this.onerror?.();
  }
  emit(data) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
FakeEventSource.instances = [];

describe("connectEvents", () => {
  const realEventSource = globalThis.EventSource;

  beforeEach(() => {
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource;
  });

  afterEach(() => {
    globalThis.EventSource = realEventSource;
  });

  it("dispatches parsed change events to onChange", () => {
    const onChange = vi.fn();
    connectEvents({ onChange });
    const [source] = FakeEventSource.instances;

    source.emit({ type: "change", kind: "screen", name: "home" });

    expect(onChange).toHaveBeenCalledWith({ type: "change", kind: "screen", name: "home" });
  });

  it("dispatches parsed lifecycle events to onLifecycle, not onChange", () => {
    const onChange = vi.fn();
    const onLifecycle = vi.fn();
    connectEvents({ onChange, onLifecycle });
    const [source] = FakeEventSource.instances;

    source.emit({ type: "project-opened", root: "/tmp/a" });
    source.emit({ type: "project-switched", root: "/tmp/b" });
    source.emit({ type: "project-closed", root: "/tmp/c" });

    expect(onLifecycle).toHaveBeenNthCalledWith(1, { type: "project-opened", root: "/tmp/a" });
    expect(onLifecycle).toHaveBeenNthCalledWith(2, { type: "project-switched", root: "/tmp/b" });
    expect(onLifecycle).toHaveBeenNthCalledWith(3, { type: "project-closed", root: "/tmp/c" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores unparseable message payloads instead of throwing", () => {
    const onChange = vi.fn();
    connectEvents({ onChange });
    const [source] = FakeEventSource.instances;

    expect(() => source.onmessage({ data: "not json" })).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("calls onOpen with isReconnect=false on the first open", () => {
    const onOpen = vi.fn();
    connectEvents({ onChange: () => {}, onOpen });
    FakeEventSource.instances[0].open();

    expect(onOpen).toHaveBeenCalledWith(false);
  });

  it("calls onOpen with isReconnect=true on every subsequent open, so the caller can resync missed changes", () => {
    const onOpen = vi.fn();
    connectEvents({ onChange: () => {}, onOpen });
    const [source] = FakeEventSource.instances;

    source.open();
    source.error();
    source.open();

    expect(onOpen).toHaveBeenNthCalledWith(1, false);
    expect(onOpen).toHaveBeenNthCalledWith(2, true);
  });

  it("calls onDisconnect on error", () => {
    const onDisconnect = vi.fn();
    connectEvents({ onChange: () => {}, onDisconnect });
    FakeEventSource.instances[0].error();

    expect(onDisconnect).toHaveBeenCalled();
  });

  it("includes ?project= in the URL when a project is given, and omits it otherwise", () => {
    connectEvents({ onChange: () => {} });
    connectEvents({ project: "/tmp/a b", onChange: () => {} });

    expect(FakeEventSource.instances[0].url).toBe("/events");
    expect(FakeEventSource.instances[1].url).toBe(`/events?project=${encodeURIComponent("/tmp/a b")}`);
  });
});
