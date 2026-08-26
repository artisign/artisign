import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Resolved against this file, not `process.cwd()`, so the workflow can call
// the script from anywhere — same convention as src/tools/guide.ts.
const CHANGELOG_URL = new URL("../CHANGELOG.md", import.meta.url);

/**
 * Extracts the body of a `## [<version>]` section from a Keep a Changelog
 * document — everything up to the next `## ` heading, trimmed.
 *
 * Throws when the heading is missing or its body is blank, so the release
 * workflow fails instead of opening an empty GitHub Release.
 */
export function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  if (body === "") {
    throw new Error(`The "## [${version}]" section in CHANGELOG.md is empty`);
  }

  return body;
}

async function main(): Promise<void> {
  const version = process.argv[2];
  if (version === undefined) {
    throw new Error("usage: tsx scripts/changelog-section.ts <version>");
  }

  const changelog = await readFile(CHANGELOG_URL, "utf8");
  process.stdout.write(`${changelogSection(changelog, version)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
