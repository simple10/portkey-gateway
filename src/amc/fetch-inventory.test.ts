import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { INVENTORY, NON_UPSTREAM_ALLOW } from './fetch-inventory';
import { amcFetch } from './fetch';
import type { PinsEnvelope } from './egress-pins';
import { pinsState, withLeafScope } from './scope';
import { retryRequest } from '../handlers/retryHandler';
import { getAccessTokenFromEntraId } from '../providers/azure-openai/utils';
import { post } from '../../plugins/utils';

const ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['src', 'plugins'];
const SCAN_EXT = /\.(ts|js|html)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__fixtures__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SCAN_EXT.test(name) && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

type Hit = { file: string; line: number; text: string };

/** Every call of a function named `fetch` (bare, `globalThis.fetch(`, `binding.fetch(`); not `amcFetch(`. */
function bareFetchHits(): Hit[] {
  const hits: Hit[] = [];
  for (const dir of SCAN_DIRS)
    for (const abs of walk(join(ROOT, dir))) {
      const file = relative(ROOT, abs).split('\\').join('/');
      readFileSync(abs, 'utf8')
        .split('\n')
        .forEach((text, i) => {
          if (/(^|[^\w$])fetch\s*\(/.test(text))
            hits.push({ file, line: i + 1, text });
        });
    }
  return hits;
}

const allowed = (h: Hit) =>
  NON_UPSTREAM_ALLOW.some(
    (a) =>
      (h.file === a.path || h.file.startsWith(`${a.path}/`)) &&
      (a.match === undefined || h.text.includes(a.match))
  );

const fileOf = (site: string) => site.split('#')[0];

describe('fetch inventory (R6-2 grep guard)', () => {
  const hits = bareFetchHits();

  it('finds the known upstream surface (sanity: the scan works)', () => {
    const routedCalls = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))).reduce(
      (n, f) =>
        n + (readFileSync(f, 'utf8').match(/amcFetch\(\s*'/g) ?? []).length,
      0
    );
    expect(hits.length + routedCalls).toBeGreaterThan(50);
  });

  it('every NON_UPSTREAM_ALLOW entry has a reason and still matches something', () => {
    for (const a of NON_UPSTREAM_ALLOW) {
      expect(a.reason.length).toBeGreaterThan(10);
      expect(hits.some((h) => allowed(h) && h.file.startsWith(a.path))).toBe(
        true
      );
    }
  });

  it('INVENTORY sites are unique, well-formed and tagged consistently', () => {
    const sites = INVENTORY.map((e) => e.site);
    expect(new Set(sites).size).toBe(sites.length);
    for (const e of INVENTORY) {
      expect(e.site).toMatch(/^(src|plugins)\/[\w./-]+\.ts#\w+$/);
      if (e.kind === 'credential-field')
        expect(e.fetchKind).toMatch(/^credential:/);
      else expect(e.fetchKind).toBeUndefined();
    }
  });

  it('no bare fetch( outside NON_UPSTREAM_ALLOW: every upstream call goes through amcFetch', () => {
    expect(hits.filter((h) => !allowed(h))).toEqual([]);
  });

  it('each routed site calls amcFetch with its own literal site, exactly once, in its own file', () => {
    const sources = new Map<string, string>();
    const read = (file: string) => {
      if (!sources.has(file))
        sources.set(file, readFileSync(join(ROOT, file), 'utf8'));
      return sources.get(file)!;
    };
    for (const e of INVENTORY) {
      const calls =
        read(fileOf(e.site)).split(
          new RegExp(
            `amcFetch\\(\\s*'${e.site.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'`
          )
        ).length - 1;
      expect({ site: e.site, calls }).toEqual({ site: e.site, calls: 1 });
    }
    // No literal names a site that is not inventoried.
    for (const file of new Set(INVENTORY.map((e) => fileOf(e.site)))) {
      for (const m of read(file).matchAll(/amcFetch\(\s*'([^']+)'/g))
        expect(INVENTORY.some((e) => e.site === m[1])).toBe(true);
    }
  });
});

describe('amcFetch', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refuses an untagged site without fetching', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('ok'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await amcFetch(
      'src/nowhere.ts#unknown',
      'https://x.example',
      {}
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a tagged site fetches (no pins state ⇒ upstream behaviour)', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('ok'));
    const res = await amcFetch(INVENTORY[0].site, 'https://x.example', {});
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('routed sites run under the pins', () => {
  const CF = 'https://gateway.ai.cloudflare.com';
  const row = (origin: string, pathPrefix = '') => ({
    origin,
    pathPrefix,
    substitute: [],
    legacyAnyPort: false,
  });
  const envelope = (
    fetches: PinsEnvelope['fetches'],
    outOfLeaf: PinsEnvelope['outOfLeaf'] = []
  ): PinsEnvelope => ({
    v: 1,
    configHash: 'h',
    requestId: 'r',
    exp: Date.now() + 30_000,
    mode: { '$.targets[0]': 'enforce' },
    fetches,
    outOfLeaf,
  });
  const run = <T>(env: PinsEnvelope, fn: () => Promise<T>) =>
    pinsState.run({ envelope: env, required: true, requestId: 'r' }, () =>
      withLeafScope('config.targets[0]', fn)
    );

  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{}'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('tryTargetsRecursively runs each tryPost inside its target leaf scope', () => {
    const src = readFileSync(
      join(ROOT, 'src/handlers/handlerUtils.ts'),
      'utf8'
    );
    expect(src).toMatch(/withLeafScope\(currentJsonPath, \(\) =>\s*tryPost\(/);
  });

  it('retryRequest (provider leaf) is refused off-pin and fetches on-pin', async () => {
    const env = envelope({
      '$.targets[0]|provider': { X: [row(CF, '/v1/acctA/gwA')] },
    });
    const off = await run(env, () =>
      retryRequest(`${CF}/v1/acctB/gwB/x`, { method: 'POST' }, 0, [], null)
    );
    expect(off.response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    const on = await run(env, () =>
      retryRequest(`${CF}/v1/acctA/gwA/x`, { method: 'POST' }, 0, [], 5000)
    );
    expect(on.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the Entra token helper runs as credential:entra, not under the provider pins', async () => {
    const LOGIN = 'https://login.microsoftonline.com';
    const fetches = {
      '$.targets[0]|provider': { K: [row('https://res.openai.azure.com')] },
    };
    const covered = envelope({
      ...fetches,
      '$.targets[0]|credential:entra': { E: [row(LOGIN, '/tenant-1')] },
    });
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ access_token: 'tok' }))
    );
    expect(
      await run(covered, () => getAccessTokenFromEntraId('tenant-1', 'id', 's'))
    ).toBe('tok');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const uncovered = envelope({
      ...fetches,
      '$.targets[0]|credential:entra': { E: [row(LOGIN, '/tenant-2')] },
    });
    expect(
      await run(uncovered, () =>
        getAccessTokenFromEntraId('tenant-1', 'id', 's')
      )
    ).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an out-of-leaf site ignores the ambient leaf pins: only outOfLeaf counts', async () => {
    const url = 'https://control.example/v2/models';
    const leafOnly = envelope({
      '$.targets[0]|provider': { X: [row('https://control.example')] },
    });
    const res = await run(leafOnly, () =>
      amcFetch('src/handlers/modelsHandler.ts#controlPlane', url, {})
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    const allowed = envelope(leafOnly.fetches, [
      row('https://control.example'),
    ]);
    await run(allowed, () =>
      amcFetch('src/handlers/modelsHandler.ts#controlPlane', url, {})
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a guardrail plugin call inside a target is out-of-leaf: the leaf pins never license it', async () => {
    const guard = 'https://guard.example/v1/check';
    const leafOnly = envelope({
      '$.targets[0]|provider': { X: [row('https://guard.example')] },
    });
    await expect(run(leafOnly, () => post(guard, {}))).rejects.toThrow(
      'HTTP error! status: 403'
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const allowed = envelope(leafOnly.fetches, [row('https://guard.example')]);
    await run(allowed, () => post(guard, {}));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
