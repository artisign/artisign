// @vitest-environment jsdom
//
// The persona pool and data objects: dimensions table with value counts, persona cards (generated marker, open traits),
// paging of cards so thousands of generated personas never render at once, and the data-object cards.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderPersonaList, renderPersonaPage, renderObjectList, renderObjectPage, CARD_PAGE } from "./usecases-pool.js";
import { makePool, personas, dimensions } from "./usecases.test-helper.js";
import { indexById } from "./usecases-data.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function pageHandlers() {
  return { onNew: vi.fn(), onEdit: vi.fn(), onGenerate: vi.fn(), onEditDimension: vi.fn(), onMore: vi.fn() };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("persona page", () => {
  it("counts personas per dimension value, flags a value nobody has and notes who leaves a dimension open", () => {
    const el = document.createElement("div");
    const pool = makePool();
    renderPersonaPage(el, { pool, query: "", selectedId: null, limit: CARD_PAGE, usage: pool.usage, handlers: pageHandlers() });
    const size = $("[data-dimension=size]", el);
    expect($$(".uc-value-chip", size).map((c) => c.textContent)).toEqual(["Small project1", "Large project1", "Medium project1"]);
    const actor = $("[data-dimension=actor]", el);
    expect(actor.textContent).toContain("1 persona leaves it open (any value)"); // the generated one has no actor network
    const empty = makePool({ personas: personas.slice(0, 2) });
    renderPersonaPage(el, { pool: empty, query: "", selectedId: null, limit: CARD_PAGE, usage: empty.usage, handlers: pageHandlers() });
    expect($(".uc-value-chip.is-empty", el).textContent).toBe("Medium project0");
    expect(el.textContent).toContain("No persona has this value");
  });

  it("draws cards: avatar, role and id, trait chips, goals, usage; generated ones carry the marker and a dashed style", () => {
    const el = document.createElement("div");
    const pool = makePool();
    renderPersonaPage(el, { pool, query: "", selectedId: null, limit: CARD_PAGE, usage: pool.usage, handlers: pageHandlers() });
    const [dana, , gen] = $$(".uc-persona-card", el);
    expect(dana.textContent).toContain("Designer · dana");
    expect(dana.textContent).toContain("Project sizeSmall project");
    expect(dana.textContent).toContain("All steps at a glance");
    expect(dana.textContent).toContain("In 4 use cases");
    expect(dana.querySelector(".uc-generated")).toBeNull();
    expect(gen.classList.contains("is-generated")).toBe(true);
    expect(gen.querySelector(".uc-generated").textContent).toContain("Generated");
    expect(gen.textContent).toContain("No goals yet. Ask your agent");
    expect(gen.textContent).toContain("Not used in any use case yet");
    expect($(".uc-trait.is-any", gen).textContent).toContain("any"); // open dimensions are dashed 'any' chips
    expect(dana.querySelector(".uc-avatar").style.getPropertyValue("--avatar-color")).toBe("#4F7CAC");
  });

  it("wires New persona (button and tile), Generate, a card and a dimension name", () => {
    const el = document.createElement("div");
    const handlers = pageHandlers();
    const pool = makePool();
    renderPersonaPage(el, { pool, query: "", selectedId: null, limit: CARD_PAGE, usage: pool.usage, handlers });
    $$(".uc-actions button", el).find((b) => b.textContent.includes("New persona")).click();
    $(".uc-persona-new", el).click();
    expect(handlers.onNew).toHaveBeenCalledTimes(2);
    $$(".uc-actions button", el).find((b) => b.textContent.includes("Generate")).click();
    expect(handlers.onGenerate).toHaveBeenCalled();
    $(".uc-persona-open", el).click();
    expect(handlers.onEdit).toHaveBeenCalledWith("dana");
    $(".uc-dim-name", el).click();
    expect(handlers.onEditDimension).toHaveBeenCalledWith("size");
    $(".uc-h2-action", el).click();
    expect(handlers.onEditDimension).toHaveBeenLastCalledWith(null);
  });

  it("Generate is off until a dimension exists", () => {
    const el = document.createElement("div");
    const pool = makePool({ dimensions: [], dimensionsById: new Map() });
    renderPersonaPage(el, { pool, query: "", selectedId: null, limit: CARD_PAGE, usage: pool.usage, handlers: pageHandlers() });
    expect($$(".uc-actions button", el).find((b) => b.textContent.includes("Generate")).disabled).toBe(true);
    expect(el.textContent).toContain("No dimensions yet");
  });

  it("shows cards in pages: 3,000 generated personas render CARD_PAGE cards and a 'Show more' button", () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({ id: `gen-${i}`, name: `Generated ${i}`, traits: { size: "small" }, generated: true }));
    const pool = makePool({ personas: many, personasById: indexById(many) });
    const el = document.createElement("div");
    const handlers = pageHandlers();
    renderPersonaPage(el, { pool, query: "", selectedId: null, limit: CARD_PAGE, usage: pool.usage, handlers });
    expect($$(".uc-persona-card", el)).toHaveLength(CARD_PAGE);
    expect($(".uc-show-more", el).textContent).toContain("2,976");
    $(".uc-show-more", el).click();
    expect(handlers.onMore).toHaveBeenCalled();
    renderPersonaPage(el, { pool, query: "Generated 29", selectedId: null, limit: CARD_PAGE, usage: pool.usage, handlers });
    expect(el.querySelectorAll(".uc-h2-meta")[1].textContent).toContain("match");
    expect($(".uc-persona-new", el)).toBeNull(); // no 'new' tile while searching
  });
});

