// The pure part of the world editors (CHR-1154): the value text rule, conditions and state rows, the trigger in its three forms,
// branches and the payload builders of the pool dialogs. Everything a Save blocks on is a shape error; references are warnings.
import { describe, it, expect } from "vitest";
import {
  parseStateValue,
  formatStateValue,
  splitList,
  parseList,
  conditionDraft,
  blankCondition,
  stateDraft,
  blankState,
  buildConditions,
  buildState,
  triggerShape,
  buildTrigger,
  isIsoAt,
  branchDraft,
  blankBranch,
  buildBranch,
  participantWarning,
  buildEntityPayload,
  buildRelationshipTypePayload,
  buildConstellationPayload,
  relationshipDraft,
  draftMembers,
} from "./usecases-world-edit.js";

const fresh = () => ({ errors: [], fieldErrors: [] });

describe("value text rule (design rule 3)", () => {
  it("reads true/false as booleans, a plain number as a number, quotes force text, everything else is text", () => {
    expect(["true", "false", "17", "0.15", "-3", "2027-01-01", '"17"', '"true"', "premium", " padded "].map(parseStateValue)).toEqual([true, false, 17, 0.15, -3, "2027-01-01", "17", "true", "premium", "padded"]);
    expect(parseStateValue('""')).toBe("");
  });

  it("writes a string that would read back as another type in quotes, so text -> value -> text is stable", () => {
    for (const value of [true, false, 17, 0.15, "2027-01-01", "17", "true", "", " pad", "plain text"]) expect(parseStateValue(formatStateValue(value))).toBe(value);
    expect(formatStateValue("17")).toBe('"17"');
    expect(formatStateValue(null)).toBe("null");
    expect(formatStateValue({ a: 1 })).toBe('{"a":1}');
  });

  it("'is one of' takes a comma list, each item read the same way, commas inside quotes stay", () => {
    expect(parseList('draft, 17, true, "a, b"')).toEqual(["draft", 17, true, "a, b"]);
    expect(splitList('a,"b,c",d')).toEqual(["a", '"b,c"', "d"]);
    expect(parseList(" , ")).toEqual([]);
  });
});

describe("condition rows", () => {
  const build = (rows) => {
    const state = fresh();
    return { out: buildConditions(rows, { path: "c", label: "Condition", ...state }), ...state };
  };

  it("writes a stored row back untouched, keeps `op` only when it was stored or is not the default", () => {
    const stored = [{ subject: "policy", property: "premium", op: "gt", value: 0.15 }, { subject: "leo", property: "age", value: 17 }, { subject: "leo", property: "co-insured", op: "eq", value: true }];
    expect(build(stored.map(conditionDraft)).out).toEqual(stored);
    const added = { ...blankCondition(), subject: "leo", property: "age", value: "18" };
    expect(build([added]).out).toEqual([{ subject: "leo", property: "age", value: 18 }]);
    expect(build([{ ...added, op: "gte" }]).out).toEqual([{ subject: "leo", property: "age", op: "gte", value: 18 }]);
  });

  it("is one of needs at least one value; the list is stored as an array", () => {
    const row = { ...blankCondition(), subject: "copy", property: "status", op: "in", value: "available, on-loan" };
    expect(build([row]).out).toEqual([{ subject: "copy", property: "status", op: "in", value: ["available", "on-loan"] }]);
    const empty = build([{ ...row, value: " , " }]);
    expect(empty.fieldErrors).toEqual([{ path: "c.0.value", message: "Add at least one value, separated by commas.", untilTouched: true }]);
    expect(empty.errors).toHaveLength(1);
  });

  it("a row without subject or property is an error that waits until the row is left", () => {
    const { errors, fieldErrors } = build([blankCondition()]);
    expect(errors).toEqual(["Condition 1: pick a subject and name the property."]);
    expect(fieldErrors[0]).toMatchObject({ path: "c.0", untilTouched: true });
  });

  it("an edited `in` row reads the new list, an untouched one keeps its stored array", () => {
    const stored = conditionDraft({ subject: "a", property: "b", op: "in", value: ["x", 1] });
    expect(stored.value).toBe("x, 1");
    expect(build([stored]).out[0].value).toEqual(["x", 1]);
    expect(build([{ ...stored, value: "x, 2" }]).out[0].value).toEqual(["x", 2]);
  });
});

