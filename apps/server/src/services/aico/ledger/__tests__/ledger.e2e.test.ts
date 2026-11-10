// @vitest-environment node
/**
 * End-to-end check of the usage ledger (plan §5), on a real Postgres.
 *
 * Runs the real stack: `initModelRuntimeFromDB`, the traffic gate, the managed
 * policy, pricing, billing hooks, the ledger model and the cutover snapshot. The
 * only fake is CheapVibeCode itself, served over HTTP on localhost, so the test
 * spends no money and cannot mint a key.
 *
 * Run: TEST_SERVER_DB=1 DATABASE_TEST_URL=postgres://… bunx vitest run <this file>
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupAicoTables,
  isServerDb,
  seedUsers,
} from '@/database/models/__tests__/aico.phase2.helpers';
import {
  aicoLedgerState,
  usageHolds,
  usageLogs,
  userWallets,
} from '@/database/schemas/aicoOrganization';

const fake = vi.hoisted(() => {
  process.env.AICO_MANAGED_PROVIDER = 'cheapvibecode';
  process.env.KEY_VAULTS_SECRET = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
  process.env.CHEAPVIBECODE_API_KEY = '';
  process.env.AICO_CONTROL_PLANE_SERVICE_TOKEN = 'e2e-service-token';
  return {
    baseUrl: '',
    requests: [] as Array<{ auth: string; body: any; method: string; path: string }>,
  };
});

vi.mock('@/database/models/aiProvider', () => ({
  AiProviderModel: class {
    getAiProviderById = async () => ({
      keyVaults: { baseURL: `${fake.baseUrl}/v1` },
      settings: {},
    });
  },
}));

vi.mock('@/business/server/model-runtime', () => ({
  getBusinessModelRuntimeHooks: () => undefined,
}));

vi.mock('@/server/services/llmGenerationTracing/hook', () => ({
  createLLMGenerationTracingHook: () => undefined,
}));

vi.mock('@/server/services/aico/securityAlert', () => ({
  sendSecurityAlert: vi.fn(async () => null),
}));

const SUBJECT_KEY = 'sk-e2e-subject';
const SHARED_KEY = 'sk-e2e-shared';
const TOKENS_PER_USD = 25_000_000;
/** What the fake gateway reports for each key, in USD. */
const KEY_BALANCE_USD: Record<string, number> = { [SHARED_KEY]: 1000, [SUBJECT_KEY]: 0.75 };
const PROMPT_TOKENS = 1000;
const COMPLETION_TOKENS = 2000;
/** glm-5.3-flash: coefficient 0.3 × 0.04 USD per 1M tokens = 0.012 µUSD per token. */
const glmCost = (tokens: number) => Math.ceil((tokens * 12_000) / 1_000_000);
const STREAM_DELAY_MS = 300;

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
};

const chunk = (payload: Record<string, unknown>) =>
  `data: ${JSON.stringify({ created: 1, id: 'chatcmpl-e2e', model: 'glm-5.3-flash', object: 'chat.completion.chunk', ...payload })}\n\n`;

let server: Server;

const startFakeCvc = () =>
  new Promise<void>((resolve) => {
    server = createServer(async (req, res) => {
      const body = await readBody(req);
      const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const path = (req.url ?? '').split('?')[0];
      fake.requests.push({ auth, body, method: req.method ?? '', path });

      if (path === '/v1/balance') {
        const usd = KEY_BALANCE_USD[auth];
        if (usd === undefined) {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token_balance: Math.round(usd * TOKENS_PER_USD) }));
        return;
      }

      if (path === '/v1/chat/completions') {
        const completion = Math.min(COMPLETION_TOKENS, Number(body?.max_tokens ?? Infinity));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          chunk({
            choices: [
              { delta: { content: 'hi', role: 'assistant' }, finish_reason: null, index: 0 },
            ],
          }),
        );
        await new Promise((r) => setTimeout(r, STREAM_DELAY_MS));
        res.write(chunk({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }));
        res.write(
          chunk({
            choices: [],
            usage: {
              completion_tokens: completion,
              prompt_tokens: PROMPT_TOKENS,
              total_tokens: PROMPT_TOKENS + completion,
            },
          }),
        );
        res.end('data: [DONE]\n\n');
        return;
      }

      // Key creation (direct or through the control plane) and anything else.
      res.writeHead(500).end();
    });
    server.listen(0, '127.0.0.1', () => {
      fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      process.env.CHEAPVIBECODE_BASE_URL = fake.baseUrl;
      process.env.AICO_CONTROL_PLANE_URL = fake.baseUrl;
      resolve();
    });
  });

type Stack = Awaited<ReturnType<typeof loadStack>>;

