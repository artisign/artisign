import { SYSTEM_ACTOR, normalizeTrigger, type StateEntry, type TriggerObject, type UseCase, type UseCaseBranch, type UseCaseInput, type UseCaseOutput, type UseCaseStep, type UseCaseVariant } from "./schema.js";

export type StepChange = "changed" | "added";

export type EffectiveStep = UseCaseStep & { change?: StepChange };

/**
 * A base step a variant deletes; `after` is the step it followed in the effective flow of its own list (`null` = it opened the
 * main flow or its branch), `branch` the branch it was in (absent = the main flow).
 */
export type RemovedStep = UseCaseStep & { change: "removed"; after: string | null; branch?: string };

/** A branch of the effective case: `change` is set only when a variant replaced or added the branch itself (its steps carry their own). */
export type EffectiveBranch = Omit<UseCaseBranch, "steps"> & { steps: EffectiveStep[]; change?: StepChange };

/** A base branch a variant removes, steps included. */
export type RemovedBranch = UseCaseBranch & { change: "removed" };

/** A starting-state entry of the effective case; `change` is set only when a variant replaced or added it. */
export type EffectiveStateEntry = StateEntry & { change?: StateChange };
export type StateChange = "changed" | "added";

/** A base state entry a variant unsets. */
export type RemovedStateEntry = StateEntry & { change: "removed" };

export type EffectiveUseCase = Omit<UseCase, "variants" | "steps" | "branches" | "inputs" | "outputs" | "trigger" | "state"> & {
  /** Always the object form, however it is stored. */
  trigger?: TriggerObject;
  state?: EffectiveStateEntry[];
  inputs: UseCaseInput[];
  outputs: UseCaseOutput[];
  steps: EffectiveStep[];
  branches?: EffectiveBranch[];
};

/**
 * A problem a variant causes while it is applied; the op is skipped, never fatal. One shape per subject, told apart by `kind`:
 * a step (`missing_step`: the op names a step the case lacks; `duplicate_step_id`: it would add a second step with an existing
 * id), a state entry (`missing_state`: the variant unsets an entry the base lacks), a branch (`missing_branch`: the op names a
 * branch the case lacks; `duplicate_branch_id`: it would add a second branch with an existing id) or the trigger actor
 * (`actor_invalid`: the `actors` map would turn the inherited trigger actor into `system`; not applied).
 */
export type ResolveIssue = { variant: string; message: string } & (
  | { kind: "missing_step" | "duplicate_step_id"; op: number; step_id: string }
  | { kind: "missing_state"; subject: string; property: string }
  | { kind: "missing_branch" | "duplicate_branch_id"; op: number; branch_id: string }
  | { kind: "actor_invalid"; actor: string }
);

export type ResolvedUseCase = {
  use_case: EffectiveUseCase;
  removed_steps: RemovedStep[];
  /** Base branches the variant removes. */
  removed_branches: RemovedBranch[];
  /** Base starting-state entries the variant unsets. */
  removed_state: RemovedStateEntry[];
  /** Ops that point at a step the flow does not have at that point — skipped, never fatal. */
  issues: ResolveIssue[];
};

function plainStep(step: EffectiveStep): UseCaseStep {
  const plain: EffectiveStep = { ...step };
  delete plain.change;
  return plain;
}

