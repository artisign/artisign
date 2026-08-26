import type { Store, DesignDecision, MockupMeta } from "../store/index.js";
import { ToolError, commitFields } from "./types.js";
import { readMockupMetaOrDefault } from "./mockups.js";

export type SetMetaTarget =
  | { kind: "screen"; screen: string }
  | { kind: "mockup"; mockup: string }
  | { kind: "design_system" }
  | { kind: "component"; name: string }
  | { kind: "pattern"; name: string };

export type SetMetaDecisionInput = {
  id: string;
  date?: string;
  title: string;
  body: string;
  status?: "active" | "superseded";
};

export type SetMetaInput = {
  target: SetMetaTarget;
  notes?: string;
  tags?: string[];
  title?: string;
  description?: string;
  idea?: string;
  decisions?: SetMetaDecisionInput[];
  usage?: string;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Short, human-readable target description for the commit message, mirroring set_flow's `${input.node}` pattern. */
function describeTarget(target: SetMetaTarget): string {
  switch (target.kind) {
    case "screen":
      return `screen:${target.screen}`;
    case "mockup":
      return `mockup:${target.mockup}`;
    case "design_system":
      return "design_system";
    case "component":
      return `component:${target.name}`;
    case "pattern":
      return `pattern:${target.name}`;
  }
}

/**
 * M5 set_meta — the single write tool for the design-system-meta feature:
 * screen notes/tags, design-system idea/decisions, and component/pattern
 * usage guidance. One tool covers all four target kinds rather than four
 * separate tools, since they share identical merge/validate/commit shape.
 */
export async function setMeta(store: Store, input: SetMetaInput): Promise<Record<string, unknown>> {
  const target = input.target;

  if (target.kind === "screen") {
    if (input.idea !== undefined || input.decisions !== undefined || input.usage !== undefined || input.title !== undefined || input.description !== undefined) {
      throw new ToolError("validation_failed", "idea/decisions/usage/title/description only apply to design_system/component/pattern/mockup targets, not screen");
    }
    if (input.notes === undefined && input.tags === undefined) {
      throw new ToolError("validation_failed", "at least one of notes/tags is required for target kind \"screen\"");
    }
    if (!(await store.listScreens()).includes(target.screen)) {
      throw new ToolError("not_found", `screen "${target.screen}" was not found`);
    }

    const current = await store.readScreenMeta(target.screen);
    const meta = { notes: input.notes ?? current.notes, tags: input.tags ?? current.tags };
    await store.writeScreenMeta(target.screen, meta);
    const commitResult = await store.commit(`set_meta: ${describeTarget(target)}`);
    return { target, meta, ...commitFields(commitResult) };
  }

  if (target.kind === "mockup") {
    if (input.notes !== undefined || input.idea !== undefined || input.decisions !== undefined || input.usage !== undefined) {
      throw new ToolError("validation_failed", "notes/idea/decisions/usage only apply to screen/design_system/component/pattern targets, not mockup");
    }
    if (input.tags === undefined && input.title === undefined && input.description === undefined) {
      throw new ToolError("validation_failed", "at least one of tags/title/description is required for target kind \"mockup\"");
    }
    if (!(await store.listMockups()).includes(target.mockup)) {
      throw new ToolError("not_found", `mockup "${target.mockup}" was not found`);
    }

    const current = await readMockupMetaOrDefault(store, target.mockup);
    const meta: MockupMeta = {
      ...current,
      tags: input.tags ?? current.tags,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    };
    await store.writeMockupMeta(target.mockup, meta);
    const commitResult = await store.commit(`set_meta: ${describeTarget(target)}`);
    return {
      target,
      meta: { tags: meta.tags ?? [], ...(meta.title !== undefined ? { title: meta.title } : {}), ...(meta.description !== undefined ? { description: meta.description } : {}) },
      ...commitFields(commitResult),
    };
  }

  if (target.kind === "design_system") {
    if (input.notes !== undefined || input.tags !== undefined || input.usage !== undefined || input.title !== undefined || input.description !== undefined) {
      throw new ToolError("validation_failed", "notes/tags/usage/title/description only apply to screen/component/pattern/mockup targets, not design_system");
    }
    if (input.idea === undefined && input.decisions === undefined) {
      throw new ToolError("validation_failed", "at least one of idea/decisions is required for target kind \"design_system\"");
    }

    const current = await store.readDesignSystemMeta();
    const decisions: DesignDecision[] =
      input.decisions?.map((d) => ({
        id: d.id,
        date: d.date ?? todayIso(),
        title: d.title,
        body: d.body,
        status: d.status ?? "active",
      })) ?? current.decisions;
    const meta = {
      idea: input.idea ?? current.idea,
      decisions,
      component_usage: current.component_usage,
      pattern_usage: current.pattern_usage,
    };
    await store.writeDesignSystemMeta(meta);
    const commitResult = await store.commit(`set_meta: ${describeTarget(target)}`);
    return { target, meta: { idea: meta.idea, decisions: meta.decisions }, ...commitFields(commitResult) };
  }

  // target.kind === "component" | "pattern"
  if (input.notes !== undefined || input.tags !== undefined || input.idea !== undefined || input.decisions !== undefined || input.title !== undefined || input.description !== undefined) {
    throw new ToolError("validation_failed", "notes/tags/idea/decisions/title/description only apply to screen/design_system/mockup targets, not component/pattern");
  }
  if (input.usage === undefined) {
    throw new ToolError("validation_failed", `usage is required for target kind "${target.kind}"`);
  }

  const names = target.kind === "component" ? await store.listComponents() : await store.listPatterns();
  if (!names.includes(target.name)) {
    throw new ToolError("not_found", `${target.kind} "${target.name}" was not found`);
  }

  const current = await store.readDesignSystemMeta();
  if (target.kind === "component") {
    current.component_usage[target.name] = input.usage;
  } else {
    current.pattern_usage[target.name] = input.usage;
  }
  await store.writeDesignSystemMeta(current);
  const commitResult = await store.commit(`set_meta: ${describeTarget(target)}`);
  return { target, meta: { usage: input.usage }, ...commitFields(commitResult) };
}
