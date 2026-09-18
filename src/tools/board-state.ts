// CHR-624 / ADR-005 — the Board's shared filter and pinned screens: one
// tool, `set_board_state`, used by both the browser (POST /api/tools/, via
// ctx.source "human") and MCP agents ("agent"). A call with every field
// omitted is a pure read — it never touches ctx.viewState.setBoardState, so
// it never broadcasts.

import type { Store } from "../store/index.js";
import { ToolError, type Warning, type ToolHandlerContext, type BoardStatePatch } from "./types.js";

export type SetBoardStateInput = {
  filter?: string | null;
  pins?: { op: "add" | "remove" | "set"; screens: string[] } | { op: "clear" };
};

/**
 * Server-side reimplementation of the preview's filter rule
 * (`src/preview/screens.js` `filterScreens`) — trimmed, case-insensitive
 * substring match against the screen name or any of its tags; an
 * empty/null filter matches everything. Kept as its own small function
 * rather than imported from `src/preview/` (a browser module, not reachable
 * from the daemon process) — a genuine duplication of one four-line rule,
 * not worth a shared module for.
 */
function matchesFilter(name: string, tags: string[], needle: string): boolean {
  if (!needle) return true;
  return name.toLowerCase().includes(needle) || tags.some((tag) => tag.toLowerCase().includes(needle));
}

/**
 * An empty or whitespace-only filter is "no filter" — the same state as
 * `null` — so it's normalized before it ever reaches the store: clearing a
 * sidebar text field to `""` must not read as a *different* state from
 * `null` (a spurious change + broadcast) or leave the browser needing to
 * treat two values as "no filter". A non-empty filter's content is stored
 * exactly as given — matching already trims when it compares, so trimming
 * here too would just discard what the human typed for no benefit.
 */
function normalizeFilter(filter: string | null): string | null {
  return filter === null || filter.trim() === "" ? null : filter;
}

export async function setBoardState(store: Store, input: SetBoardStateInput, ctx?: ToolHandlerContext): Promise<Record<string, unknown>> {
  if (!ctx?.viewState) {
    // Board state lives in daemon memory only (ProjectHandle.boardState) —
    // there is no per-call fallback the way init_project's ctx.openProject
    // has one (scaffold-only). Reporting a clean error here, rather than a
    // no-op that quietly pretends a pin/filter took effect, matches the
    // existing "no project open" precedent (mcp/server.ts, tools-api.ts)
    // more closely than it matches init_project's optional-chaining
    // degrade: those tools still do their one real job without ctx, this
    // one has no job left to do without it.
    throw new ToolError("invalid_state", "set_board_state needs the daemon's board state — not available over the stdio MCP server");
  }

  const screenNames = await store.listScreens();
  const knownScreens = new Set(screenNames);
  const warnings: Warning[] = [];

  const patch: BoardStatePatch = {};
  if (input.filter !== undefined) patch.filter = normalizeFilter(input.filter);
  if (input.pins !== undefined) {
    if (input.pins.op === "add" || input.pins.op === "set") {
      // An unknown name never enters `pinned` at all — it's broadcast to
      // every connected browser and echoed to the agent, unlike, say, an
      // unresolved token ref (written into a file the human can see and
      // fix): a ghost pin has nowhere to be noticed or cleaned up. Warn for
      // every unknown name in the *original* input, but only pass the
      // known ones through. A call that named screens but got none of them
      // right changes nothing: for `add` that falls out naturally, for
      // `set` the patch is skipped — a typo must not clear the pins a human
      // set. `set` with an empty list still clears.
      const known: string[] = [];
      for (const name of input.pins.screens) {
        if (knownScreens.has(name)) known.push(name);
        else warnings.push({ kind: "unknown_ref", message: `screen "${name}" was not found` });
      }
      if (known.length > 0 || input.pins.screens.length === 0) patch.pins = { op: input.pins.op, screens: known };
    } else {
      patch.pins = input.pins; // remove / clear — nothing to validate
    }
  }

  // A call with every field omitted is a pure read: getBoardState() never
  // mutates or broadcasts, unlike setBoardState() even with a patch that
  // turns out to be a no-op (BoardStateStore.set still runs, it just
  // reports changed:false — the distinction that matters here is "did the
  // caller ask for a write at all", not "did the write turn out to change
  // anything").
  const isWrite = Object.keys(patch).length > 0;
  if (isWrite) {
    // delete_entity prunes a deleted screen's pin, but a screen can also
    // vanish without it (a branch switch, a hand edit). Any write drops
    // such pins first, so the shared state converges instead of carrying
    // them forever.
    for (const name of ctx.viewState.getBoardState().pinned) {
      if (!knownScreens.has(name)) ctx.viewState.pruneScreen(name);
    }
  }
  const state = isWrite ? ctx.viewState.setBoardState(patch) : ctx.viewState.getBoardState();

  const metas = await Promise.all(screenNames.map((name) => store.readScreenMeta(name)));
  const needle = (state.filter ?? "").trim().toLowerCase();
  const pinnedSet = new Set(state.pinned);
  const shownScreens = screenNames.filter((name, i) => pinnedSet.has(name) || matchesFilter(name, metas[i]!.tags, needle));

  return { filter: state.filter, pinned: state.pinned, shown_screens: shownScreens, warnings };
}
