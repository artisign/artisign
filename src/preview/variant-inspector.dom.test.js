// @vitest-environment jsdom
//
// CHR-1268 — the Inspect panel's variant cards.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildScreenTree } from "./screens.js";
import { variantContext } from "./variants.js";
import { renderVariantInspector } from "./variant-inspector.js";

const screens = [
  { name: "home", tags: [] },
  { name: "empty", tags: [], variant_of: "home", variant_kind: "state" },
  { name: "error", tags: [], variant_of: "home", variant_kind: "state" },
  { name: "loading", tags: [], variant_of: "home", variant_kind: "state" },
  { name: "history", tags: [] },
  { name: "account", tags: [] },
];
const flows = [
  { from: "history.btn", to: "empty" },
  { from: "account.link", to: "empty" },
  { from: "home.cta", to: "empty" }, // from its home: not "also reached from"
  { from: "empty.back", to: "home" },
];

let container;
beforeEach(() => {
  document.body.innerHTML = "<section id='c'></section>";
  container = document.getElementById("c");
});
const ctxOf = (name) => variantContext(buildScreenTree(screens), name);

describe("renderVariantInspector", () => {
  it("shows the Variant card (path, depth, siblings, flows) and the other flow sources", () => {
    const go = vi.fn();
    renderVariantInspector(container, ctxOf("empty"), flows, "empty", go);
    expect(container.hidden).toBe(false);
    const cards = [...container.querySelectorAll(".inspect-card")];
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector(".inspect-card-head").textContent).toBe("Variantstate");
    expect([...cards[0].querySelectorAll(".prop-row")].map((r) => r.textContent)).toEqual(["Pathhome", "Depth1", "Siblingserror, loading", "Flows3 in, 1 out"]);
    expect(cards[1].querySelector(".inspect-card-head").textContent).toBe("Also reached from2 flow sources");
    const links = [...cards[1].querySelectorAll(".inspect-kv-link")];
    expect(links.map((l) => l.textContent)).toEqual(["history", "account"]);
    links[1].click();
    expect(go).toHaveBeenCalledWith("account");
  });

  it("is hidden for a plain screen and for the main screen of a family; no second card without other sources", () => {
    renderVariantInspector(container, ctxOf("history"), flows, "history", () => {});
    expect(container.hidden).toBe(true);
    renderVariantInspector(container, ctxOf("home"), flows, "home", () => {});
    expect(container.hidden).toBe(true);
    expect(container.childElementCount).toBe(0);
    renderVariantInspector(container, ctxOf("error"), [], "error", () => {});
    expect(container.querySelectorAll(".inspect-card")).toHaveLength(1);
  });
});
