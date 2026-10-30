import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
// utils/env uses top-level await, which ts-jest's CommonJS can't load; the schemas don't read it at load.
jest.mock('../utils/env', () => ({ Environment: () => ({}) }));

import * as z from './zod';
import { configSchema } from '../middlewares/requestValidator/schema/config';
import { tryChatToTextTransformation } from '../providers/bedrock/uploadFileUtils';
import { LogsService } from '../handlers/services/logsService';

// A member missing from ./zod is `undefined` at runtime and the bundler doesn't object, so the worker would throw
// when the schema module loads. This test is the check (tsc isn't clean upstream, so CI doesn't run it).

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });

describe('src/amc/zod', () => {
  it('re-exports every zod member the gateway calls', () => {
    const root = join(__dirname, '..', '..');
    const users = ['src', 'plugins']
      .flatMap((d) => sources(join(root, d)))
      .filter((f) =>
        /from ['"][./]+(amc\/)?zod['"]/.test(readFileSync(f, 'utf8'))
      );
    expect(users.length).toBeGreaterThanOrEqual(3);
    for (const file of users) {
      const used = new Set(
        [
          ...readFileSync(file, 'utf8').matchAll(
            /\bz\s*\.\s*([A-Za-z_$][\w$]*)/g
          ),
        ].map((m) => m[1])
      );
      for (const member of used) {
        expect([
          file,
          member,
          typeof (z as Record<string, unknown>)[member],
        ]).toEqual([file, member, 'function']);
      }
    }
  });

  it('the request validator schema loads and parses', () => {
    expect(
      configSchema.safeParse({ provider: 'openai', api_key: 'k' }).success
    ).toBe(true);
    expect(
      configSchema.safeParse({
        strategy: { mode: 'fallback' },
        targets: [
          { provider: 'openai', api_key: 'a' },
          { cache: { mode: 'simple' } },
        ],
      }).success
    ).toBe(true);
    const bad = configSchema.safeParse({
      strategy: { mode: 'single' },
      targets: [{ retry: { attempts: '2' } }],
    });
    expect(bad.success).toBe(false);
    expect(
      bad.error.issues.map((i: { path: unknown[] }) => i.path.join('.'))
    ).toContain('targets.0.retry.attempts');
    expect(configSchema.safeParse({}).success).toBe(false);
  });

  it('the Bedrock dataset transform and the logs service load', () => {
    expect(
      tryChatToTextTransformation({
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'yo' },
        ],
      })
    ).toEqual({ prompt: 'hi', completion: 'yo' });
    expect(tryChatToTextTransformation({ messages: 'x' })).toBeNull();
    expect(typeof LogsService).toBe('function');
  });
});
