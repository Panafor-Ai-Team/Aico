import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cvcTokensToUsd,
  HttpCheapVibeCodeClient,
  isManagedKeyCapacityError,
  MockCheapVibeCodeClient,
  RemoteCheapVibeCodeClient,
  usdToCvcTokens,
} from './index';

const TOKENS_PER_USD = 25_000_000;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CVC token <-> USD conversion', () => {
  it('floors USD to tokens so a key never gets more capacity than was paid for', () => {
    expect(usdToCvcTokens(1)).toBe(TOKENS_PER_USD);
    expect(usdToCvcTokens(0.8)).toBe(20_000_000);
    // 0.000_000_1 USD is a fraction of a token — round down, not up.
    expect(usdToCvcTokens(1 / TOKENS_PER_USD / 2)).toBe(0);
  });

  it('treats unusable amounts as zero rather than minting a negative limit', () => {
    expect(usdToCvcTokens(0)).toBe(0);
    expect(usdToCvcTokens(-5)).toBe(0);
    expect(usdToCvcTokens(Number.NaN)).toBe(0);
    expect(cvcTokensToUsd(-1)).toBe(0);
  });

  it('round-trips a whole-dollar amount exactly', () => {
    expect(cvcTokensToUsd(usdToCvcTokens(12))).toBe(12);
  });
});

describe('HttpCheapVibeCodeClient', () => {
  const client = () => new HttpCheapVibeCodeClient('sk-cvc-primary');

  it('declares the capabilities CVC actually has', () => {
    expect(client().capabilities).toEqual({
      nativePeriodicLimits: false,
      readKeyBySecret: true,
      revoke: false,
      updateLimit: false,
    });
    // Absent, not throwing: callers branch on capabilities rather than catching.
    expect((client() as { deleteKey?: unknown }).deleteKey).toBeUndefined();
    expect((client() as { updateKey?: unknown }).updateKey).toBeUndefined();
  });

  it('mints a key with a token limit converted from USD', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        key: 'sk-cvc-minted',
        meta: { id: 'key-uuid', is_active: true, name: 'aico-member', token_limit: 20_000_000 },
      }),
    );

    const created = await client().createKey({ limitUsd: 0.8, name: 'aico-member' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cheapvibecode.ru/v1/keys');
    expect(JSON.parse(init.body)).toEqual({ name: 'aico-member', token_limit: 20_000_000 });
    expect(created).toMatchObject({ hash: 'key-uuid', key: 'sk-cvc-minted', limit: 0.8 });
    // No native period reset — the nulls are what tell callers to checkpoint.
    expect(created.usageDaily).toBeNull();
    expect(created.usageWeekly).toBeNull();
    expect(created.usageMonthly).toBeNull();
  });

  it('types a full key inventory so callers can tell it from a transient fault', async () => {
    // Measured on prod 2026-09-22: every mint failed with this once the account was full.
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'api_key_count_limit_exceeded', message: 'Too many API keys' } },
        409,
      ),
    );

    const error = await client()
      .createKey({ limitUsd: 1, name: 'aico' })
      .catch((e: unknown) => e);

    expect(isManagedKeyCapacityError(error)).toBe(true);
    // A 4xx is not retried on the fallback domain.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps any other 409 generic', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'conflict' } }, 409));

    const error = await client()
      .createKey({ limitUsd: 1, name: 'aico' })
      .catch((e: unknown) => e);

    expect(isManagedKeyCapacityError(error)).toBe(false);
    expect((error as Error).message).toBe('CheapVibeCode API 409: ');
  });

  it('refuses a create response with no key rather than persisting a dangling row', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ meta: { id: 'key-uuid' } }));

    await expect(client().createKey({ limitUsd: 1, name: 'aico' })).rejects.toThrow('missing key');
  });

  it('sends allowed_models only when there are some', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ key: 'sk-cvc-x', meta: { id: 'i', token_limit: 1 } }),
    );

    await client().createKey({ allowedModels: [], limitUsd: 1, name: 'aico' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('allowed_models');

    await client().createKey({ allowedModels: ['glm-5.3-flash'], limitUsd: 1, name: 'aico' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).allowed_models).toEqual(['glm-5.3-flash']);
  });

  it('reads a key balance by authenticating as that key, not the primary', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ token_balance: 20_000_000 }));

    const info = await client().getKey({ apiKey: 'sk-cvc-member', hash: 'key-uuid' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cheapvibecode.ru/v1/balance');
    expect(init.headers.Authorization).toBe('Bearer sk-cvc-member');
    expect(info.limitRemaining).toBe(0.8);
  });

  it('derives usage from the mint-time limit the caller supplies', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ token_balance: 15_000_000 }));

    const info = await client().getKey({
      apiKey: 'sk-cvc-member',
      hash: 'key-uuid',
      limitUsd: 0.8,
    });

    expect(info.limit).toBe(0.8);
    expect(info.limitRemaining).toBe(0.6);
    expect(info.usage).toBeCloseTo(0.2, 12);
  });

  it('reports zero usage rather than guessing when the limit is unknown', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ token_balance: 15_000_000 }));

    const info = await client().getKey({ apiKey: 'sk-cvc-member', hash: 'key-uuid' });

    expect(info.limit).toBeNull();
    expect(info.usage).toBe(0);
  });

  it('refuses to read a key without its secret', async () => {
    await expect(client().getKey({ hash: 'key-uuid' })).rejects.toThrow('apiKey is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a rate-limited balance read instead of reporting an empty key', async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, 429))
        .mockResolvedValueOnce(jsonResponse({ token_balance: 5_000_000 }));

      const pending = client().getKey({ apiKey: 'sk-cvc-member', hash: 'h' });
      await vi.advanceTimersByTimeAsync(1000);

      await expect(pending).resolves.toMatchObject({ limitRemaining: 0.2 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws on a persistent 429 — a rate limit must never read as a spent key', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async () => jsonResponse({ error: 'rate limited' }, 429));

      const pending = client()
        .getKey({ apiKey: 'sk-cvc-member', hash: 'h' })
        .then(() => null)
        .catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(30_000);

      const settled = await pending;
      expect(settled).toBeInstanceOf(Error);
      expect(settled?.message).toContain('429');
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws rather than reporting 0 when the balance field is missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unexpected: true }));

    await expect(client().getKey({ apiKey: 'sk-cvc-member', hash: 'h' })).rejects.toThrow(
      'missing a numeric balance',
    );
  });

  it('does not retry a 4xx — the request is wrong, not throttled', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'forbidden' }, 403));

    await expect(client().getKey({ apiKey: 'sk-cvc-member', hash: 'h' })).rejects.toThrow('403');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps upstream response bodies out of the thrown error (DATA-013)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ secret: 'sk-cvc-leaked' }, 403));

    await expect(client().getKey({ apiKey: 'sk-cvc-member', hash: 'h' })).rejects.toThrow(
      /^CheapVibeCode API 403/,
    );
  });
});

