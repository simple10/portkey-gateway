/**
 * Airship (AMC) egress pins — the single outbound fetch wrapper.
 *
 * `pinnedFetch` runs {@link checkEgress} on the final, normalized URL before EVERY upstream request and every
 * redirect hop: redirects are always fetched with `redirect:'manual'` and followed here, one checked hop at a time.
 */
import { checkEgress } from './check';
import { PINS_HEADER, REQUEST_ID_HEADER } from './egress-pins';
import { currentPinsState, LeafScope, leafScope } from './scope';

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Dropped on a cross-origin hop, as the Fetch standard does. */
const CROSS_ORIGIN_STRIP = ['authorization', 'cookie', 'proxy-authorization'];

function deniedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message:
          'Upstream destination is not pinned for the credentials in this request',
        type: 'amc_egress_denied',
        param: null,
        code: 'secret.destination_unbound',
      },
    }),
    {
      status: 403,
      headers: {
        'content-type': 'application/json',
        'x-amc-egress-denied': '1',
      },
    }
  );
}

/** One structured record per refused/observed hop. Never the query (it can carry `?key=`), never a header. */
function logUnbound(
  decision: 'deny' | 'observe',
  url: string,
  scope: LeafScope | undefined,
  requestId: string,
  site: string | undefined
): void {
  let origin = '';
  let path = '';
  try {
    const u = new URL(url);
    origin = u.origin;
    path = u.pathname;
  } catch {
    origin = '<invalid url>';
  }
  console.warn(
    JSON.stringify({
      message: 'secret.destination_unbound',
      decision,
      requestId,
      site: site ?? null,
      leafPath: scope?.leafPath ?? null,
      fetchKind: scope?.fetchKind ?? null,
      origin,
      path,
    })
  );
}

/** A body that can be sent twice (a 307/308 hop re-sends it); a stream cannot. */
function replayable(body: RequestInit['body']): boolean {
  return body == null || !(body instanceof ReadableStream);
}

/**
 * Fetch `url` under the current pins state and `scope` (default: the ambient leaf scope). A refused hop returns a
 * 403 `amc_egress_denied` response instead of fetching. A caller that asked for `redirect:'manual'`/`'error'` gets
 * the raw 3xx back (its own follow-up fetch goes through this wrapper again).
 */
export async function pinnedFetch(
  url: string | URL,
  init: RequestInit = {},
  scope: LeafScope | undefined = leafScope.getStore(),
  site?: string
): Promise<Response> {
  const state = currentPinsState();
  const callerHandlesRedirects =
    init.redirect === 'manual' || init.redirect === 'error';
  const headers = new Headers(init.headers);
  headers.delete(PINS_HEADER);
  headers.delete(REQUEST_ID_HEADER);
  let hopInit: RequestInit = { ...init, headers, redirect: 'manual' };
  let current = new URL(String(url)).href;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const decision = checkEgress(current, scope, state.envelope, state);
    if (decision !== 'allow')
      logUnbound(decision, current, scope, state.requestId, site);
    if (decision === 'deny') return deniedResponse();

    const res = await fetch(current, hopInit);
    const location = res.headers.get('location');
    if (
      callerHandlesRedirects ||
      !REDIRECT_STATUSES.has(res.status) ||
      !location
    )
      return res;

    const next = new URL(location, current);
    const method = (hopInit.method ?? 'GET').toUpperCase();
    const hopHeaders = new Headers(hopInit.headers);
    if (
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) && method === 'POST')
    ) {
      hopInit = { ...hopInit, method: method === 'HEAD' ? 'HEAD' : 'GET' };
      delete hopInit.body;
      for (const h of ['content-type', 'content-length', 'content-encoding'])
        hopHeaders.delete(h);
    } else if (!replayable(hopInit.body)) {
      return res;
    }
    if (next.origin !== new URL(current).origin)
      for (const h of CROSS_ORIGIN_STRIP) hopHeaders.delete(h);
    hopInit = { ...hopInit, headers: hopHeaders };
    current = next.href;
  }
  throw new TypeError('amc egress: too many redirects');
}
