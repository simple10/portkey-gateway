import { Hono } from 'hono';
import vectors from './__fixtures__/egress-pins-vectors.json';
import {
  capabilityProbe,
  PinsEnvelope,
  signPins,
  verifyPins,
} from './egress-pins';
import type { DestRow } from './destinations';
import { checkEgress } from './check';
import { leafScope, pinsState, toLeafPath, withLeafScope } from './scope';
import { pinnedFetch } from './fetch';
import { amcEgressPins } from './middleware';
import { egressCapabilityHandler } from './capability';
import { sha256Hex } from './jcs';

const row = (origin: string, pathPrefix = ''): DestRow => ({
  origin,
  pathPrefix,
  substitute: [],
  legacyAnyPort: false,
});

const CF = 'https://gateway.ai.cloudflare.com';
const acctA = row(CF, '/v1/acctA/gwA');
const acctB = row(CF, '/v1/acctB/gwB');
const LOGIN = 'https://login.microsoftonline.com';

const envelope = (over: Partial<PinsEnvelope> = {}): PinsEnvelope => ({
  v: 1,
  configHash: 'h',
  requestId: 'r',
  exp: Date.now() + 30_000,
  mode: { '$.targets[0]': 'enforce' },
  fetches: {},
  outOfLeaf: [],
  ...over,
});

const provider = { leafPath: '$.targets[0]', fetchKind: 'provider' } as const;
const entra = {
  leafPath: '$.targets[0]',
  fetchKind: 'credential:entra',
} as const;

