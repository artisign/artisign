// Tool-Palette v1.2 — `get_guide` is the 20th tool: serves the
// agent-facing design methodology guide (docs/agent-guide.md) so an agent
// can load it on demand without a filesystem escape hatch of its own. No
// parameters, no project required — see registry.ts.

import { readFile } from "node:fs/promises";

// `docs/` sits next to `dist/`, both one level under the package root (see
// package.json "files") — the same relative-path trick as
// `BUNDLED_MATERIAL_SYMBOLS_URL` in `src/model/fonts.ts`, so this resolves
// whether the module runs from `src/tools/` (dev, via tsx) or `dist/tools/`
// (built). `import.meta.url`, never `process.cwd()`.
const AGENT_GUIDE_URL = new URL("../../docs/agent-guide.md", import.meta.url);

export type GetGuideResult = { guide: string };

export async function getGuide(): Promise<GetGuideResult> {
  const guide = await readFile(AGENT_GUIDE_URL, "utf-8");
  return { guide };
}
