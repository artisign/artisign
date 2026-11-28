import { describe, it, expect } from "vitest";
import { stackMode } from "./right-column.js";

const base = { agentDocked: true, agentShown: true, agentFolded: false, panelDocked: true, panelShown: true };

describe("stackMode (CHR-1286)", () => {
  it("splits the column while both docked cards are open", () => {
    expect(stackMode(base)).toBe("split");
  });
  it("puts the panel under the folded head", () => {
    expect(stackMode({ ...base, agentFolded: true })).toBe("below");
  });
  it("leaves free cards, a closed panel and views without an Agent bar alone", () => {
    expect(stackMode({ ...base, agentDocked: false })).toBe("none");
    expect(stackMode({ ...base, panelDocked: false })).toBe("none");
    expect(stackMode({ ...base, panelShown: false })).toBe("none");
    expect(stackMode({ ...base, agentShown: false })).toBe("none");
  });
});