let fetchMock: jest.SpyInstance;
let warnMock: jest.SpyInstance;
beforeEach(() => {
  fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response('ok'));
  warnMock = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('vectors (byte-for-byte cross-repo contract)', () => {
  it.each(vectors.pins.map((p, i) => [i, p] as const))(
    'pins vector %i signs and verifies byte-for-byte',
    async (_i, p) => {
      const env = p.envelope as unknown as PinsEnvelope;
      expect(await signPins(env, p.key)).toBe(p.header);
      const got = await verifyPins(
        p.header,
        p.key,
        env.exp - 1,
        env.configHash,
        env.requestId
      );
      expect(got).toEqual(env);
    }
  );

  it('the capability probe MAC matches the vector', async () => {
    const c = vectors.capability;
    expect(await capabilityProbe(c.nonce, c.key)).toEqual({
      nonce: c.nonce,
      mac: c.mac,
    });
  });

  it('a wrong configHash / requestId / key, or a flipped byte, does not verify', async () => {
    const p = vectors.pins[1];
    const env = p.envelope as unknown as PinsEnvelope;
    const now = env.exp - 1;
    expect(
      await verifyPins(p.header, p.key, now, 'x', env.requestId)
    ).toBeNull();
    expect(
      await verifyPins(p.header, p.key, now, env.configHash, 'x')
    ).toBeNull();
    expect(
      await verifyPins(p.header, 'other', now, env.configHash, env.requestId)
    ).toBeNull();
    const flipped =
      p.header.slice(0, 10) +
      (p.header[10] === 'A' ? 'B' : 'A') +
      p.header.slice(11);
    expect(
      await verifyPins(flipped, p.key, now, env.configHash, env.requestId)
    ).toBeNull();
    expect(
      await verifyPins(p.header, p.key, env.exp, env.configHash, env.requestId)
    ).toBeNull();
  });
});

describe('checkEgress — per-fetch all-of', () => {
  const twoSlugs = envelope({
    fetches: { '$.targets[0]|provider': { X: [acctA], Y: [acctA, acctB] } },
  });

  it('a final URL only one slug covers is denied (spec §10 item 11)', () => {
    expect(
      checkEgress(`${CF}/v1/acctB/gwB/openai/chat`, provider, twoSlugs, {
        required: false,
      })
    ).toBe('deny');
    expect(
      checkEgress(`${CF}/v1/acctA/gwA/openai/chat`, provider, twoSlugs, {
        required: false,
      })
    ).toBe('allow');
  });

  it('checks the normalized URL: a model-in-path traversal escapes nothing', () => {
    const escaped = new URL(
      `${CF}/v1/acctA/gwA/openai/../../../acctB/gwB/openai/chat`
    ).href;
    expect(checkEgress(escaped, provider, twoSlugs, { required: false })).toBe(
      'deny'
    );
  });

  it('a credential:entra fetch is checked against its own slug set, not the provider leaf', () => {
    const env = envelope({
      fetches: {
        '$.targets[0]|provider': { K: [row('https://res.openai.azure.com')] },
        '$.targets[0]|credential:entra': { E: [row(LOGIN, '/tenant-1')] },
      },
    });
    const tokenUrl = `${LOGIN}/tenant-1/oauth2/v2.0/token`;
    expect(checkEgress(tokenUrl, entra, env, { required: false })).toBe(
      'allow'
    );
    const uncovered = envelope({
      fetches: {
        ...env.fetches,
        '$.targets[0]|credential:entra': { E: [row(LOGIN, '/tenant-2')] },
      },
    });
    expect(checkEgress(tokenUrl, entra, uncovered, { required: false })).toBe(
      'deny'
    );
  });

  it('with no leaf in scope, only outOfLeaf counts', () => {
    const env = envelope({
      fetches: { '$.targets[0]|provider': { X: [acctA] } },
      outOfLeaf: [row('https://guard.example')],
    });
    expect(
      checkEgress('https://guard.example/check', undefined, env, {
        required: false,
      })
    ).toBe('allow');
    expect(
      checkEgress(`${CF}/v1/acctA/gwA/x`, undefined, env, { required: false })
    ).toBe('deny');
  });

  it('a leaf fetch with no pins entry falls back to outOfLeaf (never a union)', () => {
    const env = envelope({
      fetches: { '$.targets[1]|provider': { X: [acctA] } },
    });
    expect(
      checkEgress(`${CF}/v1/acctA/gwA/x`, provider, env, { required: false })
    ).toBe('deny');
  });

  it('observe mode reports observe instead of deny', () => {
    const env = envelope({
      mode: { '$.targets[0]': 'observe' },
      fetches: { '$.targets[0]|provider': { X: [acctA] } },
    });
    expect(
      checkEgress(`${CF}/v1/acctB/gwB/x`, provider, env, { required: false })
    ).toBe('observe');
  });

  it('no envelope: allowed unless EGRESS_PINS_REQUIRED', () => {
    expect(checkEgress(`${CF}/x`, provider, null, { required: false })).toBe(
      'allow'
    );
    expect(checkEgress(`${CF}/x`, provider, null, { required: true })).toBe(
      'deny'
    );
  });
});

describe('scope', () => {
  it("maps Portkey's jsonPath onto llm's leafPath", () => {
    expect(toLeafPath('config')).toBe('$');
    expect(toLeafPath('config.targets[1].targets[0]')).toBe(
      '$.targets[1].targets[0]'
    );
  });

  it('withLeafScope sets a provider scope for the duration of the call', async () => {
    const seen = await withLeafScope('config.targets[0]', async () =>
      leafScope.getStore()
    );
    expect(seen).toEqual(provider);
    expect(leafScope.getStore()).toBeUndefined();
  });
});

describe('pinnedFetch — modes and redirects', () => {
  const state = (env: PinsEnvelope | null, required = false) => ({
    envelope: env,
    required,
    requestId: 'r',
  });
  const pinned = envelope({
    fetches: { '$.targets[0]|provider': { X: [acctA] } },
  });

  it('enforce: an uncovered URL is refused without any fetch', async () => {
    const res = await pinsState.run(state(pinned), () =>
      leafScope.run(provider, () =>
        pinnedFetch(`${CF}/v1/acctB/gwB/x`, {}, leafScope.getStore())
      )
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('observe: logs secret.destination_unbound and allows', async () => {
    const env = { ...pinned, mode: { '$.targets[0]': 'observe' as const } };
    const res = await pinsState.run(state(env), () =>
      leafScope.run(provider, () =>
        pinnedFetch(`${CF}/v1/acctB/gwB/x?key=SECRET`, {}, leafScope.getStore())
      )
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warnMock.mock.calls);
    expect(logged).toContain('secret.destination_unbound');
    expect(logged).not.toContain('SECRET');
  });

  it('EGRESS_PINS_REQUIRED with no header refuses every fetch', async () => {
    const res = await pinsState.run(state(null, true), () =>
      pinnedFetch('https://api.openai.com/v1/chat', {}, leafScope.getStore())
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows redirects manually and re-checks every hop', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: `${CF}/v1/acctB/gwB/x` },
        })
    );
    const res = await pinsState.run(state(pinned), () =>
      leafScope.run(provider, () =>
        pinnedFetch(
          `${CF}/v1/acctA/gwA/x`,
          { method: 'GET' },
          leafScope.getStore()
        )
      )
    );
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
  });

  it('a covered redirect hop is followed (still manual)', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: '/v1/acctA/gwA/y' },
        })
    );
    const res = await pinsState.run(state(pinned), () =>
      leafScope.run(provider, () =>
        pinnedFetch(
          `${CF}/v1/acctA/gwA/x`,
          { method: 'POST', body: '{}' },
          leafScope.getStore()
        )
      )
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(`${CF}/v1/acctA/gwA/y`);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      redirect: 'manual',
      method: 'POST',
      body: '{}',
    });
  });

  it('never forwards the pins headers upstream', async () => {
    await pinsState.run(state(pinned), () =>
      leafScope.run(provider, () =>
        pinnedFetch(
          `${CF}/v1/acctA/gwA/x`,
          {
            headers: {
              'x-amc-egress-pins': 'h',
              'x-amc-request-id': 'r',
              a: 'b',
            },
          },
          leafScope.getStore()
        )
      )
    );
    const sent = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(sent.get('x-amc-egress-pins')).toBeNull();
    expect(sent.get('x-amc-request-id')).toBeNull();
    expect(sent.get('a')).toBe('b');
  });
});

