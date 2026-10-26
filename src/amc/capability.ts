/**
 * Airship (AMC) egress pins — `POST /_amc/egress-capability` `{nonce}` → `{nonce, mac}`.
 *
 * llm's pre-flight probe: a correct MAC proves this Portkey holds `EGRESS_PINS_HMAC_KEY` and enforces pins.
 */
import type { Context } from 'hono';
import { capabilityProbe } from './egress-pins';
import { amcVar } from './middleware';

const MAX_NONCE = 256;

export async function egressCapabilityHandler(c: Context) {
  const key = amcVar(c, 'EGRESS_PINS_HMAC_KEY');
  if (!key) return c.json({ error: { code: 'egress_pins.key_missing' } }, 503);
  let nonce: unknown;
  try {
    nonce = ((await c.req.json()) as { nonce?: unknown })?.nonce;
  } catch {
    nonce = undefined;
  }
  if (
    typeof nonce !== 'string' ||
    nonce.length === 0 ||
    nonce.length > MAX_NONCE
  )
    return c.json({ error: { code: 'egress_pins.bad_nonce' } }, 400);
  return c.json(await capabilityProbe(nonce, key));
}
