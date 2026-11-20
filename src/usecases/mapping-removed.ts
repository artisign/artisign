import type { Warning } from "../tools/types.js";
import type { UseCase, UseCaseStep } from "./schema.js";

/** Base flow and base branch steps by id (a step id is unique in a case, branches included). */
function baseSteps(useCase: UseCase): Map<string, UseCaseStep> {
  const out = new Map<string, UseCaseStep>();
  for (const step of [...useCase.steps, ...(useCase.branches ?? []).flatMap((branch) => branch.steps)]) out.set(step.id, step);
  return out;
}

function lost(target: string, step: UseCaseStep, was: NonNullable<UseCaseStep["target"]>): Warning {
  return { kind: "mapping_removed", target, message: `step "${step.id}" lost its target (was screen "${was.screen}"${was.node !== undefined ? `, node "${was.node}"` : ""})` };
}

/**
 * `mapping_removed` warnings of one rewritten case: a stored base or branch step with a `target` written back with the same id and no
 * `target`, and a variant `replace` op whose `step` has no `target` while the base step it replaces had one. Never blocking; a removed
 * step or a different target does not warn. A new case (`stored` undefined) has nothing to lose.
 */
export function mappingRemovedWarnings(stored: UseCase | undefined, written: UseCase): Warning[] {
  if (!stored) return [];
  const warnings: Warning[] = [];
  const before = baseSteps(stored);
  const after = baseSteps(written);
  for (const [id, step] of after) {
    const was = before.get(id)?.target;
    if (was && !step.target) warnings.push(lost(`use_case:${written.id}/${id}`, step, was));
  }
  for (const variant of written.variants ?? []) {
    for (const op of variant.steps ?? []) {
      if (op.op !== "replace" || op.step.target) continue;
      const was = after.get(op.step_id)?.target;
      if (was) warnings.push(lost(`use_case:${written.id}#${variant.id}/${op.step.id}`, op.step, was));
    }
  }
  return warnings;
}