describe('request middleware', () => {
  const KEY = 'test-pins-key';
  const CONFIG = '{"provider":"openai"}';

  const app = new Hono();
  app.use('*', amcEgressPins);
  app.post('/v1/chat/completions', async () =>
    withLeafScope('config.targets[0]', () =>
      pinnedFetch(
        `${CF}/v1/acctA/gwA/openai/chat`,
        { method: 'POST' },
        leafScope.getStore()
      )
    )
  );

  const call = (headers: Record<string, string>, required: string) =>
    app.request(
      '/v1/chat/completions',
      { method: 'POST', headers: { 'x-portkey-config': CONFIG, ...headers } },
      { EGRESS_PINS_HMAC_KEY: KEY, EGRESS_PINS_REQUIRED: required }
    );

  it('a valid header binds the request: covered fetch allowed', async () => {
    const env = envelope({
      configHash: await sha256Hex(CONFIG),
      requestId: 'req-1',
      fetches: { '$.targets[0]|provider': { X: [acctA] } },
    });
    const res = await call(
      {
        'x-amc-egress-pins': await signPins(env, KEY),
        'x-amc-request-id': 'req-1',
      },
      '1'
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a wrong configHash ⇒ no valid header ⇒ refused when required', async () => {
    const env = envelope({
      configHash: await sha256Hex('{"provider":"other"}'),
      requestId: 'req-1',
      fetches: { '$.targets[0]|provider': { X: [acctA] } },
    });
    const res = await call(
      {
        'x-amc-egress-pins': await signPins(env, KEY),
        'x-amc-request-id': 'req-1',
      },
      '1'
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no header and EGRESS_PINS_REQUIRED=0 ⇒ upstream behaviour (allowed)', async () => {
    const res = await call({}, '0');
    expect(res.status).toBe(200);
  });
});

describe('POST /_amc/egress-capability', () => {
  const app = new Hono();
  app.post('/_amc/egress-capability', egressCapabilityHandler);

  it('answers {nonce, mac} matching the vector', async () => {
    const c = vectors.capability;
    const res = await app.request(
      '/_amc/egress-capability',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: c.nonce }),
      },
      { EGRESS_PINS_HMAC_KEY: c.key }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nonce: c.nonce, mac: c.mac });
  });

  it('503 when the key is not configured; 400 on a bad nonce', async () => {
    const noKey = await app.request(
      '/_amc/egress-capability',
      { method: 'POST', body: JSON.stringify({ nonce: 'n' }) },
      {}
    );
    expect(noKey.status).toBe(503);
    const bad = await app.request(
      '/_amc/egress-capability',
      { method: 'POST', body: JSON.stringify({ nonce: 7 }) },
      { EGRESS_PINS_HMAC_KEY: 'k' }
    );
    expect(bad.status).toBe(400);
  });
});
