import { mapCheapVibeCodeModelCard } from '@lobechat/model-runtime';
import type { ChatModelCard } from '@lobechat/types';

import { aicoEnv } from '@/envs/aico';

import type { CreateManagedKeyResult, ManagedKeyInfo, ManagedProviderClient } from './types';

/**
 * CheapVibeCode managed-provider client.
 *
 * What CVC actually offers, measured (see `docs/aico/CHEAPVIBECODE_PROVIDER_PROBE.md`):
 * `POST /v1/keys` creates, `GET /v1/balance` reports the calling key's remaining
 * allowance, `GET /v1/models` lists the catalog. There is no list, read, update,
 * disable, or delete for keys — `GET/PATCH/DELETE /v1/keys` return 405 and
 * `/v1/keys/{id}` returns 404. Hence `capabilities` denies revoke, updateLimit
 * and nativePeriodicLimits, and `updateKey` / `deleteKey` are absent rather than
 * present-and-throwing.
 *
 * Never treat `POST /v1/keys` as an upsert: it ignores unknown fields and always
 * creates. A probe that posted `{id, is_active: false}` hoping to disable a key
 * minted a brand new one with `token_limit: null` — unlimited, and unrevokable.
 */

/**
 * CVC refuses `POST /v1/keys` with 409 `api_key_count_limit_exceeded` once the
 * account holds its maximum number of keys. Keys cannot be deleted through the
 * API, so this does not clear by retrying: only shared-key mode or CVC support
 * can. Carried across the control-plane hop as {@link MANAGED_KEY_CAPACITY}.
 */
export const MANAGED_KEY_CAPACITY = 'managed_key_capacity';
const CVC_KEY_LIMIT_CODE = 'api_key_count_limit_exceeded';

export class ManagedKeyCapacityError extends Error {
  readonly code = MANAGED_KEY_CAPACITY;

  constructor() {
    super('CheapVibeCode key-count limit reached');
    this.name = 'ManagedKeyCapacityError';
  }
}

export const isManagedKeyCapacityError = (error: unknown): error is ManagedKeyCapacityError =>
  (error as { code?: unknown } | null)?.code === MANAGED_KEY_CAPACITY;

/** CVC prices in its own tokens; the ledger is micro-USD. One rate bridges them. */
const tokensPerUsd = () => aicoEnv.AICO_CVC_TOKENS_PER_USD;

/** Never grant more capacity than was paid for: floor, like `removeMultiplierMicroUsd`. */
export const usdToCvcTokens = (usd: number): number => {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.floor(usd * tokensPerUsd());
};

export const cvcTokensToUsd = (tokens: number): number => {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return tokens / tokensPerUsd();
};

