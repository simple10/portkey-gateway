import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { INVENTORY, NON_UPSTREAM_ALLOW } from './fetch-inventory';
import { amcFetch } from './fetch';

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
    expect(hits.length).toBeGreaterThan(40);
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

  it('every bare fetch( is either inventoried or allowlisted (per-file count)', () => {
    const perFile = new Map<string, number>();
    for (const h of hits.filter((h) => !allowed(h)))
      perFile.set(h.file, (perFile.get(h.file) ?? 0) + 1);
    const inventoried = new Map<string, number>();
    for (const e of INVENTORY)
      inventoried.set(
        fileOf(e.site),
        (inventoried.get(fileOf(e.site)) ?? 0) + 1
      );
    expect(Object.fromEntries(perFile)).toEqual(
      Object.fromEntries(inventoried)
    );
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