describe('MockCheapVibeCodeClient', () => {
  it('models CVC faithfully: balance falls only with upstream spend', async () => {
    const mock = new MockCheapVibeCodeClient();
    const created = await mock.createKey({ limitUsd: 0.8, name: 'aico' });

    expect(await mock.getKey({ apiKey: created.key, hash: created.hash })).toMatchObject({
      limitRemaining: 0.8,
    });

    mock.__spend(created.key, 5_000_000);

    const after = await mock.getKey({
      apiKey: created.key,
      hash: created.hash,
      limitUsd: 0.8,
    });
    expect(after.limitRemaining).toBe(0.6);
    expect(after.usage).toBeCloseTo(0.2, 12);
  });

  it('offers no revoke or update, exactly like the real thing', () => {
    const mock = new MockCheapVibeCodeClient();
    expect((mock as { deleteKey?: unknown }).deleteKey).toBeUndefined();
    expect((mock as { updateKey?: unknown }).updateKey).toBeUndefined();
  });
});

describe('RemoteCheapVibeCodeClient', () => {
  it('rebuilds the typed capacity error from the control-plane 409', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'managed_key_capacity' }, 409));

    const error = await new RemoteCheapVibeCodeClient('http://control.test', 'token')
      .createKey({ limitUsd: 1, name: 'aico' })
      .catch((e: unknown) => e);

    expect(isManagedKeyCapacityError(error)).toBe(true);
  });
});
