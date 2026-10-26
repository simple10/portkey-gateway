/**
 * Airship (AMC) egress pins — the tagged inventory of every upstream fetch site (spec R6-2, SF-B).
 *
 * Each site calls `amcFetch('<site>', url, init)`; `amcFetch` refuses a site that is not listed here, and
 * `fetch-inventory.test.ts` greps `src/` + `plugins/` for `fetch(` and fails on any call that is neither routed
 * through `amcFetch` nor in {@link NON_UPSTREAM_ALLOW}.
 *
 * Kinds:
 * - `leaf`: a provider call; inside a target's scope it is checked against `<leafPath>|provider` pins, outside one
 *   (no target, e.g. a scope-less files call) only against `outOfLeaf`.
 * - `credential-field`: a token helper transmitting only its credential field's secret; checked against
 *   `<leafPath>|<fetchKind>` pins (per-fetch all-of, R6-1), else `outOfLeaf`.
 * - `out-of-leaf`: never carries a swapped credential (guardrail plugins, the models control plane); checked only
 *   against `outOfLeaf`, even when it runs inside a target's scope.
 */
import type { FetchKind } from './egress-pins';

export type InventoryEntry = {
  /** `<repo path>#<label>` — the literal first argument at the call site. */
  site: string;
  kind: 'leaf' | 'out-of-leaf' | 'credential-field';
  fetchKind?: FetchKind;
};

const leaf = (site: string): InventoryEntry => ({ site, kind: 'leaf' });
const outOfLeaf = (site: string): InventoryEntry => ({
  site,
  kind: 'out-of-leaf',
});
const credential = (site: string, fetchKind: FetchKind): InventoryEntry => ({
  site,
  kind: 'credential-field',
  fetchKind,
});

export const INVENTORY: readonly InventoryEntry[] = [
  // Provider calls made by tryPost → retryRequest, and the realtime upgrade.
  leaf('src/handlers/retryHandler.ts#fetchWithTimeout'),
  leaf('src/handlers/retryHandler.ts#retryRequest'),
  leaf('src/handlers/realtimeHandler.ts#websocketUpgrade'),
  leaf('src/providers/bedrock/utils.ts#inferenceProfile'),

  // Credential-field token helpers.
  credential(
    'src/providers/azure-openai/utils.ts#entraToken',
    'credential:entra'
  ),
  credential(
    'src/providers/azure-openai/utils.ts#managedIdentityToken',
    'credential:entra'
  ),
  credential(
    'src/providers/azure-openai/utils.ts#workloadIdentityToken',
    'credential:entra'
  ),
  credential('src/providers/bedrock/utils.ts#assumeRole', 'credential:sts'),
  credential(
    'src/providers/google-vertex-ai/utils.ts#serviceAccountToken',
    'credential:vertex-oauth'
  ),

  // Batch / file / finetune request handlers (run inside tryPost, so in the target's scope).
  leaf('src/providers/azure-ai-inference/getBatchOutput.ts#retrieveBatch'),
  leaf('src/providers/azure-ai-inference/getBatchOutput.ts#fileContent'),
  leaf('src/providers/azure-openai/getBatchOutput.ts#retrieveBatch'),
  leaf('src/providers/azure-openai/getBatchOutput.ts#fileContent'),
  leaf('src/providers/azure-openai/getBatchOutput.ts#outputBlob'),
  leaf('src/providers/bedrock/getBatchOutput.ts#retrieveBatch'),
  leaf('src/providers/bedrock/getBatchOutput.ts#s3Output'),
  leaf('src/providers/bedrock/retrieveFile.ts#retrieveFile'),
  leaf('src/providers/bedrock/retrieveFileContent.ts#retrieveFileContent'),
  leaf('src/providers/bedrock/uploadFile.ts#createMultipartUpload'),
  leaf('src/providers/bedrock/uploadFile.ts#uploadPart'),
  leaf('src/providers/bedrock/uploadFile.ts#completeMultipartUpload'),
  leaf('src/providers/cohere/getBatchOutput.ts#retrieveBatch'),
  leaf('src/providers/cohere/getBatchOutput.ts#retrieveFile'),
  leaf('src/providers/cohere/getBatchOutput.ts#filePart'),
  leaf('src/providers/fireworks-ai/cancelFinetune.ts#cancelFinetune'),
  leaf('src/providers/fireworks-ai/uploadFile.ts#presignedUpload'),
  leaf('src/providers/fireworks-ai/utils.ts#uploadEndpoint'),
  leaf('src/providers/fireworks-ai/utils.ts#createDataset'),
  leaf('src/providers/fireworks-ai/utils.ts#validateDataset'),
  leaf('src/providers/google-vertex-ai/getBatchOutput.ts#batch'),
  leaf('src/providers/google-vertex-ai/getBatchOutput.ts#output'),
  leaf('src/providers/google-vertex-ai/retrieveFile.ts#head'),
  leaf('src/providers/google-vertex-ai/uploadFile.ts#upload'),
  leaf('src/providers/openai/getBatchOutput.ts#retrieveBatch'),
  leaf('src/providers/openai/getBatchOutput.ts#fileContent'),

  // The models control plane (ALBUS_BASEPATH) — no swapped credential.
  outOfLeaf('src/handlers/modelsHandler.ts#controlPlane'),

  // Guardrail plugins: their hosts and credentials come from hook `checks`, which llm never swaps.
  outOfLeaf('plugins/utils.ts#post'),
  outOfLeaf('plugins/azure/utils.ts#entraToken'),
  outOfLeaf('plugins/azure/utils.ts#managedIdentityToken'),
  outOfLeaf('plugins/bedrock/util.ts#guardrail'),
  outOfLeaf('plugins/default/jwt.ts#jwks'),
  outOfLeaf('plugins/default/validUrls.ts#head'),
  outOfLeaf('plugins/default/validUrls.ts#dnsQuery'),
  outOfLeaf('plugins/javelin/guardrails.ts#guardrail'),
];

export type AllowEntry = {
  /** A file, or a directory prefix. */
  path: string;
  /** Only lines containing this text (default: every line in `path`). */
  match?: string;
  reason: string;
};

/** Calls of a function named `fetch` that are not upstream egress from this worker. */
export const NON_UPSTREAM_ALLOW: readonly AllowEntry[] = [
  {
    path: 'src/amc/fetch-inventory.ts',
    reason:
      'this table: its string literals name call sites, they are not calls',
  },
  {
    path: 'src/amc/fetch.ts',
    match: 'await fetch(current, hopInit)',
    reason:
      'the egress wrapper itself: every hop it makes has just passed checkEgress',
  },
  {
    path: 'src/public/index.html',
    reason:
      'browser-side script of the bundled playground page; runs in the user agent, not in the worker',
  },
  {
    path: 'src/tests',
    reason:
      'test-suite helpers (src/tests/**) that call a locally running gateway; never bundled into the worker',
  },
  {
    path: 'plugins/utils.ts',
    match: 'serviceBinding.fetch(',
    reason:
      'Cloudflare service-binding call to a bound worker (portkey plugins only); not internet egress',
  },
];

export const INVENTORY_BY_SITE: ReadonlyMap<string, InventoryEntry> = new Map(
  INVENTORY.map((e) => [e.site, e])
);
