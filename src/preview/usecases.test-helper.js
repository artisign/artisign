// Shared fixtures for the Use Cases tests: a small persona pool, a use case with two variants, and the bundle shapes
// get_use_case returns for the base flow and for a selected variant (see the use-case spec).

import { indexById } from "./usecases-data.js";

export const dimensions = [
  { id: "size", label: "Project size", values: [{ id: "small", label: "Small project" }, { id: "large", label: "Large project" }, { id: "medium", label: "Medium project" }] },
  { id: "actor", label: "Actor type", values: [{ id: "human", label: "Human" }, { id: "agent", label: "Agent" }] },
];

export const personas = [
  { id: "dana", name: "Dana", role: "Designer", avatar: { emoji: "👨", color: "#4F7CAC" }, traits: { size: "small", actor: "human" }, goals: ["All steps at a glance"] },
  { id: "dex", name: "Dex", role: "Designer", avatar: { emoji: "👩", color: "#B05C8A" }, traits: { size: "large", actor: "agent" } },
  { id: "gen-medium", name: "Medium project", avatar: { color: "#111111" }, traits: { size: "medium" }, generated: true },
];

export const objects = [
  { id: "mapping", name: "Mapping", fields: [{ name: "status", type: "enum", values: ["draft", "ready"] }, { name: "owner", type: "ref", ref: "owner" }] },
  { id: "owner", name: "Owner", fields: [{ name: "name", type: "string" }] },
];

export function makePool(extra = {}) {
  return {
    personas,
    dimensions,
    objects,
    personasById: indexById(personas),
    dimensionsById: indexById(dimensions),
    objectsById: indexById(objects),
    counts: { use_cases: 1, personas: personas.length, dimensions: dimensions.length, data_objects: objects.length },
    usage: Object.assign(new Map([["dana", 4]]), { complete: true }),
    loaded: true,
    ...extra,
  };
}

const baseSteps = [
  { id: "tap", actor: "dana", action: "Taps the step", target: { screen: "editor", node: "btn-map" } },
  { id: "pick", actor: "dana", action: "Picks Pablo", target: { screen: "picker" }, data: [{ object: "mapping", before: { status: "draft" }, after: { status: "ready", owner: "Pablo" } }] },
  { id: "notify", actor: "system", action: "Dex gets a push", target: { screen: "gone-screen" } },
];

export const rawUseCase = {
  id: "map-step",
  title: "Map a step to an element",
  group: "mapping/elements",
  tags: ["actor"],
  status: "ready",
  personas: ["dana"],
  trigger: "Step has no target",
  goal: "Map it",
  outcome: "Mapped",
  inputs: [{ object: "mapping", source: "mapping", example: { status: "draft" } }],
  outputs: [{ object: "mapping", target: "mapping", example: { status: "ready", owner: "Pablo" } }],
  steps: baseSteps,
  variants: [
    {
      id: "agent",
      title: "No human",
      description: "Agent covers the day.",
      when: { actor: ["agent"] },
      personas: ["dex"],
      steps: [
        { op: "replace", step_id: "pick", step: { id: "pick", actor: "dex", action: "Picks the agent", target: { screen: "picker", node: "row-agent" } } },
        { op: "remove", step_id: "notify" },
        { op: "append", step: { id: "time", actor: "dex", action: "Sets the time", target: { screen: "picker" } } },
      ],
      outputs: [{ object: "mapping", example: { status: "ready", owner: "Agent" } }],
    },
    { id: "large", title: "Large project", when: { size: ["large"] }, steps: [] },
  ],
};

export const screensBundle = [
  { screen: "editor", exists: true, mappings: [{ step: "tap", scope: "element", node: { id: "btn-map", tag: "div", text: "14" } }] },
  { screen: "picker", exists: true, mappings: [{ step: "pick", scope: "screen" }] },
  { screen: "gone-screen", exists: false, mappings: [{ step: "notify", scope: "screen", stale: true }] },
];

/** get_use_case without a variant. */
export const baseBundle = {
  use_case: { ...rawUseCase, variants: undefined },
  variants: rawUseCase.variants.map((v) => ({ id: v.id, title: v.title, ...(v.description ? { description: v.description } : {}), when: v.when })),
  personas: [personas[0], personas[1]],
  dimensions,
  data_objects: objects,
  screens: screensBundle,
  warnings: [],
};

/** get_use_case with variant "agent" selected: changed / added steps flagged, the removed one listed apart. */
export const variantBundle = {
  use_case: {
    ...rawUseCase,
    variants: undefined,
    personas: ["dex"],
    outputs: [{ object: "mapping", example: { status: "ready", owner: "Agent" } }],
    steps: [
      { id: "tap", actor: "dana", action: "Taps the step", target: { screen: "editor", node: "btn-map" } },
      { id: "pick", actor: "dex", action: "Picks the agent", target: { screen: "picker", node: "row-agent" }, change: "changed" },
      { id: "time", actor: "dex", action: "Sets the time", target: { screen: "picker" }, change: "added" },
    ],
  },
  variant: { id: "agent", title: "No human", description: "Agent covers the day.", when: { actor: ["agent"] } },
  removed_steps: [{ ...baseSteps[2], change: "removed", after: "pick" }],
  personas: [personas[1]],
  dimensions,
  data_objects: objects,
  screens: [
    { screen: "editor", exists: true, mappings: [{ step: "tap", scope: "element", node: { id: "btn-map", tag: "div", text: "14" } }] },
    { screen: "picker", exists: true, mappings: [{ step: "pick", scope: "element", node: { id: "row-agent", tag: "div", text: "Agent" } }, { step: "time", scope: "screen" }] },
  ],
  warnings: [],
};
