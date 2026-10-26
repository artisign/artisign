import { describe, it, expect } from "vitest";
import { whatsNewAction } from "./whats-new.js";

describe("whatsNewAction (CHR-928)", () => {
  it("only records the version when nothing is stored", () => {
    expect(whatsNewAction(null, "2.2.0")).toBe("record");
  });
  it("shows after an update", () => {
    expect(whatsNewAction("2.1.1", "2.2.0")).toBe("show");
    expect(whatsNewAction("2.1.1", "10.0.0")).toBe("show");
  });
  it("does nothing on the version already seen", () => {
    expect(whatsNewAction("2.2.0", "2.2.0")).toBe("none");
  });
  it("records instead of showing after a downgrade or an unusable stored value", () => {
    expect(whatsNewAction("3.0.0", "2.2.0")).toBe("record");
    expect(whatsNewAction("garbage", "2.2.0")).toBe("record");
  });
});
