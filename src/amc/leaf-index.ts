/**
 * Airship (AMC) egress pins — a target's leaf index (CSB §5.3.3, review r1 I-1).
 *
 * The leaf path a target's fetches are checked under (`$.targets[i]`) must be its actual array position: llm keys the
 * pins by that position, and upstream's `target.originalIndex || index` lets a config author pick another target's
 * pins (a `{}` entry allows any URL). The index is stamped under a Symbol key, which no JSON config can author and
 * every object spread Portkey does (circuit-breaker map/filter, conditional `findTarget`) carries along.
 */
const LEAF_INDEX = Symbol('amc.leafIndex');

/** Stamp each entry of a `targets` array with its position. A non-array value is returned unchanged. */
export function stampLeafIndexes<T>(targets: T): T {
  if (!Array.isArray(targets)) return targets;
  return targets.map((t, i) =>
    t && typeof t === 'object' ? { ...t, [LEAF_INDEX]: i } : t
  ) as T;
}

/** The stamped position of a target. Throws on an unstamped one (fail closed: never guess a pins key). */
export function leafIndexOf(target: unknown): number {
  const i = (target as Record<symbol, unknown> | null)?.[LEAF_INDEX];
  if (typeof i !== 'number') throw new Error('amc egress: unstamped target');
  return i;
}
