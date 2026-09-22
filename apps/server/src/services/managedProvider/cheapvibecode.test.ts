import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CheapVibeCodeAmbiguousEditError, CheapVibeCodeApiError } from './cheapvibecode';
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
      revoke: true,
      updateLimit: false,
    });
  });

  describe('key edit (POST /v1/keys/edit)', () => {
    const editBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

    it('freezes a key by its secret, authenticating as the primary', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ meta: {} }));

      await client().updateKey({ apiKey: 'sk-cvc-member', disabled: true, hash: 'k1' });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://cheapvibecode.ru/v1/keys/edit');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer sk-cvc-primary');
      expect(editBody()).toEqual({ active: false, key: 'sk-cvc-member' });
    });

    it('unfreezes with active: true', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ meta: {} }));
      await client().updateKey({ apiKey: 'sk-cvc-member', disabled: false, hash: 'k1' });
      expect(editBody()).toEqual({ active: true, key: 'sk-cvc-member' });
    });

    it('deletes with exactly { key, delete: true }', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: 'deleted' }));
      await client().deleteKey({ apiKey: 'sk-cvc-member', hash: 'k1' });
      expect(editBody()).toEqual({ delete: true, key: 'sk-cvc-member' });
    });

    it('treats a delete of a key CVC no longer has as done', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'not_found' } }, 404));
      await expect(client().deleteKey({ apiKey: 'sk-cvc-gone', hash: 'k1' })).resolves.toBe(
        undefined,
      );
    });

    it('never asks CVC to change a limit — additional_tokens is not idempotent', async () => {
      await expect(
        client().updateKey({ apiKey: 'sk-cvc-member', hash: 'k1', limitUsd: 5 }),
      ).rejects.toThrow(/freeze\/unfreeze only/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses to edit or delete without the key secret', async () => {
      await expect(client().deleteKey({ hash: 'k1' })).rejects.toThrow(/apiKey is required/);
      await expect(client().updateKey({ disabled: true, hash: 'k1' })).rejects.toThrow(
        /apiKey is required/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses to touch the primary key, which CVC would replace by promotion', async () => {
      await expect(
        client().updateKey({ apiKey: 'sk-cvc-primary', disabled: true, hash: 'p' }),
      ).rejects.toThrow(/primary key/);
      await expect(client().deleteKey({ apiKey: 'sk-cvc-primary', hash: 'p' })).rejects.toThrow(
        /primary key/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports a 5xx edit as outcome-unknown and does not re-send it', async () => {
      fetchMock.mockResolvedValue(new Response('bad gateway', { status: 502 }));

      await expect(
        client().updateKey({ apiKey: 'sk-cvc-member', disabled: true, hash: 'k1' }),
      ).rejects.toBeInstanceOf(CheapVibeCodeAmbiguousEditError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports a network failure mid-edit as outcome-unknown', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        client().deleteKey({ apiKey: 'sk-cvc-member', hash: 'k1' }),
      ).rejects.toBeInstanceOf(CheapVibeCodeAmbiguousEditError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still retries a 429, which CVC did not process', async () => {
      vi.useFakeTimers();
      try {
        fetchMock
          .mockResolvedValueOnce(new Response('', { status: 429 }))
          .mockResolvedValueOnce(jsonResponse({ meta: {} }));

        const pending = client().updateKey({
          apiKey: 'sk-cvc-member',
          disabled: false,
          hash: 'k1',
        });
        await vi.runAllTimersAsync();
        await pending;

        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    describe('resizeKey', () => {
      const meta = (tokenLimit: number, tokensUsed = 0, active = true) =>
        jsonResponse({
          meta: { is_active: active, token_limit: tokenLimit, tokens_used: tokensUsed },
        });
      const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string));

      it('reads the live limit, then raises by exactly the missing tokens', async () => {
        fetchMock.mockResolvedValueOnce(meta(100)).mockResolvedValueOnce(meta(TOKENS_PER_USD * 2));

        const info = await client().resizeKey({
          active: true,
          apiKey: 'sk-cvc-member',
          hash: 'k1',
          limitUsd: 2,
        });

        expect(bodies()).toEqual([
          { active: true, key: 'sk-cvc-member' },
          { additional_tokens: TOKENS_PER_USD * 2 - 100, key: 'sk-cvc-member' },
        ]);
        expect(info.limit).toBe(2);
      });

      it('reduces with an absolute token_limit, clamped to what the key has used', async () => {
        fetchMock
          .mockResolvedValueOnce(meta(TOKENS_PER_USD * 5, TOKENS_PER_USD * 3))
          .mockResolvedValueOnce(meta(TOKENS_PER_USD * 3, TOKENS_PER_USD * 3));

        await client().resizeKey({
          active: true,
          apiKey: 'sk-cvc-member',
          hash: 'k1',
          limitUsd: 1,
        });

        expect(bodies()[1]).toEqual({ key: 'sk-cvc-member', token_limit: TOKENS_PER_USD * 3 });
      });

      it('sends no limit edit when the key is already at the target', async () => {
        fetchMock.mockResolvedValueOnce(meta(TOKENS_PER_USD));
        await client().resizeKey({
          active: false,
          apiKey: 'sk-cvc-member',
          hash: 'k1',
          limitUsd: 1,
        });
        expect(bodies()).toEqual([{ active: false, key: 'sk-cvc-member' }]);
      });

      it('never re-sends a raise whose outcome is unknown', async () => {
        fetchMock
          .mockResolvedValueOnce(meta(100))
          .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));

        await expect(
          client().resizeKey({ active: true, apiKey: 'sk-cvc-member', hash: 'k1', limitUsd: 2 }),
        ).rejects.toBeInstanceOf(CheapVibeCodeAmbiguousEditError);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it('refuses an uncapped key rather than guessing a delta', async () => {
        fetchMock.mockResolvedValueOnce(
          jsonResponse({ meta: { is_active: true, token_limit: null } }),
        );
        await expect(
          client().resizeKey({ active: true, apiKey: 'sk-cvc-member', hash: 'k1', limitUsd: 2 }),
        ).rejects.toThrow(/token_limit/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('refuses the primary key', async () => {
        await expect(
          client().resizeKey({ active: true, apiKey: 'sk-cvc-primary', hash: 'p', limitUsd: 2 }),
        ).rejects.toThrow(/primary key/);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    it("carries CVC's error.code on a rejected edit, not the body", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: { code: 'key_not_owned', message: 'secret detail' } }, 403),
      );

      const error = await client()
        .updateKey({ apiKey: 'sk-cvc-member', disabled: true, hash: 'k1' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CheapVibeCodeApiError);
      expect((error as CheapVibeCodeApiError).code).toBe('key_not_owned');
      expect((error as Error).message).not.toContain('secret detail');
    });
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

  it('freezes, unfreezes and deletes by secret, like the real thing', async () => {
    const mock = new MockCheapVibeCodeClient();
    const created = await mock.createKey({ limitUsd: 1, name: 'm' });
    const credential = { apiKey: created.key, hash: created.hash, limitUsd: 1 };

    await mock.updateKey({ apiKey: created.key, disabled: true, hash: created.hash });
    expect(mock.__state(created.key)).toBe('frozen');
    // A frozen key cannot authenticate, so its balance cannot be read.
    await expect(mock.getKey(credential)).rejects.toThrow(/401/);

    await mock.updateKey({ apiKey: created.key, disabled: false, hash: created.hash });
    await expect(mock.getKey(credential)).resolves.toMatchObject({ limitRemaining: 1 });

    await mock.deleteKey(credential);
    expect(mock.__state(created.key)).toBe('deleted');
  });
});

describe('MockCheapVibeCodeClient resize', () => {
  it('raises and lowers the same key the way CVC does', async () => {
    const mock = new MockCheapVibeCodeClient();
    const created = await mock.createKey({ limitUsd: 1, name: 'm' });
    const params = { active: true, apiKey: created.key, hash: created.hash };

    await mock.resizeKey({ ...params, limitUsd: 3 });
    expect(mock.__limitTokens(created.key)).toBe(TOKENS_PER_USD * 3);

    mock.__spend(created.key, TOKENS_PER_USD * 2);
    await mock.resizeKey({ ...params, limitUsd: 1 });
    // Never below what was used.
    expect(mock.__limitTokens(created.key)).toBe(TOKENS_PER_USD * 2);
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

  const remote = () => new RemoteCheapVibeCodeClient('http://control.test', 'token');

  it('proxies a freeze to the control plane with the target secret', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await remote().updateKey({ apiKey: 'sk-cvc-member', disabled: true, hash: 'k1' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://control.test/internal/cheapvibecode/v1/keys/edit');
    expect(init.headers.Authorization).toBe('Bearer token');
    expect(JSON.parse(init.body as string)).toEqual({ active: false, key: 'sk-cvc-member' });
  });

  it('resizes through the proxy from the token meta it passes back', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ meta: { is_active: true, tokens_used: 0, token_limit: 100 }, ok: true }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          meta: { is_active: true, tokens_used: 0, token_limit: TOKENS_PER_USD },
          ok: true,
        }),
      );

    const info = await remote().resizeKey({
      active: true,
      apiKey: 'sk-cvc-member',
      hash: 'k1',
      limitUsd: 1,
    });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      additional_tokens: TOKENS_PER_USD - 100,
      key: 'sk-cvc-member',
    });
    expect(info.limit).toBe(1);
  });

  it('treats a proxied 404 delete as done', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'not_found' }, 404));
    await expect(remote().deleteKey({ apiKey: 'sk-cvc-gone', hash: 'k1' })).resolves.toBe(
      undefined,
    );
  });

  it('rebuilds the outcome-unknown error from the control plane', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'edit_outcome_unknown' }, 502));
    await expect(
      remote().deleteKey({ apiKey: 'sk-cvc-member', hash: 'k1' }),
    ).rejects.toBeInstanceOf(CheapVibeCodeAmbiguousEditError);
  });
});
