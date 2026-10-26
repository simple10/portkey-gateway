/**
 * Airship (AMC) egress pins — request entry: verify `x-amc-egress-pins` ONCE (its `exp` is ≤ 60 s, and retries or
 * fallbacks may outlive that) and run the rest of the request inside `pinsState`.
 *
 * The envelope binds `configHash` = SHA-256 hex of the exact `x-portkey-config` header and `requestId` = the
 * `x-amc-request-id` header. A present-but-invalid header (bad MAC/hash/id/exp, oversized, or no key configured)
 * refuses every upstream fetch whatever `EGRESS_PINS_REQUIRED` says; an absent header refuses only when
 * `EGRESS_PINS_REQUIRED=1`, else the request keeps upstream behaviour.
 */
import type { Context, Next } from 'hono';
import { env } from 'hono/adapter';
import { PINS_HEADER, REQUEST_ID_HEADER, verifyPins } from './egress-pins';
import { sha256Hex } from './jcs';
import { latchRequired, pinsState } from './scope';

/** Worker bindings (`c.env`) first, then the runtime adapter (`process.env` on node). */
export function amcVar(c: Context, name: string): string | undefined {
  const bound = (c.env as Record<string, unknown> | undefined)?.[name];
  if (typeof bound === 'string') return bound;
  const fromAdapter = (env(c) as Record<string, unknown>)[name];
  return typeof fromAdapter === 'string' ? fromAdapter : undefined;
}

export async function amcEgressPins(c: Context, next: Next) {
  const required = amcVar(c, 'EGRESS_PINS_REQUIRED') === '1';
  if (required) latchRequired();
  const key = amcVar(c, 'EGRESS_PINS_HMAC_KEY');
  const header = c.req.header(PINS_HEADER);
  const requestId = c.req.header(REQUEST_ID_HEADER) ?? '';
  // Present means present: an empty `x-amc-egress-pins:` is an invalid header, not an absent one.
  const headerPresent = header !== undefined && header !== null;
  const envelope =
    header && key
      ? await verifyPins(
          header,
          key,
          Date.now(),
          await sha256Hex(c.req.header('x-portkey-config') ?? ''),
          requestId
        )
      : null;
  if (headerPresent && !envelope)
    console.warn(
      JSON.stringify({
        message: 'egress_pins.invalid',
        requestId,
        keyConfigured: !!key,
        required,
      })
    );
  const headerInvalid = headerPresent && !envelope;
  return pinsState.run({ envelope, required, headerInvalid, requestId }, () =>
    next()
  );
}
