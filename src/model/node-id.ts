/**
 * Assigns stable node ids during a single parse pass, in pre-order.
 *
 * - An explicit `id` (or `data-node-id`) attribute on the source element is
 *   always used as-is. Callers must call `seedUsed()` with every explicit id
 *   present anywhere in the document *before* allocation starts, so that
 *   auto-generated ids never collide with an explicit id encountered later
 *   in document order.
 * - Otherwise ids are generated as `n<counter>`, counting in pre-order over
 *   element-like nodes. Because the counter only depends on document order,
 *   re-parsing the same file yields the same ids.
 * - Text nodes get `<parentId>t` (with a numeric suffix for the 2nd+ text
 *   child of the same parent), since HTML text nodes cannot carry an `id`
 *   attribute of their own.
 * - A duplicate explicit id (the same id used on two elements) is only
 *   honored for its first occurrence; later occurrences silently fall back
 *   to an auto-generated id rather than clobbering the first element in the
 *   flat node map. Callers are expected to also report this as a
 *   `duplicate_node_id` validation error.
 */
export class NodeIdAllocator {
  private counter = 0;
  private used = new Set<string>();
  private consumedExplicit = new Set<string>();
  private textCounters = new Map<string, number>();

  /** Reserves ids up front so later auto-generated ids never collide with them. */
  seedUsed(ids: Iterable<string>): void {
    for (const id of ids) this.used.add(id);
  }

  allocateElementId(explicitId?: string): string {
    if (explicitId && !this.consumedExplicit.has(explicitId)) {
      this.consumedExplicit.add(explicitId);
      this.used.add(explicitId);
      return explicitId;
    }
    return this.generateId();
  }

  allocateTextId(parentId: string): string {
    const seen = this.textCounters.get(parentId) ?? 0;
    this.textCounters.set(parentId, seen + 1);
    return seen === 0 ? `${parentId}t` : `${parentId}t${seen + 1}`;
  }

  private generateId(): string {
    let id: string;
    do {
      this.counter += 1;
      id = `n${this.counter}`;
    } while (this.used.has(id));
    this.used.add(id);
    return id;
  }
}
