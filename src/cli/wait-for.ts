/** Polls `check` until it resolves truthy, or gives up after `timeoutMs`. */
export async function waitFor<T>(timeoutMs: number, check: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
