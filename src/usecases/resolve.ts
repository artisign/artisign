import { SYSTEM_ACTOR, normalizeTrigger, type StateEntry, type TriggerObject, type UseCase, type UseCaseInput, UseCaseOutput, UseCaseStep, UseCaseVariant } from "./schema.js";

export type StepChange = "changed" | "added";

export type EffectiveStep = UseCaseStep & { change?: StepChange };

/** A base step a variant deletes; `after` is the step it followed in the effective flow (`null` = it opened the flow). */
export type RemovedStep = UseCaseStep & { change: "removed"; after: string | null };

/** A starting-state entry of the effective case; `change` is set only when a variant replaced or added it. */
export type EffectiveStateEntry = StateEntry & { change?: StateChange };
export type StateChange = "changed" | "added";

/** A base state entry a variant unsets. */
export type RemovedStateEntry = StateEntry & { change: "removed" };

export type EffectiveUseCase = Omit<UseCase, "variants" | "steps" | "inputs" | "outputs" | "trigger" | "state"> & {
  /** Always the object form, however it is stored. */
  trigger?: TriggerObject;
  state?: EffectiveStateEntry[];
  inputs: UseCaseInput[];
  outputs: UseCaseOutput[];
  steps: EffectiveStep[];
};

export type ResolveIssue = {
  /**
   * `missing_step`: the op points at a step the flow lacks. `duplicate_step_id`: the op would put a second step with an existing id into the flow.
   * `actor_invalid`: the `actors` map would turn the inherited trigger actor into `system` (not applied; `op` is -1 and `step_id` empty).
   * `missing_state`: the variant unsets a state entry the base lacks (`op` is -1, `step_id` is `subject.property`).
   */
  kind: "missing_step" | "duplicate_step_id" | "actor_invalid" | "missing_state";
  variant: string;
  op: number;
  step_id: string;
  message: string;
};

export type ResolvedUseCase = {
  use_case: EffectiveUseCase;
  removed_steps: RemovedStep[];
  /** Base starting-state entries the variant unsets. */
  removed_state: RemovedStateEntry[];
  /** Ops that point at a step the flow does not have at that point — skipped, never fatal. */
  issues: ResolveIssue[];
};