describe("starting-state rows", () => {
  const build = (rows, nameOf) => {
    const state = fresh();
    return { out: buildState(rows, { path: "s", label: "State row", nameOf, ...state }), ...state };
  };
  const row = (subject, property, value) => ({ ...blankState(), subject, property, value });

  it("one entry per (subject, property): a second row with the same key is an error on its Property field", () => {
    const { out, errors, fieldErrors } = build([row("leo", "age", "17"), row("leo", "age", "18")], (id) => (id === "leo" ? "Leo" : id));
    expect(out).toEqual([{ subject: "leo", property: "age", value: 17 }]);
    expect(errors).toEqual(["State row 2: Leo · age is already set above. Change that row instead."]);
    expect(fieldErrors).toEqual([{ path: "s.1.property", message: "Leo · age is already set above. Change that row instead." }]);
  });

  it("the same property on another subject is fine; a stored value comes back exactly as it was", () => {
    const stored = [{ subject: "policy", property: "premium", value: 120 }, { subject: "leo", property: "premium", value: "120" }, { subject: "system", property: "ok", value: null }];
    const { out, errors } = build(stored.map(stateDraft));
    expect(errors).toEqual([]);
    expect(out).toEqual(stored);
  });

  it("a variant row can unset a key: no value, `unset: true`", () => {
    const { out } = build([stateDraft({ subject: "jon", property: "consent", unset: true })]);
    expect(out).toEqual([{ subject: "jon", property: "consent", unset: true }]);
  });

  it("an empty value waits until the row is left", () => {
    const { fieldErrors } = build([row("leo", "age", "")]);
    expect(fieldErrors).toEqual([{ path: "s.0.value", message: "Enter a value.", untilTouched: true }]);
  });
});

