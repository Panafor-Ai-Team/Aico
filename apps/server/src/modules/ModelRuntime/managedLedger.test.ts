// @vitest-environment node
import type { ModelRuntimeHooks } from '@lobechat/model-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';
import type * as ManagedPolicyModule from '@/server/services/aico/managedPolicy';

import { initModelRuntimeFromDB } from './index';

const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  billingHooks: undefined as ModelRuntimeHooks | undefined,
  createManagedBillingHooks: vi.fn(),
  gate: vi.fn(),
  order: [] as string[],
  tracingHooks: undefined as ModelRuntimeHooks | undefined,
}));

vi.mock('@/database/models/aiProvider', () => ({
  AiProviderModel: class {
    getAiProviderById = async () => ({ keyVaults: {}, settings: {} });
  },
}));

vi.mock('@/business/server/model-runtime', () => ({
  getBusinessModelRuntimeHooks: () => undefined,
}));

vi.mock('@/server/services/llmGenerationTracing/hook', () => ({
  createLLMGenerationTracingHook: () => h.tracingHooks,
}));

vi.mock('@/server/services/openrouter/keyService', () => ({
  AicoOpenRouterKeyService: class {
    decryptKey = async () => 'decrypted';
  },
}));

vi.mock('@/server/services/aico/ledger/gate', () => ({
  assertManagedTrafficAllowed: h.gate,
}));

vi.mock('@/server/services/aico/ledger/managedBillingHooks', () => ({
  createManagedBillingHooks: h.createManagedBillingHooks,
}));

vi.mock('@/server/services/aico/managedPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof ManagedPolicyModule>();
  class AicoManagedPolicy extends actual.AicoManagedPolicy {
    authorize = h.authorize as never;
  }
  return { ...actual, AicoManagedPolicy };
});

const db = {} as LobeChatDatabase;
const managedOptions = { billingContext: { source: 'personal' }, modelId: 'glm-5.3-flash' };

beforeEach(() => {
  vi.clearAllMocks();
  h.order = [];
  h.gate.mockResolvedValue({ authoritative: true, mode: 'enforce', sharedKey: null });
  h.authorize.mockResolvedValue({
    apiKey: 'sk-subject',
    billing: { source: 'personal' },
    userId: 'u1',
  });
  h.billingHooks = {
    beforeChat: vi.fn(async () => {
      h.order.push('billing');
    }),
  };
  h.tracingHooks = {
    beforeChat: vi.fn(async () => {
      h.order.push('tracing');
    }),
  };
  h.createManagedBillingHooks.mockImplementation(() => h.billingHooks);
});

describe('initModelRuntimeFromDB usage ledger wiring', () => {
  it('propagates a ledger gate refusal before authorizing', async () => {
    h.gate.mockRejectedValue(new Error('PLATFORM_CAPACITY_EXHAUSTED:paused'));

    await expect(
      initModelRuntimeFromDB(db, 'u1', 'aico', undefined, managedOptions),
    ).rejects.toThrow('PLATFORM_CAPACITY_EXHAUSTED:paused');
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.createManagedBillingHooks).not.toHaveBeenCalled();
  });

  it('builds billing hooks from the authorization and runs them before tracing', async () => {
    const runtime = await initModelRuntimeFromDB(db, 'u1', 'aico', undefined, managedOptions);

    expect(h.createManagedBillingHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        authorized: expect.objectContaining({ userId: 'u1' }),
        gate: { authoritative: true, mode: 'enforce', sharedKey: null },
      }),
    );

    const hooks = (runtime as unknown as { _hooks: ModelRuntimeHooks })._hooks;
    await hooks.beforeChat!({ messages: [], model: 'glm-5.3-flash', temperature: 0 });
    expect(h.order).toEqual(['billing', 'tracing']);
  });

  it('does not touch the ledger for a non-managed provider', async () => {
    // No OpenAI key is configured here; only the ledger calls matter.
    await initModelRuntimeFromDB(db, 'u1', 'openai').catch(() => null);

    expect(h.gate).not.toHaveBeenCalled();
    expect(h.createManagedBillingHooks).not.toHaveBeenCalled();
  });
});
