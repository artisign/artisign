import type { Store } from "../store/index.js";
import type { Warning } from "../tools/types.js";
import { screensOf, stepsOfOp } from "./query.js";
import type { UseCase, UseCaseStep } from "./schema.js";
import { ScreenLookup } from "./screens.js";
import { mappingStaleWarning } from "./validate.js";

/** At most this many write-time `mapping_stale` warnings ride in one response; the rest are counted. */
export const MAPPING_STALE_CAP = 20;

type MappedStep = { step: UseCaseStep; variant?: string };

/** Every step of a case that can carry a mapping: base flow, base branches, and the steps variants introduce. */
function mappedSteps(useCase: UseCase): MappedStep[] {
  const out: MappedStep[] = useCase.steps.map((step) => ({ step }));
  for (const branch of useCase.branches ?? []) for (const step of branch.steps) out.push({ step });
  for (const variant of useCase.variants ?? []) {
    for (const op of variant.steps ?? []) {
      for (const step of stepsOfOp(op)) out.push({ step, variant: variant.id });
    }
  }
  return out;
}

/** `mapping_stale` warnings of the steps mapped to one of `screens`, keyed by target (a deleted screen changes the message of an already stale step, not its identity). */
async function staleOn(cases: UseCase[], screens: Set<string>, lookup: ScreenLookup): Promise<Map<string, Warning>> {
  const found = new Map<string, Warning>();
  for (const useCase of cases) {
    for (const { step, variant } of mappedSteps(useCase)) {
      if (!step.target || !screens.has(step.target.screen)) continue;
      const target = `use_case:${useCase.id}${variant ? `#${variant}` : ""}/${step.id}`;
      const warning = await mappingStaleWarning(step, target, lookup);
      if (!warning) continue;
      found.set(target, warning);
    }
  }
  return found;
}

export type MappingGuard = {
  /** Call after the write: the mappings it broke (stale now, not stale before), capped, with the number left out. */
  broken(): Promise<{ warnings: Warning[]; omitted: number }>;
};

/**
 * Write-time check for use-case mappings (CHR-1123). Call before a write that
 * can remove a screen or a node; `broken()` after it names the steps the write
 * left pointing at nothing. `undefined` when no use case maps one of `screens`
 * (a project without use cases pays one empty directory read).
 */
export async function guardMappings(store: Store, screens: string[]): Promise<MappingGuard | undefined> {
  try {
    return await guardMappingsUnsafe(store, screens);
  } catch {
    return undefined; // fail open: a warning is advice, it never blocks or fails a write
  }
}

async function guardMappingsUnsafe(store: Store, screens: string[]): Promise<MappingGuard | undefined> {
  const affected = new Set(screens);
  const { useCases } = await store.readUseCases();
  const cases = useCases.filter((useCase) => screensOf(useCase).some((screen) => affected.has(screen)));
  if (cases.length === 0) return undefined;
  const before = await staleOn(cases, affected, new ScreenLookup(store));
  return {
    async broken() {
      try {
        const after = await staleOn(cases, affected, new ScreenLookup(store));
        const fresh = [...after].filter(([key]) => !before.has(key)).map(([, warning]) => warning);
        return { warnings: fresh.slice(0, MAPPING_STALE_CAP), omitted: Math.max(0, fresh.length - MAPPING_STALE_CAP) };
      } catch {
        return { warnings: [], omitted: 0 };
      }
    },
  };
}
