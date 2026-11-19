import type { Warning } from "../tools/types.js";
import { SYSTEM_ACTOR, normalizeTrigger, type DataObject, type Dimension, type Persona, type UseCase, type UseCaseStep, type World } from "./schema.js";
import { isGeneratedId } from "../model/node-id.js";
import { actorMapPersonas, stepsOfOp } from "./query.js";
import { resolveUseCase, type EffectiveUseCase } from "./resolve.js";
import type { ScreenLookup } from "./screens.js";
import { caseWorldWarnings, participantKind, traitWarnings } from "./world.js";

/** The pools a use case is checked against. Built once per call, shared by every entity checked in it. */
export type ValidationPools = {
  dimensions: Map<string, Dimension>;
  personas: Map<string, Persona>;
  objects: Map<string, DataObject>;
  /** The world after the call (entities, relationship types, constellations). */
  world: World;
  /** Whether `usecases/data-objects.json` exists: only then are data-object references checked (ADR-011 choice 5 A). */
  dataModel: boolean;
};

/** `dataModel` is whether `usecases/data-objects.json` exists; the caller knows (`Store.dataModelExists`), there is no second definition here. */
export function buildPools(dimensions: Dimension[], personas: Persona[], objects: DataObject[], world: World, dataModel: boolean): ValidationPools {
  return {
    world,
    dataModel,
    dimensions: new Map(dimensions.map((d) => [d.id, d])),
    personas: new Map(personas.map((p) => [p.id, p])),
    objects: new Map(objects.map((o) => [o.id, o])),
  };
}

/** Trait problems of one persona: a dimension or a value the pool does not define. */
export function validatePersona(persona: Persona, pools: ValidationPools): Warning[] {
  return traitWarnings(persona.traits, `persona:${persona.id}`, pools);
}

/** Field problems of one data object: a `ref` to an object the pool does not have. */
export function validateDataObject(object: DataObject, pools: ValidationPools): Warning[] {
  const warnings: Warning[] = [];
  for (const field of object.fields) {
    if (field.type === "ref" && field.ref !== undefined && !pools.objects.has(field.ref)) {
      warnings.push({ kind: "unknown_data_object", target: `data_object:${object.id}`, message: `field "${field.name}" refs unknown data object "${field.ref}"` });
    }
  }
  return warnings;
}

/** Branch problems of an effective case: a `from` / `rejoin` that is not a main-flow step, a branch a variant left without steps. */
function branchWarnings(effective: EffectiveUseCase, target: string): Warning[] {
  const warnings: Warning[] = [];
  const mainSteps = new Set(effective.steps.map((step) => step.id));
  for (const branch of effective.branches ?? []) {
    const at = `${target}/branch:${branch.id}`;
    if (branch.from !== undefined && !mainSteps.has(branch.from)) {
      warnings.push({ kind: "branch_from_missing", target: at, message: `branch "${branch.id}" forks from "${branch.from}", which is not a main-flow step` });
    }
    if (branch.rejoin !== undefined && !mainSteps.has(branch.rejoin)) {
      warnings.push({ kind: "branch_rejoin_missing", target: at, message: `branch "${branch.id}" rejoins at "${branch.rejoin}", which is not a main-flow step` });
    }
    if (branch.steps.length === 0) warnings.push({ kind: "branch_empty", target: at, message: `branch "${branch.id}" has no steps` });
  }
  return warnings;
}

/**
 * Reference warnings for one use case, base and every variant. Mapping checks
 * (`mapping_stale`) go through `screens`, so a caller that only wants the
 * cheap reference checks passes none.
 */