describe("trigger", () => {
  const build = ({ text, shape, orig }) => {
    const state = fresh();
    const origText = orig === undefined ? undefined : typeof orig === "string" ? orig : orig.text;
    return { value: buildTrigger({ text, origText, shape, orig }, { path: "t", label: "Trigger", ...state }), ...state };
  };

  it("reads the three forms from what is stored", () => {
    expect(triggerShape("a sentence").kind).toBe("text");
    expect(triggerShape({ text: "x" }).kind).toBe("text");
    expect(triggerShape({ text: "x", actor: "insurer", via: "webhook" })).toMatchObject({ kind: "action", actor: "insurer", via: "webhook" });
    expect(triggerShape({ text: "x", state: [{ subject: "a", property: "b", value: 1 }], at: "2027-01-01" })).toMatchObject({ kind: "state", at: "2027-01-01" });
    expect(triggerShape(undefined).kind).toBe("text");
  });

  it("an untouched trigger is written back exactly as stored: a string stays a string, an object stays an object", () => {
    for (const orig of ["plain", { text: "x" }, { text: "x", actor: "insurer", via: "email" }, { text: "x", state: [{ subject: "a", property: "b", op: "lt", value: 3 }], at: "2027-01-01T09:00" }]) {
      const { value, errors } = build({ text: typeof orig === "string" ? orig : orig.text, shape: triggerShape(orig), orig });
      expect(errors).toEqual([]);
      expect(value).toBe(orig);
    }
  });

  it("text form: the trimmed text, or no trigger at all when it is empty", () => {
    expect(build({ text: " Ana finds a book ", shape: triggerShape(undefined) }).value).toBe("Ana finds a book");
    expect(build({ text: "  ", shape: triggerShape(undefined) }).value).toBeUndefined();
  });

  it("action form: actor and via, trimmed; without an actor it is the text alone; via without an actor is a shape error", () => {
    const shape = { ...triggerShape(undefined), kind: "action", actor: "insurer", via: " webhook " };
    expect(build({ text: "sends the notice", shape }).value).toEqual({ text: "sends the notice", actor: "insurer", via: "webhook" });
    expect(build({ text: "sends the notice", shape: { ...shape, via: "" } }).value).toEqual({ text: "sends the notice", actor: "insurer" });
    expect(build({ text: "sends the notice", shape: { ...shape, actor: "", via: "" } }).value).toBe("sends the notice");
    const bad = build({ text: "x", shape: { ...shape, actor: "" } });
    expect(bad.errors).toEqual(["Trigger: via names the channel and needs an actor."]);
    expect(bad.fieldErrors).toEqual([{ path: "t.via", message: "Via names the channel and needs an actor." }]);
  });

  it("state or time form: conditions and at, never an actor; neither one is the text alone", () => {
    const rows = [{ ...blankCondition(), subject: "policy", property: "status", value: "active" }];
    const shape = { ...triggerShape(undefined), kind: "state", conditions: rows, at: "2027-01-01" };
    expect(build({ text: "Renewal date reached", shape }).value).toEqual({ text: "Renewal date reached", state: [{ subject: "policy", property: "status", value: "active" }], at: "2027-01-01" });
    expect(build({ text: "Renewal", shape: { ...shape, at: "" } }).value).toEqual({ text: "Renewal", state: [{ subject: "policy", property: "status", value: "active" }] });
    expect(build({ text: "Only time", shape: { ...shape, conditions: [] } }).value).toEqual({ text: "Only time", at: "2027-01-01" });
    expect(build({ text: "Nothing", shape: { ...shape, conditions: [], at: "" } }).value).toBe("Nothing");
  });

  it("a malformed `at` is a shape error with the design copy; dates are calendar-checked", () => {
    const shape = { ...triggerShape(undefined), kind: "state", at: "01.01.2027" };
    const { errors, fieldErrors } = build({ text: "x", shape });
    expect(errors).toEqual(["Trigger: Use a date (2027-01-01) or a date and time (2027-01-01T09:00)."]);
    expect(fieldErrors[0].path).toBe("t.at");
    expect(["2027-01-01", "2027-01-01T09:00", "2027-01-01T09:00:30Z", "2027-12-31T23:59+01:00"].every(isIsoAt)).toBe(true);
    expect(["2027-02-31", "2027-13-01", "2027-01-01T25:00", "tomorrow", ""].some(isIsoAt)).toBe(false);
  });

  it("clearing the text of a structured trigger keeps the structure (N5); switching to Text is the explicit way to drop it", () => {
    const stored = { text: "The insurer calls", actor: "insurer", via: "phone" };
    const cleared = build({ text: "", shape: triggerShape(stored), orig: stored });
    expect(cleared.errors).toEqual([]);
    expect(cleared.value).toEqual({ text: "", actor: "insurer", via: "phone" });
    const toText = build({ text: "", shape: { ...triggerShape(stored), kind: "text" }, orig: stored });
    expect(toText.value).toBeUndefined(); // the trigger is removed: the caller sends null
    expect(build({ text: "Still a sentence", shape: { ...triggerShape(stored), kind: "text" }, orig: stored }).value).toBe("Still a sentence");
  });
});

