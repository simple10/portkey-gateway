/**
 * Airship (AMC) egress pins — the final-URL decision for ONE upstream fetch.
 *
 * - In a leaf scope, the fetch's slug set is `envelope.fetches["<leafPath>|<fetchKind>"]`; it is allowed only if
 *   EVERY slug has at least one row covering the final URL (all-of per fetch: one slug's destinations never license
 *   another slug's egress). A leaf fetch with no entry carries no pins and falls back to `outOfLeaf`.
 * - With no leaf scope, only `outOfLeaf` counts — never a union of the leaves' rows.
 * - A miss is `deny`: every leaf is enforced.
 * - No envelope: `deny` when the header was present but invalid, or when `EGRESS_PINS_REQUIRED`; else (no header,
 *   not required) `allow` — upstream behaviour.
 */
import { destinationCovers, DestRow } from './destinations';
import type { PinsEnvelope } from './egress-pins';
import type { LeafScope } from './scope';

export type EgressDecision = 'allow' | 'deny';

const coveredBy = (rows: DestRow[], url: string) =>
  rows.some((r) => destinationCovers(r, url));

export function checkEgress(
  url: string,
  scope: LeafScope | undefined,
  envelope: PinsEnvelope | null,
  opts: { required: boolean; headerInvalid?: boolean }
): EgressDecision {
  if (!envelope) return opts.required || opts.headerInvalid ? 'deny' : 'allow';
  const bySlug = scope
    ? envelope.fetches[`${scope.leafPath}|${scope.fetchKind}`]
    : undefined;
  const covered = bySlug
    ? Object.values(bySlug).every((rows) => coveredBy(rows, url))
    : coveredBy(envelope.outOfLeaf, url);
  return covered ? 'allow' : 'deny';
}
