/**
 * Airship (AMC) egress pins — the final-URL decision for ONE upstream fetch.
 *
 * - In a leaf scope, the fetch's slug set is `envelope.fetches["<leafPath>|<fetchKind>"]`; it is allowed only if
 *   EVERY slug has at least one row covering the final URL (all-of per fetch: one slug's destinations never license
 *   another slug's egress). A leaf fetch with no entry carries no pins and falls back to `outOfLeaf`.
 * - With no leaf scope, only `outOfLeaf` counts — never a union of the leaves' rows.
 * - A miss is `observe` (log + allow) when the governing mode is `observe`, else `deny`. In a leaf scope that is
 *   `envelope.mode[leafPath]` (missing ⇒ enforce); with no scope, `observe` only when every leaf observes.
 * - No valid envelope: `deny` when `EGRESS_PINS_REQUIRED`, else `allow` (upstream behaviour).
 */
import { destinationCovers, DestRow } from './destinations';
import type { PinsEnvelope } from './egress-pins';
import type { LeafScope } from './scope';

export type EgressDecision = 'allow' | 'deny' | 'observe';

const coveredBy = (rows: DestRow[], url: string) =>
  rows.some((r) => destinationCovers(r, url));

function outOfLeafMode(envelope: PinsEnvelope): 'enforce' | 'observe' {
  const modes = Object.values(envelope.mode);
  return modes.length > 0 && modes.every((m) => m === 'observe')
    ? 'observe'
    : 'enforce';
}

export function checkEgress(
  url: string,
  scope: LeafScope | undefined,
  envelope: PinsEnvelope | null,
  opts: { required: boolean }
): EgressDecision {
  if (!envelope) return opts.required ? 'deny' : 'allow';
  const bySlug = scope
    ? envelope.fetches[`${scope.leafPath}|${scope.fetchKind}`]
    : undefined;
  const covered = bySlug
    ? Object.values(bySlug).every((rows) => coveredBy(rows, url))
    : coveredBy(envelope.outOfLeaf, url);
  if (covered) return 'allow';
  const mode = scope
    ? envelope.mode[scope.leafPath] ?? 'enforce'
    : outOfLeafMode(envelope);
  return mode === 'observe' ? 'observe' : 'deny';
}
