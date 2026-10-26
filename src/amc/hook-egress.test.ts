/**
 * Airship (AMC): a guardrail/mutator check whose fetch the egress pins refused is a hook FAILURE that denies the
 * request — never a pass (CSB §14; review r1 I-2). Upstream counts a check error as a pass unless `failOnError`, so a
 * refused plugin fetch would silently switch the guardrail off.
 */
// The real plugin registry pulls in every vendor SDK; these tests install their own plugins.
jest.mock('../../plugins', () => ({ plugins: {} }));

import { HooksManager } from '../middlewares/hooks';
import { HOOKS_EVENT_TYPE_PRESETS } from '../middlewares/hooks/globals';
import { HookType } from '../middlewares/hooks/types';
import { amcFetch } from './fetch';
import { pinsState } from './scope';

/** Refuse every upstream fetch (EGRESS_PINS_REQUIRED with no envelope). */
const refusing = <T>(fn: () => Promise<T>) =>
  pinsState.run(
    { envelope: null, required: true, headerInvalid: false, requestId: 'r' },
    fn
  );

const callHook = async () => {
  const res = await amcFetch(
    'plugins/utils.ts#post',
    'https://hooks.example/x',
    { method: 'POST' }
  );
  return res;
};

const PLUGINS = {
  test: {
    // the common shape: the plugin catches the failure and reports an error (upstream: a pass)
    erroring: async () => {
      const res = await callHook();
      return {
        verdict: false,
        error: res.ok ? null : new Error(`status ${res.status}`),
      };
    },
    // a plugin that ignores the failure and says pass
    passing: async () => {
      await callHook();
      return { verdict: true, error: null };
    },
    throwing: async () => {
      const res = await callHook();
      if (!res.ok) throw new Error('boom');
      return { verdict: true };
    },
    local: async () => ({ verdict: true, error: null }),
  },
};

async function run(checkIds: string[], type = HookType.GUARDRAIL) {
  const manager = new HooksManager();
  (manager as any).plugins = PLUGINS;
  const hook: any = {
    id: 'h1',
    type,
    eventType: 'beforeRequestHook',
    deny: false,
    checks: checkIds.map((id) => ({ id, parameters: {} })),
  };
  const span = manager.createSpan(
    { messages: [{ role: 'user', content: 'hi' }] },
    {},
    'openai',
    false,
    [hook],
    [],
    null,
    'chatComplete',
    {}
  );
  return refusing(() =>
    manager.executeHooks(
      span.id,
      [HOOKS_EVENT_TYPE_PRESETS.SYNC_BEFORE_REQUEST_HOOK],
      { env: {} } as any
    )
  );
}

describe('a refused guardrail fetch denies the request', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test.each(['test.erroring', 'test.passing', 'test.throwing'])(
    '%s ⇒ verdict false + shouldDeny, even without hook.deny',
    async (id) => {
      const { results, shouldDeny } = await run([id]);
      expect(shouldDeny).toBe(true);
      expect(results[0]!.verdict).toBe(false);
      expect(results[0]!.deny).toBe(true);
    }
  );

  test('a mutator whose fetch is refused denies too', async () => {
    const { shouldDeny } = await run(['test.erroring'], HookType.MUTATOR);
    expect(shouldDeny).toBe(true);
  });

  test('one refused check among local ones still denies', async () => {
    const { shouldDeny } = await run(['test.local', 'test.passing']);
    expect(shouldDeny).toBe(true);
  });

  test('a check that fetches nothing is unaffected', async () => {
    const { results, shouldDeny } = await run(['test.local']);
    expect(shouldDeny).toBe(false);
    expect(results[0]!.verdict).toBe(true);
  });
});
