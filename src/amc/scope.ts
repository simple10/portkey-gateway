/**
 * Airship (AMC) egress pins — request-scoped state (`AsyncLocalStorage`, `nodejs_compat`).
 *
 * - `pinsState`: the request's verified envelope + `EGRESS_PINS_REQUIRED`, set once at request entry
 *   (`middleware.ts`).
 * - `leafScope`: the config leaf a fetch belongs to, set around each per-target `tryPost` (`withLeafScope`). A fetch
 *   with no leaf in scope never carries a leaf's pins: it is checked only against the envelope's `outOfLeaf`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FetchKind, PinsEnvelope } from './egress-pins';

export type LeafScope = { leafPath: string; fetchKind: FetchKind };

export type PinsState = {
  /** The verified envelope, or `null` when the header is absent or invalid. */
  envelope: PinsEnvelope | null;
  /** `EGRESS_PINS_REQUIRED=1`: no valid envelope ⇒ refuse every upstream fetch. */
  required: boolean;
  requestId: string;
};

export const leafScope = new AsyncLocalStorage<LeafScope | undefined>();
export const pinsState = new AsyncLocalStorage<PinsState>();

/** Portkey's target jsonPath (`config`, `config.targets[1]`) as llm's leaf path (`$`, `$.targets[1]`). */
export function toLeafPath(jsonPath: string): string {
  return jsonPath.startsWith('config')
    ? `$${jsonPath.slice('config'.length)}`
    : jsonPath;
}

/** Run `fn` (one per-target attempt) with that target's provider scope. */
export function withLeafScope<T>(jsonPath: string, fn: () => T): T {
  return leafScope.run(
    { leafPath: toLeafPath(jsonPath), fetchKind: 'provider' },
    fn
  );
}

/**
 * Once any request in this isolate ran with `EGRESS_PINS_REQUIRED=1`, a fetch that somehow runs outside a request
 * scope is refused too (fail closed); before that, a scope-less fetch (tests, tooling) keeps upstream behaviour.
 */
let requiredLatched = false;
export function latchRequired(): void {
  requiredLatched = true;
}

/** The current request's state, or the scope-less default. */
export function currentPinsState(): PinsState {
  return (
    pinsState.getStore() ?? {
      envelope: null,
      required: requiredLatched,
      requestId: '',
    }
  );
}
