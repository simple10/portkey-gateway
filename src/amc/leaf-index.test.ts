/**
 * Airship (AMC): a target's leaf path — the key its egress pins are looked up under — comes from the target's actual
 * array position, never from an authored `originalIndex`/`index` (CSB §5.3.3, review r1 I-1). llm keys pins by the
 * array index (`shared/src/portkey-egress.ts` `leaves()`), so the two must agree for every strategy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leafIndexOf, stampLeafIndexes } from './leaf-index';

describe('stampLeafIndexes / leafIndexOf', () => {
  test('the stamp is the array position, whatever the target authored', () => {
    const targets = stampLeafIndexes([
      { provider: 'openai', originalIndex: 1, index: 1 },
      { provider: 'openai', originalIndex: 0 },
    ]);
    expect(targets.map(leafIndexOf)).toEqual([0, 1]);
  });

  test('the stamp survives the spreads Portkey does (circuit-breaker map + filter, conditional findTarget)', () => {
    const [a, b] = stampLeafIndexes([
      { provider: 'openai', isOpen: true },
      { provider: 'openai', originalIndex: 0 },
    ]);
    const healthy = [a, b]
      .map((t: any, i: number) => ({ ...t, originalIndex: i }))
      .filter((t: any) => !t.isOpen);
    expect(healthy.map(leafIndexOf)).toEqual([1]);
    expect(leafIndexOf({ ...a, index: 7 })).toBe(0);
  });

  test('a JSON config can never author the stamp', () => {
    const parsed = JSON.parse(
      '{"amc.leafIndex": 5, "leafIndex": 5, "Symbol(amc.leafIndex)": 5}'
    );
    expect(() => leafIndexOf(parsed)).toThrow(/unstamped/);
  });

  test('a non-array targets value is returned as is', () => {
    expect(stampLeafIndexes(undefined)).toBeUndefined();
  });
});

describe('tryTargetsRecursively builds leaf paths only from the stamp (source guard)', () => {
  const src = readFileSync(
    join(__dirname, '..', 'handlers', 'handlerUtils.ts'),
    'utf8'
  );

  test('no path is built from an authored originalIndex/index', () => {
    expect(src).not.toMatch(/\.originalIndex\s*\|\|/);
    expect(src).not.toMatch(/finalTarget\.index/);
    expect(src).not.toMatch(/targets\[\$\{originalIndex\}\]/);
  });

  test('every strategy (fallback, loadbalance, conditional, single) uses leafIndexOf', () => {
    expect((src.match(/\.targets\[\$\{leafIndexOf\(/g) ?? []).length).toBe(4);
  });

  test('targets are stamped before the circuit-breaker filter', () => {
    const stamp = src.indexOf(
      'currentTarget.targets = stampLeafIndexes(currentTarget.targets)'
    );
    expect(stamp).toBeGreaterThan(-1);
    expect(stamp).toBeLessThan(src.indexOf('const isHandlingCircuitBreaker'));
  });
});
