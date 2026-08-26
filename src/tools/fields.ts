import { ToolError } from "./types.js";

/**
 * Trims a tiered response down to the caller-selected `fields`, always
 * keeping the tool's base identity/summary keys. An unknown field name is a
 * hard validation error (Schema-Spec: "no silent ignore — drift between
 * tool callers and server is too cheap to enable").
 */
export function selectFields<T extends Record<string, unknown>>(
  response: T,
  alwaysKeep: readonly string[],
  optionalKeys: readonly string[],
  fields: string[] | undefined,
): T {
  if (!fields || fields.length === 0) return response;

  for (const field of fields) {
    if (!optionalKeys.includes(field)) {
      throw new ToolError("validation_failed", `unknown field "${field}"`);
    }
  }

  const result: Record<string, unknown> = {};
  for (const key of alwaysKeep) {
    if (key in response) result[key] = response[key];
  }
  for (const key of fields) {
    if (key in response) result[key] = response[key];
  }
  return result as T;
}
