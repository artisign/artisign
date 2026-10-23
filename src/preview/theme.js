// Chrome theme (CHR-910): System / Light / Dark. Only the preview shell is themed — screens, mockups and in-frame highlights are user content and never see this. The same pref key and values are read pre-paint by the inline script in index.html; keep them in sync.

export const THEME_PREFS = ["system", "light", "dark"];
export const THEME_PREF_KEY = "artisign.theme";
export const DEFAULT_THEME_PREF = "system";

/**
 * The OS colour-scheme query; a stand-in that never matches where `matchMedia` is missing (jsdom), so the shell simply stays light.
 *
 * @param {Window} win
 * @returns {MediaQueryList}
 */
export function prefersDarkQuery(win) {
  return win.matchMedia?.("(prefers-color-scheme: dark)") ?? { matches: false, addEventListener() {} };
}

/**
 * @param {string} pref one of THEME_PREFS
 * @param {boolean} prefersDark the OS-level `prefers-color-scheme: dark` match
 * @returns {"light" | "dark"}
 */
export function resolveTheme(pref, prefersDark) {
  if (pref === "light" || pref === "dark") return pref;
  return prefersDark ? "dark" : "light";
}

/**
 * Next preference in the System → Light → Dark → System cycle.
 *
 * @param {string} pref
 * @returns {string}
 */
export function nextThemePref(pref) {
  const i = THEME_PREFS.indexOf(pref);
  return THEME_PREFS[(i + 1) % THEME_PREFS.length];
}

/**
 * Sets `data-theme` on `root` to the resolved theme.
 *
 * @param {HTMLElement} root
 * @param {string} pref
 * @param {{ matches: boolean }} mql the `prefers-color-scheme: dark` MediaQueryList
 */
export function applyTheme(root, pref, mql) {
  root.setAttribute("data-theme", resolveTheme(pref, mql.matches));
}

/**
 * Re-applies the theme whenever the OS preference changes, but only while the stored preference is "system" (an explicit Light/Dark ignores the OS). `getPref` is read at event time so the toggle never has to re-register.
 *
 * @param {HTMLElement} root
 * @param {MediaQueryList} mql
 * @param {() => string} getPref
 */
export function watchSystemTheme(root, mql, getPref) {
  mql.addEventListener("change", () => {
    if (getPref() === "system") applyTheme(root, "system", mql);
  });
}