/** The base use case without its variants; a variant, when given, is applied on top. Pure: nothing is read or written. */
export function resolveUseCase(base: UseCase, variant?: UseCaseVariant): ResolvedUseCase {
  const effective: EffectiveUseCase & { variants?: unknown } = {
    ...base,
    trigger: base.trigger !== undefined ? normalizeTrigger(base.trigger) : undefined,
    steps: base.steps.map((step) => ({ ...step })),
  };
  delete effective.variants;
  if (effective.trigger === undefined) delete effective.trigger;
  const removed: RemovedStep[] = [];
  const removedState: RemovedStateEntry[] = [];
  const issues: ResolveIssue[] = [];
  if (!variant) return { use_case: effective, removed_steps: removed, removed_state: removedState, issues };

  // 1. Overrides, each replaced whole.
  if (variant.personas !== undefined) effective.personas = variant.personas;
  if (variant.constellations !== undefined) effective.constellations = variant.constellations;
  if (variant.trigger !== undefined) effective.trigger = normalizeTrigger(variant.trigger);
  if (variant.goal !== undefined) effective.goal = variant.goal;
  if (variant.outcome !== undefined) effective.outcome = variant.outcome;
  if (variant.inputs !== undefined) effective.inputs = variant.inputs;
  if (variant.outputs !== undefined) effective.outputs = variant.outputs;

  // 2. The state merges per (subject, property): an entry replaces or adds, `unset` removes.
  if (variant.state !== undefined) {
    const state: EffectiveStateEntry[] = (base.state ?? []).map((entry) => ({ ...entry }));
    // The schema allows one entry per (subject, property) in the case and in the variant, so each key is visited once.
    for (const entry of variant.state) {
      const index = state.findIndex((e) => e.subject === entry.subject && e.property === entry.property);
      if (entry.unset === true) {
        if (index === -1) {
          issues.push({ kind: "missing_state", variant: variant.id, op: -1, step_id: `${entry.subject}.${entry.property}`, message: `variant "${variant.id}" unsets state "${entry.subject}.${entry.property}", which the base case does not have` });
          continue;
        }
        const [gone] = state.splice(index, 1);
        removedState.push({ subject: gone!.subject, property: gone!.property, value: gone!.value, change: "removed" });
        continue;
      }
      const next: EffectiveStateEntry = { subject: entry.subject, property: entry.property, value: entry.value, change: index === -1 ? "added" : "changed" };
      if (index === -1) state.push(next);
      else state[index] = next;
    }
    if (state.length > 0) effective.state = state;
    else delete effective.state;
  }

  // 3. The actors map runs once, before the ops, on the inherited steps only; it is never chained.
  const actors = variant.actors ?? {};
  const mapped = (actor: string): string => (Object.hasOwn(actors, actor) ? actors[actor]! : actor);
  // A step only the map changed keeps its base form for the removed-steps report: the map is not an op.
  const baseOf = new Map<EffectiveStep, UseCaseStep>();
  effective.steps = effective.steps.map((step) => {
    if (mapped(step.actor) === step.actor) return step;
    const remapped: EffectiveStep = { ...step, actor: mapped(step.actor), change: "changed" };
    baseOf.set(remapped, step);
    return remapped;
  });
  // It also maps an inherited `trigger.actor`; a trigger the variant wrote itself is taken as written. A trigger actor is never the system.
  if (variant.trigger === undefined && effective.trigger?.actor !== undefined && mapped(effective.trigger.actor) !== effective.trigger.actor) {
    if (mapped(effective.trigger.actor) === SYSTEM_ACTOR) {
      issues.push({ kind: "actor_invalid", variant: variant.id, op: -1, step_id: "", message: `variant "${variant.id}" maps trigger actor "${effective.trigger.actor}" to "${SYSTEM_ACTOR}": a trigger actor is a persona, so the mapping is not applied to the trigger` });
    } else {
      effective.trigger = { ...effective.trigger, actor: mapped(effective.trigger.actor) };
    }
  }
  if (variant.personas === undefined && Object.entries(actors).some(([key, value]) => key !== value)) {
    // The system is not a persona, so a value "system" drops the entry.
    effective.personas = [...new Set(base.personas.map(mapped).filter((id) => id !== SYSTEM_ACTOR))];
  }

  // 4. The ops, in order.
  const steps = effective.steps;
  (variant.steps ?? []).forEach((op, opIndex) => {
    const missing = (stepId: string): void => {
      issues.push({ kind: "missing_step", variant: variant.id, op: opIndex, step_id: stepId, message: `variant "${variant.id}" op ${opIndex} (${op.op}) points at step "${stepId}", which the flow does not have at that point` });
    };
    // An op never creates a second step with an id the flow already has (a replace may keep its own id).
    const collides = (ownId?: string): boolean => {
      if (op.op === "remove" || op.step.id === ownId || !steps.some((step) => step.id === op.step.id)) return false;
      issues.push({ kind: "duplicate_step_id", variant: variant.id, op: opIndex, step_id: op.step.id, message: `variant "${variant.id}" op ${opIndex} (${op.op}) would add a second step "${op.step.id}" to the flow` });
      return true;
    };
    if (op.op === "append") {
      if (!collides()) steps.push({ ...op.step, change: "added" });
      return;
    }
    const index = steps.findIndex((step) => step.id === op.step_id);
    if (index === -1) {
      missing(op.step_id);
      return;
    }
    const current = steps[index]!;
    if (op.op !== "remove" && collides(op.op === "replace" ? op.step_id : undefined)) return;
    if (op.op === "replace") {
      // A step this variant added itself stays "added" however often it is rewritten.
      steps[index] = { ...op.step, change: current.change === "added" ? "added" : "changed" };
    } else if (op.op === "insert_after") {
      steps.splice(index + 1, 0, { ...op.step, change: "added" });
    } else {
      steps.splice(index, 1);
      // Removing a step the variant itself added leaves no trace in the base flow.
      if (current.change !== "added") {
        const plain: EffectiveStep = { ...(baseOf.get(current) ?? current) };
        delete plain.change;
        removed.push({ ...plain, change: "removed", after: index > 0 ? steps[index - 1]!.id : null });
      }
    }
  });
  return { use_case: effective, removed_steps: removed, removed_state: removedState, issues };
}
