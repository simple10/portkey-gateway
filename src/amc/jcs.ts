/**
 * Airship (AMC) egress pins — RFC 8785 JSON Canonicalization Scheme.
 *
 * A port of airship `shared/src/jcs.ts`: the pins MAC is computed over JCS bytes, so this must stay
 * byte-identical with the airship implementation (pinned by `__fixtures__/egress-pins-vectors.json`).
 */

/** RFC 8785 requires well-formed Unicode: a lone surrogate has no UTF-8 form, so refuse it. */
function assertWellFormed(s: string): void {
  if (
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
      s
    )
  )
    throw new Error('jcs: lone surrogate');
}

export function jcs(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new Error('jcs: non-finite number');
      return String(v);
    case 'string':
      assertWellFormed(v);
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) {
        return `[${v
          .map((x) => {
            if (x === undefined) throw new Error('jcs: undefined in array');
            return jcs(x);
          })
          .join(',')}]`;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null)
        throw new Error('jcs: non-plain object');
      const o = v as Record<string, unknown>;
      const parts: string[] = [];
      for (const k of Object.keys(o).sort()) {
        assertWellFormed(k);
        // An undefined property is omitted (JSON.stringify semantics).
        if (o[k] === undefined) continue;
        parts.push(`${JSON.stringify(k)}:${jcs(o[k])}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`jcs: unsupported value type ${typeof v}`);
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}