describe("branches", () => {
  const stored = { id: "limit", title: "Loan limit reached", from: "borrow", when: [{ subject: "ana", property: "open-loans", op: "gte", value: 5 }], steps: [{ id: "show-limit", actor: "system", action: "Explains the limit", via: "banner" }], rejoin: "done" };
  const build = (draft, options = {}) => {
    const state = fresh();
    return { out: buildBranch(draft, { taken: new Map([["borrow", "step 2 of the main flow"], ["done", "step 3 of the main flow"]]), ids: new Set(), ...state, ...options }), ...state };
  };

  it("an untouched stored branch comes back as stored", () => {
    const { out, errors } = build(branchDraft(stored), { lockId: true });
    expect(errors).toEqual([]);
    expect(out).toEqual(stored);
  });

  it("a branch needs a title, a condition and a step: the design copy", () => {
    const draft = { ...blankBranch({ from: "borrow" }), when: [] };
    draft.steps = [];
    const { errors, fieldErrors } = build(draft);
    expect(errors).toEqual(expect.arrayContaining(["Branch needs a title.", "Add at least one condition. A branch without one cannot be saved.", "Add at least one step. A branch without one cannot be saved."]));
    expect(fieldErrors.map((e) => e.path)).toEqual(expect.arrayContaining(["branch.title", "branch.when", "branch.steps"]));
  });

  it("a step id is one namespace with the main flow and every other branch, said with the place", () => {
    const draft = branchDraft(stored);
    draft.steps[0].id = "done";
    const { errors, fieldErrors } = build(draft, { lockId: true });
    expect(errors).toEqual(["Branch step 1: done is already step 3 of the main flow. Give this step another id."]);
    expect(fieldErrors).toEqual([{ path: "branch.step.0.id", message: "done is already step 3 of the main flow. Give this step another id." }]);
    const other = build(draft, { lockId: true, taken: new Map([["done", "step 2B.1 of branch 2B"]]) });
    expect(other.fieldErrors[0].message).toBe("done is already step 2B.1 of branch 2B. Give this step another id.");
    // two steps of the branch itself may not share an id either
    draft.steps[0].id = "again";
    draft.steps.push({ ...draft.steps[0] });
    expect(build(draft, { lockId: true }).errors[0]).toContain("again is already step 1 of this branch");
  });

  it("a blank id is derived from the title / action and never collides", () => {
    const draft = blankBranch({ from: "borrow", rejoin: "done" });
    Object.assign(draft, { title: "Offline", ends: false });
    draft.when = [{ ...blankCondition(), subject: "system", property: "connectivity", value: "offline" }];
    draft.steps[0].action = "Done";
    const { out, errors } = build(draft, { ids: new Set(["offline"]) });
    expect(errors).toEqual([]);
    expect(out.id).toBe("offline-2");
    expect(out.steps[0].id).toBe("done-2"); // "done" is a main-flow step
    expect(out.rejoin).toBe("done");
    expect(out).not.toHaveProperty("outcome");
  });

  it("a branch that ends the case keeps its outcome and no rejoin; one that continues has no outcome", () => {
    const ends = branchDraft({ ...stored, rejoin: undefined, outcome: "Nothing is recorded" });
    expect(build(ends, { lockId: true }).out).toMatchObject({ outcome: "Nothing is recorded" });
    expect(build(ends, { lockId: true }).out).not.toHaveProperty("rejoin");
    const continues = { ...branchDraft(stored), outcome: "typed then switched" };
    expect(build(continues, { lockId: true }).out).not.toHaveProperty("outcome");
  });
});

describe("participants", () => {
  const ends = { personasById: new Map([["ana", {}]]), entitiesById: new Map([["copy", {}]]) };
  it("is silent for personas, entities and the system, and says what to do for anything else", () => {
    expect(["ana", "copy", "system", ""].map((id) => participantWarning(id, ends))).toEqual(["", "", "", ""]);
    expect(participantWarning("grandma", ends)).toBe("grandma is neither a persona nor an entity. Add it to the world or pick another subject.");
  });
});

