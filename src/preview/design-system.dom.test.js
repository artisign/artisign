// @vitest-environment jsdom
//
// Smoke tests for the Markdown call sites inside renderDesignSystem — idea,
// decision body and component usage each go through setMarkdown() now, and
// their containers are divs (a <p> cannot legally contain a table).
import { describe, it, expect } from "vitest";
import { renderDesignSystem } from "./design-system.js";

describe("renderDesignSystem", () => {
  const table = "| a | b |\n|---|---|\n| 1 | 2 |";

  it("renders a Markdown table inside the idea section, in a div", () => {
    const container = document.createElement("div");
    renderDesignSystem(container, { idea: table });
    const body = container.querySelector(".ds-idea-body");
    expect(body.tagName).toBe("DIV");
    expect(body.querySelector("table")).not.toBeNull();
  });

  it("renders a Markdown table inside a decision body, in a div", () => {
    const container = document.createElement("div");
    renderDesignSystem(container, {
      decisions: [{ id: "d1", date: "2026-01-01", title: "Decision", body: table, status: "active" }],
    });
    const text = container.querySelector(".ds-decision-text");
    expect(text.tagName).toBe("DIV");
    expect(text.querySelector("table")).not.toBeNull();
  });

  it("renders a Markdown table inside component usage, in a div", () => {
    const container = document.createElement("div");
    renderDesignSystem(container, {
      component_definitions: [{ name: "btn", variants: [{ name: "default", rendered_html: "<button></button>" }], usage: table }],
    });
    const usage = container.querySelector(".ds-usage");
    expect(usage.tagName).toBe("DIV");
    expect(usage.querySelector("table")).not.toBeNull();
  });
});
