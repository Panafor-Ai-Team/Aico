/**
 * @vitest-environment node
 *
 * The control plane is a Hono server process. Under the repo's default DOM test
 * environment `@t3-oss/env-core` treats a server-only var as a client access and
 * throws, which the route would surface as a 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCheapVibeCodeInternalApp } from './cheapvibecodeInternal';

const SERVICE_TOKEN = `cp_${'a'.repeat(40)}`;
const PRIMARY_KEY = 'sk-cvc-primary';

const prevServiceToken = process.env.AICO_CONTROL_PLANE_SERVICE_TOKEN;
const prevCvcKey = process.env.CHEAPVIBECODE_MANAGEMENT_API_KEY;

let fetchMock: ReturnType<typeof vi.fn>;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

const call = (path: string, init: RequestInit = {}) =>
  createCheapVibeCodeInternalApp().request(
    new Request(`http://control.test${path}`, {
      headers: {
        'Authorization': `Bearer ${SERVICE_TOKEN}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string>),
      },
      ...init,
    }),
  );

beforeEach(() => {
  process.env.AICO_CONTROL_PLANE_SERVICE_TOKEN = SERVICE_TOKEN;
  process.env.CHEAPVIBECODE_MANAGEMENT_API_KEY = PRIMARY_KEY;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.AICO_CONTROL_PLANE_SERVICE_TOKEN = prevServiceToken;
  process.env.CHEAPVIBECODE_MANAGEMENT_API_KEY = prevCvcKey;
});

describe('/internal/cheapvibecode', () => {
  it('refuses an unauthenticated request before touching the primary key', async () => {
    const res = await createCheapVibeCodeInternalApp().request(
      new Request('http://control.test/v1/balance'),
    );

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a wrong service token', async () => {
    const res = await createCheapVibeCodeInternalApp().request(
      new Request('http://control.test/v1/balance', {
        headers: { Authorization: `Bearer cp_${'b'.repeat(40)}` },
      }),
    );

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports 503 rather than 500 when CheapVibeCode is not configured', async () => {
    delete process.env.CHEAPVIBECODE_MANAGEMENT_API_KEY;

    const res = await call('/v1/balance');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'cheapvibecode_not_configured' });
  });

  it('passes the token limit through verbatim — no second USD conversion', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        key: 'sk-cvc-minted',
        meta: { id: 'key-uuid', is_active: true, name: 'aico-member', token_limit: 20_000_001 },
      }),
    );

    const res = await call('/v1/keys', {
      body: JSON.stringify({ name: 'aico-member', token_limit: 20_000_001 }),
      method: 'POST',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cheapvibecode.ru/v1/keys');
    expect(init.headers.Authorization).toBe(`Bearer ${PRIMARY_KEY}`);
    // The odd token count survives the hop: a re-derivation from USD would floor it.
    expect(JSON.parse(init.body).token_limit).toBe(20_000_001);

    expect(await res.json()).toEqual({
      key: 'sk-cvc-minted',
      meta: {
        id: 'key-uuid',
        is_active: true,
        name: 'aico-member',
        token_limit: 20_000_001,
        tokens_used: 0,
      },
    });
  });

  it('answers a full CVC key inventory with a typed 409', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ error: { code: 'api_key_count_limit_exceeded' } }, 409),
    );

    const res = await call('/v1/keys', {
      body: JSON.stringify({ name: 'aico-member', token_limit: 1000 }),
      method: 'POST',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'managed_key_capacity' });
  });

  it('forwards allowed_models so the upstream scope is applied at mint time', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ key: 'sk-cvc-x', meta: { id: 'i', token_limit: 10 } }),
    );

    await call('/v1/keys', {
      body: JSON.stringify({
        allowed_models: ['glm-5.3-flash'],
        name: 'aico',
        token_limit: 10,
      }),
      method: 'POST',
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).allowed_models).toEqual(['glm-5.3-flash']);
  });

  it('rejects a non-positive token limit instead of minting an unlimited key', async () => {
    // CVC treats a missing/zero token_limit as unlimited, and there is no revoke —
    // such a key would be permanent. Refuse before the request is made.
    for (const token_limit of [0, -1, 'abc', null, undefined]) {
      const res = await call('/v1/keys', {
        body: JSON.stringify({ name: 'aico', token_limit }),
        method: 'POST',
      });

      expect(res.status).toBe(400);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the account float in USD', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ token_balance: 272_202_472 }));

    const res = await call('/v1/balance');

    expect(fetchMock.mock.calls[0][0]).toBe('https://cheapvibecode.ru/v1/balance');
    expect(await res.json()).toEqual({ balanceUsd: 272_202_472 / 25_000_000 });
  });

  describe('POST /v1/keys/edit', () => {
    const edit = (body: unknown) =>
      call('/v1/keys/edit', { body: JSON.stringify(body), method: 'POST' });

    it('forwards a freeze to CVC with the primary key', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ meta: {} }));

      const res = await edit({ active: false, key: 'sk-cvc-member' });

      expect(res.status).toBe(200);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toMatch(/\/v1\/keys\/edit$/);
      expect(init.headers.Authorization).toBe(`Bearer ${PRIMARY_KEY}`);
      expect(JSON.parse(init.body as string)).toEqual({ active: false, key: 'sk-cvc-member' });
    });

    it('forwards a delete as exactly { key, delete: true }', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: 'deleted' }));
      const res = await edit({ delete: true, key: 'sk-cvc-member' });
      expect(res.status).toBe(200);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
        delete: true,
        key: 'sk-cvc-member',
      });
    });

    it('refuses the primary key: CVC would promote another key in its place', async () => {
      const res = await edit({ delete: true, key: PRIMARY_KEY });
      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      [{ additional_tokens: 100, key: 'sk-cvc-member' }],
      [{ key: 'sk-cvc-member', token_limit: 1 }],
    ])('forwards a resize and passes back token meta only: %j', async (body) => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          meta: {
            is_active: true,
            key_prefix: 'sk-cvc-mem',
            name: 'n',
            token_limit: 101,
            tokens_used: 7,
          },
        }),
      );
      const res = await edit(body);
      expect(res.status).toBe(200);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual(body);
      expect(await res.json()).toEqual({
        meta: { is_active: true, token_limit: 101, tokens_used: 7 },
        ok: true,
      });
    });

    it.each([
      [{ additional_tokens: 0, key: 'sk-cvc-member' }],
      [{ additional_tokens: 1.5, key: 'sk-cvc-member' }],
      [{ key: 'sk-cvc-member', token_limit: -1 }],
      [{ additional_tokens: 5, key: 'sk-cvc-member', token_limit: 5 }],
      [{ active: true, delete: true, key: 'sk-cvc-member' }],
      [{ active: 'no', key: 'sk-cvc-member' }],
      [{ active: false, key: 'not-a-secret' }],
      [{ active: false }],
    ])('refuses a malformed or combined edit: %j', async (body) => {
      const res = await edit(body);
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes a CVC 404 through so the caller can treat the delete as done', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'not_found' } }, 404));
      const res = await edit({ delete: true, key: 'sk-cvc-gone' });
      expect(res.status).toBe(404);
    });

    it('marks a 5xx edit as outcome-unknown instead of retrying it', async () => {
      fetchMock.mockResolvedValue(new Response('oops', { status: 503 }));
      const res = await edit({ active: false, key: 'sk-cvc-member' });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'edit_outcome_unknown' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
