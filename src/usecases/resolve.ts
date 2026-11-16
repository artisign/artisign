import type { UseCase, UseCaseInput, UseCaseOutput, UseCaseStep, UseCaseVariant } from "./schema.js";

export type StepChange = "changed" | "added";

export type EffectiveStep = UseCaseStep & { change?: StepChange };

/** A base step a variant deletes; `after` is the step it followed in the effective flow (`null` = it opened the flow). */
export type RemovedStep = UseCaseStep & { change: "removed"; after: string | null };

export type EffectiveUseCase = Omit<UseCase, "variants" | "steps" | "inputs" | "outputs"> & {
  inputs: UseCaseInput[];
  outputs: UseCaseOutput[];
  steps: EffectiveStep[];
};

export type ResolveIssue = {
  /** `missing_step`: the op points at a step the flow lacks. `duplicate_step_id`: the op would put a second step with an existing id into the flow. */
  kind: "missing_step" | "duplicate_step_id";
  variant: string;
  op: number;
  step_id: string;
  message: string;
};

export type ResolvedUseCase = {
  use_case: EffectiveUseCase;
  removed_steps: RemovedStep[];
  /** Ops that point at a step the flow does not have at that point — skipped, never fatal. */
  issues: ResolveIssue[];
};

/** The base use case without its variants; a variant, when given, is applied on top. Pure: nothing is read or written. */
export function resolveUseCase(base: UseCase, variant?: UseCaseVariant): ResolvedUseCase {
  const effective: EffectiveUseCase & { variants?: unknown } = { ...base, steps: base.steps.map((step) => ({ ...step })) };
  delete effective.variants;
  const removed: RemovedStep[] = [];
  const issues: ResolveIssue[] = [];
  if (!variant) return { use_case: effective, removed_steps: removed, issues };

  if (variant.personas !== undefined) effective.personas = variant.personas;
  if (variant.trigger !== undefined) effective.trigger = variant.trigger;
  if (variant.goal !== undefined) effective.goal = variant.goal;
  if (variant.outcome !== undefined) effective.outcome = variant.outcome;
  if (variant.inputs !== undefined) effective.inputs = variant.inputs;
  if (variant.outputs !== undefined) effective.outputs = variant.outputs;

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
        const plain: EffectiveStep = { ...current };
        delete plain.change;
        removed.push({ ...plain, change: "removed", after: index > 0 ? steps[index - 1]!.id : null });
      }
    }
  });
  return { use_case: effective, removed_steps: removed, issues };
}
