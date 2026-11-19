import type { Warning } from "../tools/types.js";
import { SYSTEM_ACTOR, normalizeTrigger, type DataObject, type Dimension, type Persona, type UseCase, type UseCaseStep } from "./schema.js";
import { isGeneratedId } from "../model/node-id.js";
import { actorMapPersonas } from "./query.js";
import { resolveUseCase } from "./resolve.js";
import type { ScreenLookup } from "./screens.js";

/** The pools a use case is checked against. Built once per call, shared by every entity checked in it. */
export type ValidationPools = {
  dimensions: Map<string, Dimension>;
  personas: Map<string, Persona>;
  objects: Map<string, DataObject>;
};

export function buildPools(dimensions: Dimension[], personas: Persona[], objects: DataObject[]): ValidationPools {
  return {
    dimensions: new Map(dimensions.map((d) => [d.id, d])),
    personas: new Map(personas.map((p) => [p.id, p])),
    objects: new Map(objects.map((o) => [o.id, o])),
  };
}

/** Trait problems of one persona: a dimension or a value the pool does not define. */
export function validatePersona(persona: Persona, pools: ValidationPools): Warning[] {
  const warnings: Warning[] = [];
  for (const [dimId, valueId] of Object.entries(persona.traits)) {
    const dimension = pools.dimensions.get(dimId);
    if (!dimension) {
      warnings.push({ kind: "unknown_dimension", target: `persona:${persona.id}`, message: `trait "${dimId}" is not a defined dimension` });
    } else if (!dimension.values.some((v) => v.id === valueId)) {
      warnings.push({ kind: "unknown_trait_value", target: `persona:${persona.id}`, message: `"${valueId}" is not a value of dimension "${dimId}"`, suggestion: dimension.values.map((v) => v.id).join(", ") });
    }
  }
  return warnings;
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

  const checkPersona = (id: string, target: string): void => {
    if (id !== SYSTEM_ACTOR && !pools.personas.has(id)) warn({ kind: "unknown_persona", target, message: `persona "${id}" does not exist` });
  };
  const checkExample = (objectId: string, example: Record<string, unknown> | undefined, target: string): void => {
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
    checkPersona(step.actor, target);
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
    if (actor !== undefined) checkPersona(actor, at());
  }
  checkIo(useCase.inputs, at());
  checkIo(useCase.outputs, at());
  for (const step of useCase.steps) await checkStep(step);

  for (const variant of useCase.variants ?? []) {
    for (const id of variant.personas ?? []) checkPersona(id, at(variant.id));
    for (const id of actorMapPersonas(variant)) checkPersona(id, at(variant.id));
    if (variant.trigger !== undefined) {
      const actor = normalizeTrigger(variant.trigger).actor;
      if (actor !== undefined) checkPersona(actor, at(variant.id));
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
    for (const op of variant.steps ?? []) if (op.op !== "remove") await checkStep(op.step, variant.id);
    for (const issue of resolveUseCase(useCase, variant).issues) {
      const kind = ({ missing_step: "variant_step_missing", duplicate_step_id: "duplicate_step_id", actor_invalid: "variant_actor_invalid", missing_state: "variant_state_missing" } as const)[issue.kind];
      warn({ kind, target: at(variant.id), message: issue.message });
    }
  }
  return warnings;
}
