import { readFileSync } from "node:fs";

/** The package version, read from package.json at runtime (one level up from both src and dist). */
export function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}
