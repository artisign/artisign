// Test helper (CHR-924): an in-memory stand-in for the daemon's /api/settings routes, for the DOM tests' fetch stubs. Not part of the served preview.

/**
 * @param {{ prefs?: Record<string, string>, migrated?: boolean }} [initial]
 * @returns {{
 *   prefs: Record<string, string>,
 *   migrated: boolean,
 *   saves: Record<string, string | null>[],
 *   imports: Record<string, string>[],
 *   handle: (path: string, init?: { method?: string, body?: string }) => object | null,
 * }}
 */
export function fakeSettings(initial = {}) {
  const state = {
    prefs: { ...(initial.prefs ?? {}) },
    migrated: initial.migrated ?? false,
    saves: [],
    imports: [],
    /** Returns a fetch response for a settings path, or null for any other path. */
    handle(path, init) {
      if (path !== "/api/settings" && path !== "/api/settings/import") return null;
      const reply = (body) => ({ ok: true, status: 200, json: async () => body });
      if (init?.method === "POST") {
        const { prefs } = JSON.parse(init.body);
        if (path === "/api/settings/import") {
          state.imports.push(prefs);
          const imported = !state.migrated;
          if (imported) Object.assign(state.prefs, prefs);
          state.migrated = true;
          return reply({ prefs: state.prefs, migrated: true, imported });
        }
        state.saves.push(prefs);
        for (const [k, v] of Object.entries(prefs)) {
          if (v === null) delete state.prefs[k];
          else state.prefs[k] = v;
        }
      }
      return reply({ prefs: state.prefs, migrated: state.migrated });
    },
  };
  return state;
}
