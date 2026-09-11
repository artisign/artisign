// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderMarkdown, setMarkdown } from "./markdown.js";

function render(text) {
  const div = document.createElement("div");
  div.appendChild(renderMarkdown(text));
  return div;
}

describe("renderMarkdown", () => {
  it("maps heading levels 1-6 to h3-h6", () => {
    const div = render("# one\n## two\n### three\n#### four\n##### five\n###### six");
    const tags = [...div.children].map((el) => el.tagName);
    expect(tags).toEqual(["H3", "H4", "H5", "H6", "H6", "H6"]);
  });

  it("renders a soft line break inside a paragraph as br", () => {
    const div = render("first line\nsecond line");
    const p = div.querySelector("p");
    expect(p.innerHTML).toBe("first line<br>second line");
  });

  it("renders strong, em and code inline", () => {
    const div = render("**bold** and *italic* and `code`");
    const p = div.querySelector("p");
    expect(p.querySelector("strong").textContent).toBe("bold");
    expect(p.querySelector("em").textContent).toBe("italic");
    expect(p.querySelector("code").textContent).toBe("code");
  });

  it("keeps fenced code content literal, not inline-parsed", () => {
    const div = render("```\n**not bold** and `not code`\n```");
    const code = div.querySelector("pre > code");
    expect(code.textContent).toBe("**not bold** and `not code`");
    expect(code.querySelector("strong")).toBeNull();
  });

  it("renders an unordered list with one level of nesting", () => {
    const div = render("- a\n  - a1\n- b");
    const topList = div.querySelector("ul");
    const items = topList.querySelectorAll(":scope > li");
    expect(items).toHaveLength(2);
    expect(items[0].querySelector("ul > li").textContent).toBe("a1");
  });

  it("renders an ordered list", () => {
    const div = render("1. first\n2. second");
    const items = div.querySelectorAll("ol > li");
    expect([...items].map((li) => li.textContent)).toEqual(["first", "second"]);
  });

  it("renders a GFM table with header, body and alignment class", () => {
    const div = render("| a | b | c |\n|---|:-:|--:|\n| 1 | 2 | 3 |");
    const table = div.querySelector("table");
    const headers = [...table.querySelectorAll("thead th")];
    expect(headers.map((th) => th.textContent)).toEqual(["a", "b", "c"]);
    expect(headers[1].classList.contains("md-align-center")).toBe(true);
    expect(headers[2].classList.contains("md-align-right")).toBe(true);
    const cells = [...table.querySelectorAll("tbody td")];
    expect(cells.map((td) => td.textContent)).toEqual(["1", "2", "3"]);
  });

  it("renders a valid link with target and rel", () => {
    const div = render("[x](https://a)");
    const a = div.querySelector("a");
    expect(a.getAttribute("href")).toBe("https://a");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders a javascript: link as plain text with no anchor at all", () => {
    const div = render("[x](javascript:alert(1))");
    expect(div.querySelector("a")).toBeNull();
    expect(div.textContent).toContain("x");
  });

  it("never creates a script element, and its content survives as text", () => {
    const div = render("<script>alert(1)</script>");
    expect(div.querySelectorAll("script")).toHaveLength(0);
    expect(div.textContent).toContain("<script>alert(1)</script>");
  });

  it("never creates an img element from a raw HTML img tag", () => {
    const div = render('<img src=x onerror=alert(1)>');
    expect(div.querySelector("img")).toBeNull();
  });

  it("only ever produces elements from the by-construction tag whitelist", () => {
    const allowed = new Set([
      "DIV",
      "H3",
      "H4",
      "H5",
      "H6",
      "P",
      "UL",
      "OL",
      "LI",
      "TABLE",
      "THEAD",
      "TBODY",
      "TR",
      "TH",
      "TD",
      "PRE",
      "CODE",
      "STRONG",
      "EM",
      "A",
      "BR",
      "HR",
    ]);
    const kitchenSink = [
      "# heading",
      "",
      "some **bold** and *em* and `code` and [link](https://a) and <script>alert(1)</script>",
      "",
      "- one\n  - nested\n- two",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "---",
      "",
      "```",
      "fenced <b>not html</b>",
      "```",
    ].join("\n");
    const div = render(kitchenSink);
    const found = new Set([...div.querySelectorAll("*")].map((el) => el.tagName));
    for (const tag of found) expect(allowed.has(tag)).toBe(true);
  });

  it("returns an empty fragment for empty or whitespace-only input", () => {
    expect(render("").children).toHaveLength(0);
    expect(render("   \n  \n").children).toHaveLength(0);
  });
});

describe("setMarkdown", () => {
  it("replaces the element's children with the rendered fragment", () => {
    const el = document.createElement("div");
    el.textContent = "stale";
    setMarkdown(el, "**fresh**");
    expect(el.textContent).toBe("fresh");
    expect(el.querySelector("strong")).not.toBeNull();
  });
});
