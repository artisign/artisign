// @vitest-environment jsdom
//
// CHR-1179 — the load-problem panel when the daemon cannot be reached: one message that says what to do, and no
// "look at the terminal" hint (the daemon runs in the background without a terminal of its own).
import { describe, it, expect } from "vitest";
import { renderLoadProblem } from "./usecases-problem.js";
import { NOT_RUNNING_MESSAGE } from "./usecases-data.js";

describe("renderLoadProblem", () => {
  it("shows the not-running message and no terminal hint when the daemon is unreachable", () => {
    const el = document.createElement("div");
    renderLoadProblem(el, { message: NOT_RUNNING_MESSAGE, onRetry: () => {} });
    expect(el.querySelector(".uc-problem-detail").textContent).toBe("artisign is not running. Start it with `artisign start`, then press Retry.");
    expect(el.querySelector(".uc-problem-hint")).toBeNull();
    expect(el.querySelector("[data-action=retry]")).not.toBeNull();
  });

  it("keeps the specific message and the hint for other failures", () => {
    const el = document.createElement("div");
    renderLoadProblem(el, { message: "disk on fire", onRetry: () => {} });
    expect(el.querySelector(".uc-problem-detail").textContent).toBe("disk on fire");
    expect(el.querySelector(".uc-problem-hint").textContent).toContain("terminal");
  });
});