/** Env is read at import, so each mode gets a fresh module graph. */
const loadStack = async (env: {
  AICO_BILLING_LEDGER_MODE: 'enforce' | 'off' | 'shadow';
  AICO_MANAGED_INFERENCE_KEY: 'per_subject' | 'shared';
}) => {
  process.env.AICO_BILLING_LEDGER_MODE = env.AICO_BILLING_LEDGER_MODE;
  process.env.AICO_MANAGED_INFERENCE_KEY = env.AICO_MANAGED_INFERENCE_KEY;
  if (env.AICO_MANAGED_INFERENCE_KEY === 'shared') {
    process.env.AICO_SHARED_INFERENCE_API_KEY = SHARED_KEY;
  } else {
    delete process.env.AICO_SHARED_INFERENCE_API_KEY;
  }
  vi.resetModules();

  const [runtime, state, snapshot, keyService] = await Promise.all([
    import('@/server/modules/ModelRuntime'),
    import('@/server/services/aico/ledger/state'),
    import('@/server/services/aico/ledger/snapshot'),
    import('@/server/services/openrouter/keyService'),
  ]);
  return { keyService, runtime, snapshot, state };
};

const userId = 'ledger-e2e-user';
let db: LobeChatDatabase;

const setState = async (stack: Stack, values: Partial<typeof aicoLedgerState.$inferInsert>) => {
  await db
    .update(aicoLedgerState)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(aicoLedgerState.id, 'default'));
  stack.state.invalidateLedgerStateCache();
};

const seedWallet = async (
  stack: Stack,
  values: Partial<typeof userWallets.$inferInsert> & { withKey: boolean },
) => {
  const { withKey, ...rest } = values;
  const keyFields = withKey
    ? {
        managedKeyLimitMicroUsd: 1_000_000,
        managedKeyProviderId: 'cheapvibecode',
        openrouterKeyCiphertext: await (
          new stack.keyService.AicoOpenRouterKeyService(db, null) as unknown as {
            encryptKey: (plain: string) => Promise<string>;
          }
        ).encryptKey(SUBJECT_KEY),
        openrouterKeyId: 'cvc_e2e_key',
      }
    : {};
  await db.insert(userWallets).values({
    balanceMicroUsd: 1_250_000,
    rawCapacityMicroUsd: 1_000_000,
    userId,
    ...keyFields,
    ...rest,
  });
};

const chat = async (stack: Stack, maxTokens?: number) => {
  const runtime = await stack.runtime.initModelRuntimeFromDB(db, userId, 'aico', undefined, {
    billingContext: { source: 'personal' },
    modelId: 'glm-5.3-flash',
  });
  const response = await runtime.chat({
    messages: [{ content: 'Say hi', role: 'user' }],
    model: 'glm-5.3-flash',
    stream: true,
    temperature: 0,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  });
  await response.text();
};

const errorCode = (error: unknown) => {
  const e = error as { code?: string; error?: { code?: string }; message?: string };
  return String(e?.code ?? e?.error?.code ?? e?.message ?? error);
};

