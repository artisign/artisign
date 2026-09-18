// CHR-624 / ADR-005 — the Board's shared filter and pinned-screen set, held
// in daemon memory only, one instance per open project (a sibling of
// `ProjectHandle.sseHub`, not owned by it — see project-registry.ts). Never
// touches `Store`: nothing here is written to the project folder or
// `.artisign/`, and nothing survives a daemon restart or a project close.

export type BoardState = { filter: string | null; pinned: string[] };

export type PinsPatch = { op: "add" | "remove" | "set"; screens: string[] } | { op: "clear" };

/** `filter: undefined` = unchanged, `null` = clear. `pins: undefined` = unchanged. */
export type BoardStatePatch = { filter?: string | null; pins?: PinsPatch };

export type BoardStateStore = {
  get(): BoardState;
  /**
   * Applies a patch. Stores whatever screen names the patch names, with no
   * existence check of its own — the tool layer (`tools/board-state.ts`) is
   * the gate: it already knows the project's live screen list, so it's the
   * one place that can both warn on an unknown name AND keep it out of
   * `pinned` before it ever reaches here (a ghost pin would otherwise be
   * broadcast to every connected browser and echoed to the agent, with
   * nowhere to be noticed or cleaned up). `changed` is false (no-op, no
   * broadcast) when the patch doesn't actually move the state — e.g.
   * re-adding an already-pinned screen, or a `filter` equal to the current
   * one.
   */
  set(patch: BoardStatePatch): { state: BoardState; changed: boolean };
  /** Drops `name` from `pinned` if present — the delete_entity hook. */
  pruneScreen(name: string): { state: BoardState; changed: boolean };
};

function dedupe(names: string[]): string[] {
  return [...new Set(names)];
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function applyPins(current: string[], patch: PinsPatch): string[] {
  if (patch.op === "clear") return [];
  if (patch.op === "set") return dedupe(patch.screens);
  if (patch.op === "add") return dedupe([...current, ...patch.screens]);
  const toRemove = new Set(patch.screens);
  return current.filter((name) => !toRemove.has(name));
}

export function createBoardStateStore(): BoardStateStore {
  let filter: string | null = null;
  let pinned: string[] = [];

  function snapshot(): BoardState {
    return { filter, pinned: [...pinned] };
  }

  function get(): BoardState {
    return snapshot();
  }

  function set(patch: BoardStatePatch): { state: BoardState; changed: boolean } {
    let changed = false;
    if (patch.filter !== undefined && patch.filter !== filter) {
      filter = patch.filter;
      changed = true;
    }
    if (patch.pins) {
      const next = applyPins(pinned, patch.pins);
      if (!arraysEqual(pinned, next)) {
        pinned = next;
        changed = true;
      }
    }
    return { state: snapshot(), changed };
  }

  function pruneScreen(name: string): { state: BoardState; changed: boolean } {
    if (!pinned.includes(name)) return { state: snapshot(), changed: false };
    pinned = pinned.filter((n) => n !== name);
    return { state: snapshot(), changed: true };
  }

  return { get, set, pruneScreen };
}
