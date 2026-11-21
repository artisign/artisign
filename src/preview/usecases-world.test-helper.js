// Fixtures of the world model views (ADR-011): a home-insurance renewal with personas, entities, constellations, a starting
// state, three branches and one variant — the bundles get_use_case returns for the base case and for that variant.

import { indexById } from "./usecases-data.js";

export const dimensions = [
  { id: "channel", name: "Channel", values: [{ id: "app", label: "App" }, { id: "letter", label: "Letter" }] },
  { id: "household", name: "Household", scope: "constellations", values: [{ id: "two-parents", label: "Two parents" }, { id: "single-parent", label: "Single parent" }, { id: "blended", label: "Blended family" }] },
];

export const personas = [
  { id: "maria", name: "Maria", kind: "human", role: "Policyholder", avatar: { emoji: "👩", color: "#4F7CAC" }, traits: { channel: "app" } },
  { id: "jon", name: "Jon", kind: "human", avatar: { emoji: "👨", color: "#6E8B3D" }, traits: { channel: "letter" } },
  { id: "insurer", name: "Insurer North", kind: "organization", avatar: { emoji: "🏢", color: "#7B5EA7" }, traits: {} },
];

export const entities = [
  { id: "leo", name: "Leo", type: "Child", avatar: { emoji: "🧒" } },
  { id: "policy", name: "Household liability policy", type: "Policy", avatar: { emoji: "📄" } },
];

export const relationshipTypes = [
  { id: "partner-of", label: "is partner of" },
  { id: "parent-of", label: "is parent of" },
  { id: "holds", label: "holds" },
];

export const constellations = [
  { id: "two-parents", name: "Two parents, one child", traits: { household: "two-parents" }, relationships: [{ from: "maria", type: "partner-of", to: "jon" }, { from: "maria", type: "parent-of", to: "leo", note: "Primary caregiver" }, { from: "maria", type: "holds", to: "policy" }] },
  { id: "single-parent", name: "Single parent, one child", traits: { household: "single-parent" }, relationships: [{ from: "maria", type: "parent-of", to: "leo" }, { from: "maria", type: "holds", to: "policy" }] },
];

const step = (id, actor, action, target, extra = {}) => ({ id, actor, action, ...(target ? { target } : {}), ...extra });

export const baseCase = {
  id: "review-premium",
  title: "Review a premium increase",
  group: "policies/renewal",
  status: "ready",
  personas: ["maria"],
  constellations: ["two-parents", "single-parent", "three-generations"],
  trigger: { text: "sends the renewal notice", actor: "insurer", via: "webhook" },
  goal: "Decide before the renewal date.",
  outcome: "The policy renews.",
  state: [
    { subject: "policy", property: "premium", value: 120 },
    { subject: "leo", property: "age", value: 17 },
    { subject: "system", property: "connectivity", value: "online" },
    { subject: "grandma", property: "lives-in-household", value: true },
  ],
  inputs: [{ object: "premium", example: { amount: 120 } }],
  outputs: [{ object: "premium", example: { amount: 138 } }],
  steps: [
    step("open", "maria", "Opens the notice", { screen: "notice" }),
    step("compare", "system", "Shows old and new premium", { screen: "notice", node: "compare" }),
    step("accept", "maria", "Accepts the premium", { screen: "notice", node: "btn-accept" }, { via: "app" }),
  ],
  branches: [
    { id: "offline", title: "Device is offline", when: [{ subject: "system", property: "connectivity", value: "offline" }], steps: [step("saved", "system", "Shows the saved notice", { screen: "notice-offline" })], rejoin: "compare" },
    { id: "rise", title: "Premium rises by more than 15 %", from: "compare", when: [{ subject: "policy", property: "premium-change", op: "gt", value: 0.15 }], steps: [step("options", "system", "Offers a lower cover", { screen: "options" }), step("cosign", "jon", "Co-signs", { screen: "options", node: "btn-cosign" })], rejoin: "accept" },
    { id: "adult", title: "Leo turns 18", from: "compare", when: [{ subject: "leo", property: "age", op: "gte", value: 18 }, { subject: "leo", property: "status", op: "in", value: ["student", "apprentice"] }], steps: [step("leaves", "system", "Explains that Leo leaves", { screen: "ends" })], outcome: "The policy renews without Leo" },
  ],
};

