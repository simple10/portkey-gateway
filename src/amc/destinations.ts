/**
 * Airship (AMC) egress pins — destination rows and URL coverage.
 *
 * A port of the matching half of airship `shared/src/secret-destinations.ts` (`decodeBounded`, `unsafeSegment`,
 * `destPathMatches`, `destinationCovers`; as of airship 8fdf41e4). The fork runs it on the FINAL, normalized URL of
 * every upstream fetch, so the semantics must stay identical to airship's static check: the `destinations` cases in
 * `__fixtures__/egress-pins-vectors.json` pin both implementations.
 */

/** One destination of a secret: `origin` is `https://host[:port]`, `pathPrefix` is `''` (path-free) or `/a/b`. */
export type DestRow = {
  origin: string;
  pathPrefix: string;
  substitute: string[];
  legacyAnyPort: boolean;
};

/** Max percent-decoding passes (double/triple encoding; bounded so crafted input can't loop). */
const MAX_DECODE_PASSES = 8;

/** Decode every `%XX` run once, tolerating malformed escapes (UTF-8, else byte-wise latin1). */
function decodeEscapesOnce(text: string): string {
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) =>
        String.fromCharCode(parseInt(hex, 16))
      );
    }
  });
}

/** {@link decodeEscapesOnce} until it stops changing, at most MAX_DECODE_PASSES times. `settled` is false when it
 *  still changes after that (callers fail closed). */
function decodeBounded(text: string): { value: string; settled: boolean } {
  let form = text;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    const next = decodeEscapesOnce(form);
    if (next === form) return { value: form, settled: true };
    form = next;
  }
  return { value: form, settled: decodeEscapesOnce(form) === form };
}

/** True when a raw path segment is, or hides, traversal or a control byte once fully decoded. A `;params` tail is
 *  stripped from each component first, so `..;x` (a servlet-style path parameter) is traversal. */
function unsafeSegment(segment: string): boolean {
  const { value: d, settled } = decodeBounded(segment);
  if (!settled) return true;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(d)) return true;
  return d.split(/[/\\]/).some((c) => {
    const bare = c.replace(/;.*$/s, '');
    return bare === '.' || bare === '..';
  });
}

const upperHex = (s: string) =>
  s.replace(/%[0-9a-f]{2}/gi, (e) => e.toUpperCase());

/**
 * Path match on the exact URL given to `fetch`. A `''` prefix is path-free. Otherwise the URL's first raw segments
 * must equal the prefix's (byte-exact after uppercasing escape hex), and no segment of the whole path may decode to
 * traversal or a control byte. The query is never inspected.
 */
export function destPathMatches(prefix: string, url: string): boolean {
  const p = prefix.replace(/\/+$/, '');
  if (p === '') return true;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  const want = upperHex(p).split('/');
  const got = pathname.split('/');
  if (got.length < want.length) return false;
  for (let i = 0; i < want.length; i++)
    if (upperHex(got[i]!) !== want[i]) return false;
  return !got.some(unsafeSegment);
}

/** True when `row` covers `url`: the exact origin (any port when `legacyAnyPort`) and {@link destPathMatches}.
 *  A request host with a trailing dot (`https://h.example./`) is deliberately NOT covered (fail closed). */
export function destinationCovers(row: DestRow, url: string): boolean {
  let u: URL;
  let o: URL;
  try {
    u = new URL(url);
    o = new URL(row.origin);
  } catch {
    return false;
  }
  const originOk = row.legacyAnyPort
    ? u.protocol === o.protocol && u.hostname === o.hostname
    : u.origin === o.origin;
  return originOk && destPathMatches(row.pathPrefix, url);
}
