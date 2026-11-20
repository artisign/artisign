// @vitest-environment jsdom
//
// A failed save in a dialog: the problem stays whole, the agent remedy never shows (real message shapes of the tools).
import { describe, it, expect } from "vitest";
import { saveErrorText } from "./usecases-parts.js";

describe("saveErrorText", () => {
  it("a single invalid file: the problem and the file, without the remedy", () => {
    const text = saveErrorText("invalid usecases/personas.json: personas.0.name: required — repair or remove the file by hand (the one case where usecases/ may be edited directly)");
    expect(text).toBe("personas.0.name: required (usecases/personas.json)");
  });

  it("validation_failed keeps its per-entry problems after 'nothing written'", () => {
    const message = "nothing written — use_cases (borrow-book).steps.1.target.node: required; personas (ana).name: required (+2 more)";
    expect(saveErrorText(message)).toBe(message);
  });

  it("several invalid stored cases keep each file's problem and lose the remedy", () => {
    const text = saveErrorText(
      '2 stored use cases are invalid, nothing written — invalid usecases/cases/a.json: steps.0.id: required | invalid usecases/cases/b.json: title: required — repair each file by hand (the one case where usecases/ may be edited directly) or remove the use case with delete_entity {kind: "use_case", name: "<id>"} and write it again with set_use_cases (the full case)',
    );
    expect(text).toBe("2 stored use cases are invalid, nothing written — invalid usecases/cases/a.json: steps.0.id: required | invalid usecases/cases/b.json: title: required");
    expect(text).not.toContain("by hand");
  });

  it("a refused delete keeps the references and loses 'remove these references' / 'pass force'", () => {
    const text = saveErrorText('persona "member" is used by use case borrow-book — remove these references first (set_use_cases), or pass force: true to delete anyway');
    expect(text).toBe('persona "member" is used by use case borrow-book');
  });

  it("an incomplete reference check keeps what failed to load", () => {
    const text = saveErrorText('cannot safely delete persona "member" — reference check is incomplete because the following case file(s) failed to load: usecases/cases/a.json — repair them, or pass force: true to delete anyway');
    expect(text).toBe('cannot safely delete persona "member" — reference check is incomplete because the following case file(s) failed to load: usecases/cases/a.json');
  });

  it("a message without a remedy is shown as it is", () => {
    expect(saveErrorText("Failed to fetch")).toBe("Failed to fetch");
  });
});