/** The base use case without its variants; a variant, when given, is applied on top. Pure: nothing is read or written. */
export function resolveUseCase(base: UseCase, variant?: UseCaseVariant): ResolvedUseCase {
  const effective: EffectiveUseCase & { variants?: unknown } = {
    ...base,
    trigger: base.trigger !== undefined ? normalizeTrigger(base.trigger) : undefined,
    steps: base.steps.map((step) => ({ ...step })),
  };
  delete effective.variants;
  if (effective.trigger === undefined) delete effective.trigger;
  if (base.branches !== undefined) effective.branches = base.branches.map((branch) => ({ ...branch, steps: branch.steps.map((step) => ({ ...step })) }));
  const removed: RemovedStep[] = [];
  const removedBranches: RemovedBranch[] = [];
  const removedState: RemovedStateEntry[] = [];
  const issues: ResolveIssue[] = [];
  const result = (): ResolvedUseCase => ({ use_case: effective, removed_steps: removed, removed_branches: removedBranches, removed_state: removedState, issues });
  if (!variant) return result();

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
          issues.push({ kind: "missing_state", variant: variant.id, subject: entry.subject, property: entry.property, message: `variant "${variant.id}" unsets state "${entry.subject}.${entry.property}", which the base case does not have` });
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

  // 3. The actors map runs once, before the ops, on the inherited steps (main flow and branches); it is never chained.
  const actors = variant.actors ?? {};
  const mapped = (actor: string): string => (Object.hasOwn(actors, actor) ? actors[actor]! : actor);
  // A step only the map changed keeps its base form for the removed-steps report: the map is not an op.
  const baseOf = new Map<EffectiveStep, UseCaseStep>();
  const baseBranchOf = new Map<EffectiveBranch, UseCaseBranch>();
  const remap = (steps: EffectiveStep[]): EffectiveStep[] =>
    steps.map((step) => {
      if (mapped(step.actor) === step.actor) return step;
      const remapped: EffectiveStep = { ...step, actor: mapped(step.actor), change: "changed" };
      baseOf.set(remapped, step);
      return remapped;
    });
  effective.steps = remap(effective.steps);
  if (effective.branches !== undefined) {
    effective.branches = effective.branches.map((branch, index) => {
      const steps = remap(branch.steps);
      if (steps.every((step, i) => step === branch.steps[i])) return branch;
      const remapped: EffectiveBranch = { ...branch, steps };
      baseBranchOf.set(remapped, base.branches![index]!);
      return remapped;
    });
  }
  // It also maps an inherited `trigger.actor`; a trigger the variant wrote itself is taken as written. A trigger actor is never the system.
  if (variant.trigger === undefined && effective.trigger?.actor !== undefined && mapped(effective.trigger.actor) !== effective.trigger.actor) {
    if (mapped(effective.trigger.actor) === SYSTEM_ACTOR) {
      issues.push({ kind: "actor_invalid", variant: variant.id, actor: effective.trigger.actor, message: `variant "${variant.id}" maps trigger actor "${effective.trigger.actor}" to "${SYSTEM_ACTOR}": a trigger actor is a persona, so the mapping is not applied to the trigger` });
    } else {
      effective.trigger = { ...effective.trigger, actor: mapped(effective.trigger.actor) };
    }
  }
  if (variant.personas === undefined && Object.entries(actors).some(([key, value]) => key !== value)) {
    // The system is not a persona, so a value "system" drops the entry.
    effective.personas = [...new Set(base.personas.map(mapped).filter((id) => id !== SYSTEM_ACTOR))];
  }

  // 4. The ops, in order. Step ids are one namespace: the main flow and every branch.
  const steps = effective.steps;
  const branches = (): EffectiveBranch[] => (effective.branches ??= []);
  const findBranch = (id: string): EffectiveBranch | undefined => effective.branches?.find((branch) => branch.id === id);
  const locate = (stepId: string): { list: EffectiveStep[]; index: number; branch?: EffectiveBranch } | undefined => {
    const index = steps.findIndex((step) => step.id === stepId);
    if (index !== -1) return { list: steps, index };
    for (const branch of effective.branches ?? []) {
      const at = branch.steps.findIndex((step) => step.id === stepId);
      if (at !== -1) return { list: branch.steps, index: at, branch };
    }
    return undefined;
  };
  /** Whether the flow already has a step with this id, leaving out the steps of the branch being replaced. */
  const idTaken = (id: string, ignore?: EffectiveBranch): boolean =>
    steps.some((step) => step.id === id) || (effective.branches ?? []).some((branch) => branch !== ignore && branch.steps.some((step) => step.id === id));
  /** A branch an op writes: a step that keeps the id of a step of the branch it replaces is `changed`, every other one `added`. */
  const writtenBranch = (branch: UseCaseBranch, change: StepChange, replaced?: EffectiveBranch): EffectiveBranch => ({
    ...branch,
    steps: branch.steps.map((step) => ({ ...step, change: replaced?.steps.some((old) => old.id === step.id) ? ("changed" as const) : ("added" as const) })),
    change,
  });

  (variant.steps ?? []).forEach((op, opIndex) => {
    const label = `variant "${variant.id}" op ${opIndex} (${op.op})`;
    const missingStep = (stepId: string): void => {
      issues.push({ kind: "missing_step", variant: variant.id, op: opIndex, step_id: stepId, message: `${label} points at step "${stepId}", which the flow does not have at that point` });
    };
    const missingBranch = (branchId: string): void => {
      issues.push({ kind: "missing_branch", variant: variant.id, op: opIndex, branch_id: branchId, message: `${label} points at branch "${branchId}", which the case does not have at that point` });
    };
    const duplicateStep = (stepId: string): void => {
      issues.push({ kind: "duplicate_step_id", variant: variant.id, op: opIndex, step_id: stepId, message: `${label} would add a second step "${stepId}" to the flow` });
    };
    const duplicateBranch = (branchId: string): void => {
      issues.push({ kind: "duplicate_branch_id", variant: variant.id, op: opIndex, branch_id: branchId, message: `${label} would add a second branch "${branchId}" to the case` });
    };
    /** A step id the op brings in must be new to the flow (a replace may keep its own id; `ignore` is the branch a replace_branch rewrites). */
    const stepCollides = (step: UseCaseStep, ownId?: string, ignore?: EffectiveBranch): boolean => {
      if (step.id === ownId || !idTaken(step.id, ignore)) return false;
      duplicateStep(step.id);
      return true;
    };

    if (op.op === "add_branch" || op.op === "replace_branch") {
      const current = op.op === "replace_branch" ? findBranch(op.branch_id) : undefined;
      if (op.op === "replace_branch" && !current) return missingBranch(op.branch_id);
      if (findBranch(op.branch.id) !== undefined && findBranch(op.branch.id) !== current) return duplicateBranch(op.branch.id);
      if (op.branch.steps.some((step) => stepCollides(step, undefined, current))) return;
      if (current) {
        // A branch this variant added itself stays "added" however often it is rewritten.
        branches()[branches().indexOf(current)] = writtenBranch(op.branch, current.change === "added" ? "added" : "changed", current);
      } else {
        branches().push(writtenBranch(op.branch, "added"));
      }
      return;
    }
    if (op.op === "remove_branch") {
      const current = findBranch(op.branch_id);
      if (!current) return missingBranch(op.branch_id);
      branches().splice(branches().indexOf(current), 1);
      // Removing a branch the variant itself added leaves no trace in the base case.
      if (current.change !== "added") {
        const original = baseBranchOf.get(current) ?? current;
        removedBranches.push({ ...original, steps: original.steps.map((step) => plainStep(step)), change: "removed" } as RemovedBranch);
      }
      if (effective.branches!.length === 0) delete effective.branches;
      return;
    }
    if (op.op === "append") {
      const target = op.branch === undefined ? steps : findBranch(op.branch)?.steps;
      if (!target) return missingBranch(op.branch!);
      if (!stepCollides(op.step)) target.push({ ...op.step, change: "added" });
      return;
    }
    const found = locate(op.step_id);
    if (!found) return missingStep(op.step_id);
    const { list, index, branch } = found;
    const current = list[index]!;
    if (op.op !== "remove" && stepCollides(op.step, op.op === "replace" ? op.step_id : undefined)) return;
    if (op.op === "replace") {
      // A step this variant added itself stays "added" however often it is rewritten.
      list[index] = { ...op.step, change: current.change === "added" ? "added" : "changed" };
    } else if (op.op === "insert_after") {
      list.splice(index + 1, 0, { ...op.step, change: "added" });
    } else {
      list.splice(index, 1);
      // Removing a step the variant itself added leaves no trace in the base flow.
      if (current.change !== "added") {
        const plain = plainStep(baseOf.get(current) ?? current);
        removed.push({ ...plain, change: "removed", after: index > 0 ? list[index - 1]!.id : null, ...(branch ? { branch: branch.id } : {}) });
      }
    }
  });
  return result();
}
