/**
 * Airship (AMC) egress pins — the signed `x-amc-egress-pins` header and the capability probe.
 *
 * A port of airship `shared/src/egress-pins.ts`; the wire format is a cross-repo contract pinned byte-for-byte by
 * `__fixtures__/egress-pins-vectors.json` (a verbatim copy of airship `shared/src/egress-pins-vectors.json`).
 *
 *   header = base64url(JCS(envelope)) "." base64url(HMAC-SHA256(key, JCS(envelope)))
 *   probe  = { nonce, mac: base64url(HMAC-SHA256(key, "amc.egress-pins.capability.v1\n" + nonce)) }
 *
 * The HMAC key is the UTF-8 bytes of the `EGRESS_PINS_HMAC_KEY` secret; base64url carries no padding.
 *
 * `requestId` binding is nominal: the fork compares it with the `x-amc-request-id` header of the SAME request, which
 * llm sets alongside the pins header, so it cannot stop a captured header being replayed together with its request
 * id. What bounds a replay is `configHash` (pins apply only to the exact config they were built for), the 60 s
 * `exp`, and the llm→portkey link being private (a service binding; `workers_dev`/`preview_urls` off). The id still
 * ties the log records on both sides (`secret.destination_unbound`) to one request.
 */
import { jcs } from './jcs';
import type { DestRow } from './destinations';

export type FetchKind =
  | 'provider'
  | 'credential:entra'
  | 'credential:sts'
  | 'credential:vertex-oauth';

export type PinsEnvelope = {
  v: 1;
  /** SHA-256 hex of the FINAL serialized `x-portkey-config` llm sends. */
  configHash: string;
  requestId: string;
  /** Epoch ms, ≤ now + 60 s. */
  exp: number;
  /** `${leafPath}|${fetchKind}` ⇒ slug ⇒ that slug's own covering rows (all-of across slugs). */
  fetches: Record<string, Record<string, DestRow[]>>;
  /** Hosts that receive no swapped credential (plugin/guardrail hosts, the models endpoint). */
  outOfLeaf: DestRow[];
};

/** The request headers this module reads. */
export const PINS_HEADER = 'x-amc-egress-pins';
export const REQUEST_ID_HEADER = 'x-amc-request-id';

/** The longest an envelope may live (`exp ≤ now + 60 s`). */
export const PINS_MAX_TTL_MS = 60_000;

/** The largest header `verifyPins` will look at; anything longer is refused before any decoding or MAC work. */
export const PINS_MAX_HEADER_BYTES = 16384;

function requireKey(key: string): void {
  if (!key) throw new Error('egress-pins: the HMAC key is empty');
}

const CAPABILITY_PREFIX = 'amc.egress-pins.capability.v1\n';
const enc = new TextEncoder();
const utf8 = (s: string): Uint8Array => new Uint8Array(enc.encode(s));

function b64u(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64u(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    // Only the canonical (unpadded, zero-tail-bits) spelling decodes, so a header has exactly one byte form.
    return b64u(out) === s ? out : null;
  } catch {
    return null;
  }
}

function hmacKey(key: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    utf8(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage]
  );
}

async function mac(key: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(key, 'sign'), data)
  );
}

async function macOk(
  key: string,
  sig: Uint8Array,
  data: Uint8Array
): Promise<boolean> {
  return crypto.subtle.verify('HMAC', await hmacKey(key, 'verify'), sig, data);
}

/** Sign an envelope into the header value (llm's side; the fork uses it only in tests). */
export async function signPins(
  env: PinsEnvelope,
  key: string
): Promise<string> {
  requireKey(key);
  const payload = utf8(jcs(env));
  return `${b64u(payload)}.${b64u(await mac(key, payload))}`;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isDestRow(v: unknown): v is DestRow {
  return (
    isObj(v) &&
    Object.keys(v).length === 3 &&
    typeof v.origin === 'string' &&
    typeof v.pathPrefix === 'string' &&
    Array.isArray(v.substitute) &&
    v.substitute.every((s) => typeof s === 'string')
  );
}

function isEnvelope(v: unknown): v is PinsEnvelope {
  if (!isObj(v) || Object.keys(v).length !== 6 || v.v !== 1) return false;
  if (
    typeof v.configHash !== 'string' ||
    typeof v.requestId !== 'string' ||
    typeof v.exp !== 'number'
  )
    return false;
  if (!Array.isArray(v.outOfLeaf) || !v.outOfLeaf.every(isDestRow))
    return false;
  return (
    isObj(v.fetches) &&
    Object.values(v.fetches).every(
      (bySlug) =>
        isObj(bySlug) &&
        Object.values(bySlug).every(
          (rows) => Array.isArray(rows) && rows.every(isDestRow)
        )
    )
  );
}

/**
 * Verify a header and return its envelope, or `null` (never throws): the key must be non-empty, the header at most
 * {@link PINS_MAX_HEADER_BYTES}, the MAC must verify under `key`, the payload
 * must be canonical JCS of a well-formed envelope, `configHash`/`requestId` must equal the request's own, and
 * `now < exp ≤ now + 60 s`.
 */
export async function verifyPins(
  header: string,
  key: string,
  now: number,
  configHash: string,
  requestId: string
): Promise<PinsEnvelope | null> {
  if (!key || header.length > PINS_MAX_HEADER_BYTES) return null;
  const parts = header.split('.');
  if (parts.length !== 2) return null;
  const payload = fromB64u(parts[0]!);
  const sig = fromB64u(parts[1]!);
  if (!payload || !sig || payload.length === 0) return null;
  if (!(await macOk(key, sig, payload))) return null;
  let text: string;
  let env: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      payload
    );
    env = JSON.parse(text);
    if (jcs(env) !== text) return null;
  } catch {
    return null;
  }
  if (!isEnvelope(env)) return null;
  if (env.configHash !== configHash || env.requestId !== requestId) return null;
  if (!(env.exp > now) || env.exp > now + PINS_MAX_TTL_MS) return null;
  return env;
}

/** The answer to llm's pre-flight probe: it proves the fork holds the pins key and speaks this format. */
export async function capabilityProbe(
  nonce: string,
  key: string
): Promise<{ nonce: string; mac: string }> {
  requireKey(key);
  return { nonce, mac: b64u(await mac(key, utf8(CAPABILITY_PREFIX + nonce))) };
}
