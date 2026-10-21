import { readFileSync } from "node:fs";

/** The package version, read from package.json at runtime (one level up from both src and dist). */
export function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

/** True when `a` is a higher x.y.z than `b` (pre-release tags are ignored). */
export function isNewer(a: string, b: string): boolean {
  const parts = (v: string): number[] => (v.split("-")[0] ?? "").split(".").map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const [m, n] = [x[i] ?? 0, y[i] ?? 0];
    if (m !== n) return m > n;
  }
  return false;
}
