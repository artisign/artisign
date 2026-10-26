import { readFileSync } from "node:fs";
import { isNewer } from "./version.js";

export type Release = { version: string; date: string | null; body: string };

const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/;
const LINK_REFERENCE = /^\[[^\]]+\]:\s*\S+/;
/** A line that starts a Markdown block of its own (heading, list item, table row, fence, rule) rather than continuing the one above. */
const BLOCK_START = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||```|---\s*$|\*\*\*\s*$)/;

/**
 * The CHANGELOG is hard-wrapped for the editor; the preview's Markdown renderer keeps a line break as a break. Joins
 * every continuation line — of a paragraph or of a list item, indented or not — onto the line above, leaving block
 * starts, blank lines and fenced code untouched.
 */
export function unwrapLines(lines: string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) inFence = !inFence;
    const previous = out[out.length - 1];
    const continues = !inFence && !trimmed.startsWith("```") && trimmed !== "" && previous !== undefined && previous.trim() !== "" && !BLOCK_START.test(trimmed);
    if (continues) out[out.length - 1] = `${previous} ${trimmed}`;
    else out.push(line);
  }
  return out;
}

/**
 * Parses Keep-a-Changelog text into its released sections, in file order. A section runs from its
 * `## [x.y.z] - YYYY-MM-DD` heading (date optional) to the next `## ` heading; its Markdown is kept, trimmed, with
 * hard-wrapped lines joined (`unwrapLines`) and trailing link-reference definitions dropped. `[Unreleased]` and any other heading are skipped.
 */
export function parseChangelog(text: string): Release[] {
  const releases: Release[] = [];
  let current: { version: string; date: string | null; lines: string[] } | undefined;
  const finish = (): void => {
    if (!current) return;
    const lines = current.lines;
    while (lines.length > 0 && (lines[lines.length - 1]!.trim() === "" || LINK_REFERENCE.test(lines[lines.length - 1]!))) lines.pop();
    releases.push({ version: current.version, date: current.date, body: unwrapLines(lines).join("\n").trim() });
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      finish();
      const match = RELEASE_HEADING.exec(line);
      current = match ? { version: match[1]!, date: match[2] ?? null, lines: [] } : undefined;
    } else {
      current?.lines.push(line);
    }
  }
  finish();
  return releases;
}

/** The shipped `CHANGELOG.md` (next to package.json, from both src and dist); a missing or unreadable file is an empty list. */
export function readChangelog(): Release[] {
  try {
    return parseChangelog(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"));
  } catch {
    return [];
  }
}

/** Releases with `since < v <= upTo` (no lower bound without `since`), newest first. */
export function releasesBetween(releases: Release[], since: string | undefined, upTo: string): Release[] {
  return releases
    .filter((r) => !isNewer(r.version, upTo) && (since === undefined || isNewer(r.version, since)))
    .sort((a, b) => (isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0));
}