export async function validateUseCase(useCase: UseCase, pools: ValidationPools, screens?: ScreenLookup): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const at = (variant?: string, step?: string): string => `use_case:${useCase.id}${variant ? `#${variant}` : ""}${step ? `/${step}` : ""}`;
  const warn = (warning: Warning): void => {
    warnings.push(warning);
  };

  /** `actor`: the id acts (step actor, trigger actor, `actors` map); an entity there is `entity_as_actor`, not `unknown_persona`. */
  const checkPersona = (id: string, target: string, actor = false): void => {
    if (id === SYSTEM_ACTOR || pools.personas.has(id)) return;
    if (actor && participantKind(id, pools) === "entity") warn({ kind: "entity_as_actor", target, message: `"${id}" is an entity; only a persona or "system" can act`, suggestion: `model the acting side as a persona, or make "${id}" the subject of a state entry` });
    else warn({ kind: "unknown_persona", target, message: `persona "${id}" does not exist` });
  };
  const checkExample = (objectId: string, example: Record<string, unknown> | undefined, target: string): void => {
    if (!pools.dataModel) return; // no data-objects.json: no data-object reference is checked
    const object = pools.objects.get(objectId);
    if (!object) {
      warn({ kind: "unknown_data_object", target, message: `data object "${objectId}" does not exist` });
      return;
    }
    const declared = new Set(object.fields.map((f) => f.name));
    for (const key of Object.keys(example ?? {})) {
      if (!declared.has(key)) warn({ kind: "unknown_data_field", target, message: `"${key}" is not a field of data object "${objectId}"` });
    }
  };
  const checkIo = (list: { object: string; example: Record<string, unknown> }[], target: string): void => {
    for (const item of list) checkExample(item.object, item.example, target);
  };
  const checkStep = async (step: UseCaseStep, variant?: string): Promise<void> => {
    const target = at(variant, step.id);
    checkPersona(step.actor, target, true);
    for (const data of step.data ?? []) {
      checkExample(data.object, data.before, target);
      checkExample(data.object, data.after, target);
    }
    if (step.target?.node !== undefined && isGeneratedId(step.target.node)) {
      warn({
        kind: "mapping_unstable",
        target,
        message: `node "${step.target.node}" has a generated id — it is a position and can point at another element after the screen is rewritten`,
        suggestion: `give the element an authored id on screen "${step.target.screen}" first (id attribute in write_html or patch_html replace), then map the step to it`,
      });
    }
    if (screens && step.target) {
      if (!(await screens.hasScreen(step.target.screen))) {
        warn({ kind: "mapping_stale", target, message: `screen "${step.target.screen}" does not exist` });
      } else if (step.target.node !== undefined && !(await screens.node(step.target.screen, step.target.node))) {
        warn({ kind: "mapping_stale", target, message: `node "${step.target.node}" does not exist on screen "${step.target.screen}"` });
      }
    }
  };

  for (const id of useCase.personas) checkPersona(id, at());
  if (useCase.trigger !== undefined) {
    const actor = normalizeTrigger(useCase.trigger).actor;
    if (actor !== undefined) checkPersona(actor, at(), true);
  }
  checkIo(useCase.inputs, at());
  checkIo(useCase.outputs, at());
  for (const step of useCase.steps) await checkStep(step);
  for (const branch of useCase.branches ?? []) for (const step of branch.steps) await checkStep(step);
  // What the base case has once, a variant does not repeat: same `kind` and the target without its `#<variant>`, never the message.
  const baseResolved = resolveUseCase(useCase).use_case;
  const baseWorldWarnings = [...branchWarnings(baseResolved, at()), ...caseWorldWarnings(baseResolved, pools, at())];
  warnings.push(...baseWorldWarnings);

  for (const variant of useCase.variants ?? []) {
    for (const id of variant.personas ?? []) checkPersona(id, at(variant.id));
    for (const id of actorMapPersonas(variant)) checkPersona(id, at(variant.id), true);
    if (variant.trigger !== undefined) {
      const actor = normalizeTrigger(variant.trigger).actor;
      if (actor !== undefined) checkPersona(actor, at(variant.id), true);
    }
    checkIo(variant.inputs ?? [], at(variant.id));
    checkIo(variant.outputs ?? [], at(variant.id));
    for (const [dimId, valueIds] of Object.entries(variant.when)) {
      const dimension = pools.dimensions.get(dimId);
      if (!dimension) {
        warn({ kind: "unknown_dimension", target: at(variant.id), message: `"when" names unknown dimension "${dimId}"` });
        continue;
      }
      for (const valueId of valueIds) {
        if (!dimension.values.some((v) => v.id === valueId)) {
          warn({ kind: "unknown_trait_value", target: at(variant.id), message: `"${valueId}" is not a value of dimension "${dimId}"`, suggestion: dimension.values.map((v) => v.id).join(", ") });
        }
      }
    }
    for (const op of variant.steps ?? []) for (const step of stepsOfOp(op)) await checkStep(step, variant.id);
    const resolved = resolveUseCase(useCase, variant);
    for (const issue of resolved.issues) {
      const kind = (
        {
          missing_step: "variant_step_missing",
          missing_branch: "variant_step_missing",
          duplicate_step_id: "duplicate_step_id",
          duplicate_branch_id: "duplicate_branch_id",
          actor_invalid: "variant_actor_invalid",
          missing_state: "variant_state_missing",
        } as const
      )[issue.kind];
      warn({ kind, target: at(variant.id), message: issue.message });
    }
    // A problem the base case already has is reported once, on the base; the variant adds only what it causes.
    // A variant's resolved state is judged on its own, not as a union over all variants.
    const sameProblem = (w: Warning): string => `${w.kind}|${(w.target ?? "").replace(/^(use_case:[^#/]*)#[^/]*/, "$1")}`;
    const known = new Set(baseWorldWarnings.map(sameProblem));
    const own = [...branchWarnings(resolved.use_case, at(variant.id)), ...caseWorldWarnings(resolved.use_case, pools, at(variant.id), variant.when)];
    for (const w of own) if (!known.has(sameProblem(w))) warn(w);
  }
  return warnings;
}