describe("persona list", () => {
  it("splits written and generated personas, pages long lists and never writes 'null' for an empty section", () => {
    const el = document.createElement("div");
    const pool = makePool();
    const handlers = { onSelect: vi.fn(), onMore: vi.fn() };
    renderPersonaList(el, { pool, query: "", selectedId: "dex", limit: 60, handlers });
    expect($$(".uc-plist-title", el).map((t) => t.textContent)).toEqual(["Written by people · 2", "Generated from dimensions · 1"]);
    expect($(".uc-plist-row.is-selected", el).textContent).toContain("Dex");
    expect(el.textContent).not.toContain("null");
    $$(".uc-plist-row", el)[0].click();
    expect(handlers.onSelect).toHaveBeenCalledWith("dana");
    renderPersonaList(el, { pool, query: "zzz", selectedId: null, limit: 60, handlers });
    expect(el.textContent).toBe("No persona matches.");
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `g${i}`, name: `G${i}`, traits: {}, generated: true }));
    renderPersonaList(el, { pool: makePool({ personas: many }), query: "", selectedId: null, limit: 60, handlers });
    expect($$(".uc-plist-row", el)).toHaveLength(60);
    expect($(".uc-link-btn", el).textContent).toBe("Show 440 more");
  });
});

describe("data objects", () => {
  it("lists object cards with field, type (ref → target) and example, and edits from the card", () => {
    const el = document.createElement("div");
    const handlers = { onNew: vi.fn(), onEdit: vi.fn(), onSelect: vi.fn() };
    const pool = makePool({ objects: [{ id: "mapping", name: "Mapping", description: "A day", fields: [{ name: "status", type: "enum", example: "ready" }, { name: "owner", type: "ref", ref: "owner" }] }] });
    renderObjectPage(el, { pool, query: "", selectedId: null, handlers });
    const card = $(".uc-object-card", el);
    expect(card.textContent).toContain("Mapping");
    expect(card.textContent).toContain("ref → owner");
    expect($$("tbody tr", card).map((r) => r.lastChild.textContent)).toEqual(["ready", "—"]);
    $(".uc-io-edit", card).click();
    expect(handlers.onEdit).toHaveBeenCalledWith("mapping");
    $$(".uc-actions button", el)[0].click();
    expect(handlers.onNew).toHaveBeenCalled();
    renderObjectList(el, { pool, query: "", selectedId: "mapping", handlers });
    expect($(".uc-plist-row.is-selected", el).textContent).toContain("2 fields");
  });

  it("says so when there are none, and when a search matches nothing", () => {
    const el = document.createElement("div");
    const handlers = { onNew: vi.fn(), onEdit: vi.fn(), onSelect: vi.fn() };
    renderObjectPage(el, { pool: makePool({ objects: [] }), query: "", selectedId: null, handlers });
    expect(el.textContent).toContain("No data objects yet");
    renderObjectPage(el, { pool: makePool(), query: "nothing-like-this", selectedId: null, handlers });
    expect(el.textContent).toContain("No data object matches.");
    expect(dimensions.length).toBeGreaterThan(0);
  });
});