describe("pool payloads", () => {
  it("entity: the system id is reserved, the rest is optional and cleared keys become null", () => {
    const draft = { name: "Leo", type: "", description: "", emoji: "", traits: { "age-band": "" }, object: "" };
    expect(buildEntityPayload({ id: "leo", draft, source: null }).payload).toEqual({ id: "leo", name: "Leo" });
    expect(buildEntityPayload({ id: "system", draft, source: null }).errors).toEqual(["system is reserved for artisign itself. Pick another id."]);
    expect(buildEntityPayload({ id: "Leo!", draft, source: null }).errors[0]).toContain("kebab-case");
    expect(buildEntityPayload({ id: "x", draft: { ...draft, name: " " }, source: null }).errors).toEqual(["A name is required."]);
    const source = { id: "leo", name: "Leo", type: "Child", description: "d", avatar: { emoji: "🧒" }, traits: { a: "b" }, object: "child" };
    expect(buildEntityPayload({ id: "leo", draft, source }).payload).toEqual({ id: "leo", name: "Leo", type: null, description: null, avatar: null, traits: null, object: null });
    expect(buildEntityPayload({ id: "leo", draft: { ...draft, type: " Child ", emoji: "🧒", traits: { a: "b" }, object: "child" }, source }).payload).toMatchObject({ type: "Child", avatar: { emoji: "🧒" }, traits: { a: "b" }, object: "child" });
  });

  it("relationship type: label required, a field needs its name, inverse is never derived", () => {
    const draft = { label: "is parent of", inverse: "", description: "", sameTraits: [], fieldObject: "", fieldName: "" };
    expect(buildRelationshipTypePayload({ id: "parent-of", draft, source: null }).payload).toEqual({ id: "parent-of", label: "is parent of" });
    expect(buildRelationshipTypePayload({ id: "parent-of", draft: { ...draft, fieldObject: "policy" }, source: null }).errors[0]).toContain("Pick the field");
    expect(buildRelationshipTypePayload({ id: "holds", draft: { ...draft, inverse: "is held by", sameTraits: ["household"], fieldObject: "policy", fieldName: "holder" }, source: null }).payload).toEqual({ id: "holds", label: "is parent of", inverse_label: "is held by", same_traits: ["household"], field: { object: "policy", name: "holder" } });
    expect(buildRelationshipTypePayload({ id: "holds", draft, source: { inverse_label: "x", field: { object: "o", name: "n" }, same_traits: ["h"] } }).payload).toMatchObject({ inverse_label: null, field: null, same_traits: null });
  });

  it("constellation: every relationship needs from, type and to (they wait until left); notes survive; generated is kept", () => {
    const draft = { name: "Family", description: "", traits: { household: "" }, relationships: [relationshipDraft({ from: "maria", type: "holds", to: "policy", note: "since 2019" }), { from: "", type: "", to: "", note: "" }], generated: false };
    const bad = buildConstellationPayload({ id: "family", draft, source: null });
    expect(bad.errors).toEqual(["Relationship 2 needs from, a type and to."]);
    expect(bad.fieldErrors[0]).toMatchObject({ path: "relationship.1", untilTouched: true });
    draft.relationships.pop();
    expect(buildConstellationPayload({ id: "family", draft, source: null }).payload).toEqual({ id: "family", name: "Family", relationships: [{ from: "maria", type: "holds", to: "policy", note: "since 2019" }] });
    expect(buildConstellationPayload({ id: "family", draft: { ...draft, generated: true }, source: null }).payload.generated).toBe(true);
    expect(buildConstellationPayload({ id: "family", draft: { ...draft, generated: false }, source: { generated: true } }).payload.generated).toBeNull();
    // a participant that is not in the pool is not an error here (it is a warning in the dialog)
    expect(buildConstellationPayload({ id: "family", draft: { ...draft, relationships: [{ from: "ghost", type: "holds", to: "ghost", note: "" }] }, source: null }).errors).toBeUndefined();
  });

  it("members are the ends of the relationships, in order of first appearance", () => {
    expect(draftMembers([{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "", to: "a" }])).toEqual(["a", "b", "c"]);
  });
});