/** Settling runs after the stream closes; wait for it rather than sleeping. */
const waitForNoOpenHolds = async () => {
  for (let i = 0; i < 50; i += 1) {
    const open = await db.select().from(usageHolds).where(eq(usageHolds.status, 'open'));
    if (open.length === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('holds still open');
};

const getWallet = async () =>
  (await db.select().from(userWallets).where(eq(userWallets.userId, userId)))[0];

const chatRequests = () => fake.requests.filter((r) => r.path === '/v1/chat/completions');
const keyCreations = () => fake.requests.filter((r) => r.path.endsWith('/v1/keys'));

describe.skipIf(!isServerDb())('usage ledger end to end', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await startFakeCvc();
    db = await getTestDB();
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
  });

  beforeEach(async () => {
    fake.requests = [];
    await cleanupAicoTables(db);
    await seedUsers(db, [{ email: 'ledger-e2e@example.com', id: userId }]);
  });

  it('shadow: records a hold settled from real usage and leaves the response alone', async () => {
    const stack = await loadStack({
      AICO_BILLING_LEDGER_MODE: 'shadow',
      AICO_MANAGED_INFERENCE_KEY: 'per_subject',
    });
    await seedWallet(stack, { withKey: true });

    await chat(stack);
    await waitForNoOpenHolds();

    const holds = await db.select().from(usageHolds);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      chargedRawMicroUsd: glmCost(PROMPT_TOKENS + COMPLETION_TOKENS),
      mode: 'shadow',
      settleReason: 'usage',
      status: 'settled',
      wouldRefuse: false,
    });
    expect(Number(holds[0].holdRawMicroUsd)).toBeGreaterThanOrEqual(
      Number(holds[0].chargedRawMicroUsd),
    );

    // Shadow never touches the wallet; the subject's own key served the call.
    const wallet = await getWallet();
    expect(Number(wallet.rawUsedMicroUsd)).toBe(0);
    expect(Number(wallet.rawHeldMicroUsd)).toBe(0);
    expect(chatRequests()).toHaveLength(1);
    expect(chatRequests()[0].auth).toBe(SUBJECT_KEY);
    expect(chatRequests()[0].body.max_tokens).toBe(32_000);
    expect(keyCreations()).toHaveLength(0);
  });

  it('enforce per_subject: refuses before the snapshot, then meters after cutover', async () => {
    const stack = await loadStack({
      AICO_BILLING_LEDGER_MODE: 'enforce',
      AICO_MANAGED_INFERENCE_KEY: 'per_subject',
    });
    await seedWallet(stack, { withKey: true });

    await expect(chat(stack)).rejects.toSatisfy((e) =>
      errorCode(e).includes('PLATFORM_CAPACITY_EXHAUSTED'),
    );
    expect(chatRequests()).toHaveLength(0);

    // Snapshot refuses to run while traffic is live.
    await expect(
      stack.snapshot.runLedgerSnapshotPhase(db, { phase: 'wallets' }),
    ).resolves.toMatchObject({ body: { reason: 'not_paused' }, status: 409 });

    await setState(stack, { paused: true });
    await expect(chat(stack)).rejects.toSatisfy((e) => errorCode(e).includes(':paused'));

    await expect(
      stack.snapshot.runLedgerSnapshotPhase(db, { phase: 'wallets' }),
    ).resolves.toMatchObject({
      body: { degradedUserIds: [], done: true, processed: 1 },
      status: 200,
    });
    await expect(
      stack.snapshot.runLedgerSnapshotPhase(db, { phase: 'budgets' }),
    ).resolves.toMatchObject({ body: { done: true }, status: 200 });
    await expect(
      stack.snapshot.runLedgerSnapshotPhase(db, { phase: 'finalize' }),
    ).resolves.toMatchObject({
      body: { degradedWallets: 0, overdrawnWallets: 0, totalRawAvailable: 750_000 },
      status: 200,
    });

    // $1 key limit − $0.75 remaining upstream = $0.25 already spent on the key.
    expect(Number((await getWallet()).rawUsedMicroUsd)).toBe(250_000);

    await setState(stack, { paused: false });
    await chat(stack);
    await waitForNoOpenHolds();

    const [hold] = await db.select().from(usageHolds);
    const charged = glmCost(PROMPT_TOKENS + COMPLETION_TOKENS);
    expect(hold).toMatchObject({
      chargedRawMicroUsd: charged,
      mode: 'enforce',
      settleReason: 'usage',
      status: 'settled',
    });
    const wallet = await getWallet();
    expect(Number(wallet.rawUsedMicroUsd)).toBe(250_000 + charged);
    expect(Number(wallet.rawHeldMicroUsd)).toBe(0);
    expect(wallet.openHolds).toBe(0);

    const logs = await db.select().from(usageLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ holdId: hold.id, settlementStatus: 'synchronized' });

    expect(chatRequests().map((r) => r.auth)).toEqual([SUBJECT_KEY]);
    expect(keyCreations()).toHaveLength(0);
  });

  it('enforce shared: a keyless wallet chats on the shared key and no key is created', async () => {
    const stack = await loadStack({
      AICO_BILLING_LEDGER_MODE: 'enforce',
      AICO_MANAGED_INFERENCE_KEY: 'shared',
    });
    await seedWallet(stack, { withKey: false });
    await setState(stack, { enforceStartedAt: new Date(), snapshotCompletedAt: new Date() });

    await chat(stack);
    await waitForNoOpenHolds();

    const wallet = await getWallet();
    expect(wallet.openrouterKeyId).toBeNull();
    expect(Number(wallet.rawUsedMicroUsd)).toBe(glmCost(PROMPT_TOKENS + COMPLETION_TOKENS));
    expect(chatRequests().map((r) => r.auth)).toEqual([SHARED_KEY]);

    // The float guard read the shared account balance.
    const [state] = await db.select().from(aicoLedgerState);
    expect(Number(state.floatRawMicroUsd)).toBe(1000 * 1_000_000);
    expect(keyCreations()).toHaveLength(0);
  });

  it('concurrency: parallel requests against a tiny wallet never commit more than it holds', async () => {
    const stack = await loadStack({
      AICO_BILLING_LEDGER_MODE: 'enforce',
      AICO_MANAGED_INFERENCE_KEY: 'shared',
    });
    const capacity = 1000;
    await seedWallet(stack, { rawCapacityMicroUsd: capacity, withKey: false });
    await setState(stack, { enforceStartedAt: new Date(), snapshotCompletedAt: new Date() });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => chat(stack, 100_000)),
    );
    await waitForNoOpenHolds();

    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    for (const r of refused) {
      expect(errorCode(r.reason)).toMatch(/PERSONAL_FUNDS_UNAVAILABLE|USAGE_CONCURRENCY_LIMIT/);
    }

    // Only admitted requests reached the gateway, each with an output cap that fit.
    expect(chatRequests()).toHaveLength(ok.length);
    const holds = await db.select().from(usageHolds);
    expect(holds).toHaveLength(ok.length);
    for (const h of holds) {
      expect(Number(h.chargedRawMicroUsd)).toBeLessThanOrEqual(Number(h.holdRawMicroUsd));
    }

    const wallet = await getWallet();
    expect(Number(wallet.rawUsedMicroUsd)).toBeLessThanOrEqual(capacity);
    expect(Number(wallet.rawUsedMicroUsd)).toBe(
      holds.reduce((sum, h) => sum + Number(h.chargedRawMicroUsd), 0),
    );
    expect(Number(wallet.rawHeldMicroUsd)).toBe(0);
    expect(wallet.openHolds).toBe(0);
    expect(keyCreations()).toHaveLength(0);
  });
});
