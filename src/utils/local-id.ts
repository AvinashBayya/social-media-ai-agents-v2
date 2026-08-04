/**
 * Collision-resistant local identifiers, without Math.random().
 *
 * These are storage keys for locally-created records, not data values, but the
 * project bans Math.random() outright and the ban is worth keeping absolute:
 * once "it's only an id" is an accepted exception, the next exception is
 * argued the same way. There is also a correctness gain — `Math.random()
 * .toString(36).substr(2, 9)` silently drops to fewer characters whenever the
 * fractional part is short, so its collision space was smaller than it looked.
 *
 * `crypto.randomUUID` is used where available (every browser in a secure
 * context, and Node 19+). The fallback is a monotonic counter plus a timestamp,
 * which is unique within a process by construction rather than by probability.
 */

let counter = 0;

export function localId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid.slice(0, 12)}`;

  counter += 1;
  // Base-36 timestamp keeps ids sortable by creation order, which is convenient
  // when they show up in a debug dump.
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36).padStart(3, "0")}`;
}