/**
 * `/v1/balance` is Cloudflare-fronted and rate limited — three calls in immediate
 * succession measured 200, 429, 429, with no `Retry-After` or `X-RateLimit-*`
 * header to read. It recovers within seconds.
 *
 * A 429 must never be allowed to look like a zero balance: that would read as
 * "this member has spent everything" and cut them off. Retry, then throw.
 */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = [400, 1200, 3000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Comma-separated per their Primary/Fallback domain guidance, tried in order. */
const resolveBaseUrls = (): string[] => {
  const configured = aicoEnv.CHEAPVIBECODE_BASE_URL.split(',')
    .map((url) => url.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return configured.length > 0 ? configured : ['https://cheapvibecode.ru'];
};

const readBalanceTokens = (json: unknown): number => {
  const root = (json ?? {}) as Record<string, unknown>;
  const data = (root.data as Record<string, unknown> | undefined) ?? root;
  // Their responses have used `token_balance`; accept the obvious synonyms rather
  // than reporting a zero balance because a field was renamed.
  const raw = data.token_balance ?? data.balance ?? data.tokens ?? data.tokens_remaining;
  const tokens = Number(raw);
  if (!Number.isFinite(tokens)) {
    throw new Error('CheapVibeCode balance response missing a numeric balance');
  }
  return tokens;
};

const CVC_CAPABILITIES = {
  nativePeriodicLimits: false,
  readKeyBySecret: true,
  revoke: false,
  updateLimit: false,
} as const;

/**
 * One request, tried across every configured domain, retrying 429 with backoff.
 * `apiKey` is per call because per-key state is read by authenticating *as* that
 * key — the primary credential is used only for create and the account float.
 */
const cvcRequest = async <T>(
  path: string,
  init: RequestInit & { method: string },
  apiKey: string,
): Promise<T> => {
  const baseUrls = resolveBaseUrls();
  let lastError: Error | null = null;

  for (const baseUrl of baseUrls) {
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}${path}`, {
          ...init,
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...init.headers,
          },
        });
      } catch (error) {
        // Network-level failure: try the fallback domain rather than retrying.
        lastError = error as Error;
        break;
      }

      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await sleep(RATE_LIMIT_BACKOFF_MS[attempt] ?? 3000);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // DATA-013: never embed an upstream body in Error.message.
        console.warn('[cheapvibecode] API error', {
          bodyPreview: body.slice(0, 200),
          path,
          status: res.status,
        });
        if (res.status === 409 && body.includes(CVC_KEY_LIMIT_CODE)) {
          throw new ManagedKeyCapacityError();
        }
        lastError = new Error(`CheapVibeCode API ${res.status}: ${res.statusText}`);
        // 5xx and 429-after-retries are worth the fallback domain; a 4xx is our
        // own request being wrong and will fail identically there.
        if (res.status < 500 && res.status !== 429) throw lastError;
        break;
      }

      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
  }

  throw lastError ?? new Error('CheapVibeCode API unreachable');
};

/**
 * Reads the balance of one key by authenticating as it. Needs no management
 * credential, which is why the product server can call it directly instead of
 * proxying through the control plane.
 */
export const fetchKeyBalanceUsd = async (apiKey: string): Promise<number> =>
  cvcTokensToUsd(
    readBalanceTokens(await cvcRequest<unknown>('/v1/balance', { method: 'GET' }, apiKey)),
  );

/** Shared by both clients: per-key state comes from the member's own credential. */
const getKeyByCredential: ManagedProviderClient['getKey'] = async (credential) => {
  if (!credential.apiKey) {
    throw new Error(
      'CheapVibeCode reads per-key balance by authenticating as the key — apiKey is required',
    );
  }

  const remainingUsd = await fetchKeyBalanceUsd(credential.apiKey);
  const limitUsd = credential.limitUsd;

  return {
    // No upstream disable exists, so a key is never reported disabled here.
    // Retirement is enforced by us refusing to hand the key to a runtime.
    disabled: false,
    hash: credential.hash,
    limit: limitUsd ?? null,
    limitRemaining: remainingUsd,
    name: null,
    // Spend is what the mint-time limit no longer covers. Without the limit we
    // report 0 rather than guess — see `ManagedKeyCredential.limitUsd`.
    usage: limitUsd == null ? 0 : Math.max(0, limitUsd - remainingUsd),
    usageDaily: null,
    usageMonthly: null,
    usageWeekly: null,
  } satisfies ManagedKeyInfo;
};

/** Maps a `POST /v1/keys` response onto the neutral shape. */
const parseCreateKeyResponse = (
  json: { key?: string; meta?: Record<string, unknown> },
  requestedName: string,
): CreateManagedKeyResult => {
  const meta = json.meta ?? {};
  const key = String(json.key ?? '');
  // A key with no secret is unusable AND unrevokable — fail before persisting
  // anything that would point at it.
  if (!key) throw new Error('CheapVibeCode createKey response missing key');

  const mintedLimit = meta.token_limit == null ? null : Number(meta.token_limit);
  const usedTokens = Number(meta.tokens_used ?? 0);

  return {
    disabled: meta.is_active === false,
    hash: String(meta.id ?? ''),
    key,
    limit: mintedLimit == null ? null : cvcTokensToUsd(mintedLimit),
    limitRemaining:
      mintedLimit == null ? null : cvcTokensToUsd(Math.max(0, mintedLimit - usedTokens)),
    name: meta.name == null ? requestedName : String(meta.name),
    usage: cvcTokensToUsd(usedTokens),
    // No native period reset, so there is no per-period figure to report. Null is
    // the signal for the caller to use its own checkpoint arithmetic.
    usageDaily: null,
    usageMonthly: null,
    usageWeekly: null,
  };
};

/**
 * `/v1/models` is the one management-surface route that needs no key-specific
 * state, but it still needs *a* key, and the only one the control plane holds is
 * the primary. Mapping happens through `mapCheapVibeCodeModelCard` — the same
 * function the chat runtime's model fetcher uses — so the synced catalog and a
 * live fetch can never disagree about how a coefficient becomes a price.
 *
 * Note the list is the provider's whole inventory: CVC does not filter
 * `/v1/models` by a key's `allowed_models`.
 */
const fetchCatalog = async (apiKey: string): Promise<ChatModelCard[]> => {
  const json = await cvcRequest<{ data?: unknown[]; models?: unknown[] }>(
    '/v1/models',
    { method: 'GET' },
    apiKey,
  );
  const list = json?.data ?? json?.models;
  if (!Array.isArray(list)) throw new Error('CheapVibeCode model list response has no model array');
  return list
    .filter((model): model is { id: string } => typeof (model as { id?: unknown })?.id === 'string')
    .map((model) => mapCheapVibeCodeModelCard(model as never)) as ChatModelCard[];
};

/**
 * Control-plane client: holds the primary key, which is BOTH the management and
 * a fully funded inference credential. Must never be constructed on the product
 * server — see `createManagedProviderClient`.
 */
export class HttpCheapVibeCodeClient implements ManagedProviderClient {
  readonly capabilities = CVC_CAPABILITIES;

  readonly providerId = 'cheapvibecode' as const;

  constructor(private readonly primaryApiKey: string) {}

  createKey: ManagedProviderClient['createKey'] = async (params) =>
    this.createKeyWithTokenLimit({
      allowedModels: params.allowedModels,
      name: params.name,
      tokenLimit: usdToCvcTokens(params.limitUsd),
    });

  /**
   * Mint a key from an exact CVC token limit rather than a USD figure.
   *
   * The control-plane proxy uses this so the token count the product server
   * computed reaches CVC unchanged. Going back through USD would floor twice
   * and, worse, would make the minted limit depend on both processes agreeing on
   * `AICO_CVC_TOKENS_PER_USD` — a silent re-denomination if they ever drift.
   */
  createKeyWithTokenLimit = async (params: {
    allowedModels?: string[];
    name: string;
    tokenLimit: number;
  }): Promise<CreateManagedKeyResult> => {
    const json = await cvcRequest<{ key?: string; meta?: Record<string, unknown> }>(
      '/v1/keys',
      {
        body: JSON.stringify({
          name: params.name,
          token_limit: params.tokenLimit,
          ...(params.allowedModels?.length ? { allowed_models: params.allowedModels } : {}),
        }),
        method: 'POST',
      },
      this.primaryApiKey,
    );
    return parseCreateKeyResponse(json, params.name);
  };

  getKey = getKeyByCredential;

  listModels: NonNullable<ManagedProviderClient['listModels']> = async () =>
    fetchCatalog(this.primaryApiKey);

  getAccountBalanceUsd: ManagedProviderClient['getAccountBalanceUsd'] = async () =>
    fetchKeyBalanceUsd(this.primaryApiKey);
}

/**
 * Product-server client. Mints keys and reads the account float through the Aico
 * control plane so `CHEAPVIBECODE_MANAGEMENT_API_KEY` never lives on the customer
 * app process — the same containment `OPENROUTER_MANAGEMENT_API_KEY` has, and it
 * matters more here because the CVC primary key can spend the float directly.
 *
 * `getKey` deliberately does NOT go through the proxy: a key's balance is read by
 * authenticating as that key, which the product server already holds in order to
 * make inference calls at all. Proxying it would add a hop and widen the control
 * plane's surface for no security gain.
 */
export class RemoteCheapVibeCodeClient implements ManagedProviderClient {
  readonly capabilities = CVC_CAPABILITIES;

  readonly providerId = 'cheapvibecode' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
  ) {}

  private async request<T>(path: string, init: RequestInit & { method: string }): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/internal/cheapvibecode${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.serviceToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // DATA-013: never embed an upstream body in Error.message.
      console.warn('[cheapvibecode] control-plane proxy error', {
        bodyPreview: body.slice(0, 200),
        path,
        status: res.status,
      });
      if (res.status === 409 && body.includes(MANAGED_KEY_CAPACITY)) {
        throw new ManagedKeyCapacityError();
      }
      throw new Error(`Control plane CheapVibeCode proxy ${res.status}: ${res.statusText}`);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  createKey: ManagedProviderClient['createKey'] = async (params) => {
    const json = await this.request<{ key?: string; meta?: Record<string, unknown> }>('/v1/keys', {
      body: JSON.stringify({
        allowed_models: params.allowedModels,
        name: params.name,
        token_limit: usdToCvcTokens(params.limitUsd),
      }),
      method: 'POST',
    });
    return parseCreateKeyResponse(json, params.name);
  };

  getKey = getKeyByCredential;

  /**
   * Proxied rather than fetched directly: `/v1/models` needs a CVC credential and
   * the product server holds only per-member keys, which are minted with an
   * `allowed_models` scope and so must not be the source of a platform catalog.
   */
  listModels: NonNullable<ManagedProviderClient['listModels']> = async () =>
    this.request<ChatModelCard[]>('/v1/models', { method: 'GET' });

  getAccountBalanceUsd: ManagedProviderClient['getAccountBalanceUsd'] = async () => {
    const json = await this.request<{ balanceUsd?: number }>('/v1/balance', { method: 'GET' });
    const usd = Number(json.balanceUsd);
    if (!Number.isFinite(usd)) throw new Error('Control plane returned no CheapVibeCode balance');
    return usd;
  };
}

/**
 * In-memory mock for local QA. Models CVC's limitations faithfully — no revoke,
 * no update, balance falls only when `__spend` is called — so a code path that
 * would break against the real API breaks here too.
 */
export class MockCheapVibeCodeClient implements ManagedProviderClient {
  readonly capabilities = CVC_CAPABILITIES;

  readonly providerId = 'cheapvibecode' as const;

  private keys = new Map<string, { limitTokens: number; usedTokens: number }>();

  private accountTokens = 25_000_000;

  createKey: ManagedProviderClient['createKey'] = async (params) => {
    const id = crypto.randomUUID();
    const limitTokens = usdToCvcTokens(params.limitUsd);
    const key = `sk-cvc-mock-${id.replaceAll('-', '').slice(0, 20)}`;
    this.keys.set(key, { limitTokens, usedTokens: 0 });
    return {
      disabled: false,
      hash: id,
      key,
      limit: cvcTokensToUsd(limitTokens),
      limitRemaining: cvcTokensToUsd(limitTokens),
      name: params.name,
      usage: 0,
      usageDaily: null,
      usageMonthly: null,
      usageWeekly: null,
    };
  };

  getKey: ManagedProviderClient['getKey'] = async (credential) => {
    if (!credential.apiKey) throw new Error('CheapVibeCode mock requires apiKey');
    const row = this.keys.get(credential.apiKey);
    if (!row) throw new Error(`CheapVibeCode mock key not found: ${credential.hash}`);
    const remainingUsd = cvcTokensToUsd(Math.max(0, row.limitTokens - row.usedTokens));
    const limitUsd = credential.limitUsd ?? cvcTokensToUsd(row.limitTokens);
    return {
      disabled: false,
      hash: credential.hash,
      limit: limitUsd,
      limitRemaining: remainingUsd,
      name: null,
      usage: Math.max(0, limitUsd - remainingUsd),
      usageDaily: null,
      usageMonthly: null,
      usageWeekly: null,
    };
  };

  getAccountBalanceUsd: ManagedProviderClient['getAccountBalanceUsd'] = async () =>
    cvcTokensToUsd(this.accountTokens);

  /** Test seam: simulate upstream spend against a key. */
  __spend = (apiKey: string, tokens: number) => {
    const row = this.keys.get(apiKey);
    if (!row) throw new Error(`CheapVibeCode mock key not found: ${apiKey}`);
    row.usedTokens += tokens;
    this.accountTokens = Math.max(0, this.accountTokens - tokens);
  };
}