export const rawVariant = {
  id: "single",
  title: "Single parent",
  when: { household: ["single-parent"] },
  constellations: ["single-parent"],
  trigger: { text: "sends the renewal notice", actor: "insurer", via: "letter" },
  state: [{ subject: "policy", property: "premium", value: 98 }, { subject: "maria", property: "discount", value: "single" }, { subject: "leo", property: "age", unset: true }],
  steps: [{ op: "remove", step_id: "leaves" }, { op: "remove_branch", branch_id: "offline" }],
};

const mappings = [
  { screen: "notice", exists: true, mappings: [{ step: "open", scope: "screen" }, { step: "compare", scope: "element", node: { id: "compare", tag: "div", text: "" } }, { step: "accept", scope: "element", node: { id: "btn-accept", tag: "button", text: "" } }] },
  { screen: "options", exists: true, mappings: [{ step: "options", scope: "screen", branch: "rise" }, { step: "cosign", scope: "element", node: { id: "btn-cosign", tag: "button", text: "" }, branch: "rise" }] },
];

const common = { personas, dimensions, data_objects: [], entities, relationship_types: relationshipTypes, screens: mappings };

export function makeWorldPool(extra = {}) {
  return { personas, dimensions, objects: [], personasById: indexById(personas), dimensionsById: indexById(dimensions), objectsById: new Map(), counts: { use_cases: 1, personas: 3, dimensions: 2, data_objects: 0 }, usage: Object.assign(new Map(), { complete: true }), constellations: new Map(), loaded: true, ...extra };
}

/** get_use_case without a variant. */
export const worldBundle = {
  ...common,
  use_case: baseCase,
  variants: [{ id: "single", title: "Single parent", when: rawVariant.when }],
  constellations: [...constellations],
  warnings: [
    { kind: "unknown_constellation", target: "use_case:review-premium/constellation:three-generations", message: "constellation \"three-generations\" does not exist" },
    { kind: "unknown_participant", target: "use_case:review-premium/state:grandma.lives-in-household", message: "state subject \"grandma\" is neither a persona, an entity nor \"system\"" },
    { kind: "outside_constellation", target: "use_case:review-premium/trigger", message: "\"insurer\" is not a member of any of the constellations" },
    { kind: "branch_rejoin_missing", target: "use_case:review-premium/branch:rise", message: "branch \"rise\" rejoins at a step that is not in the main flow" },
    { kind: "entity_as_actor", target: "use_case:review-premium/cosign", message: "\"jon\" is an entity" },
  ],
};

/** get_use_case with variant "single": changed / added markers, removed state and branches, an emptied branch. */
export const worldVariantBundle = {
  ...common,
  use_case: {
    ...baseCase,
    constellations: ["single-parent"],
    trigger: rawVariant.trigger,
    state: [
      { subject: "policy", property: "premium", value: 98, change: "changed" },
      { subject: "system", property: "connectivity", value: "online" },
      { subject: "grandma", property: "lives-in-household", value: true },
      { subject: "maria", property: "discount", value: "single", change: "added" },
    ],
    steps: baseCase.steps,
    branches: [
      { ...baseCase.branches[1], title: "Premium rises by more than 10 %", when: [{ subject: "policy", property: "premium-change", op: "gt", value: 0.1 }], change: "changed" },
      { ...baseCase.branches[2], steps: [] },
    ],
  },
  variant: { id: "single", title: "Single parent", when: rawVariant.when },
  removed_state: [{ subject: "leo", property: "age", value: 17, change: "removed" }],
  removed_branches: [{ ...baseCase.branches[0], change: "removed" }],
  constellations: [constellations[1]],
  warnings: [{ kind: "branch_empty", target: "use_case:review-premium#single/branch:adult", message: "branch \"adult\" has no steps" }],
};
