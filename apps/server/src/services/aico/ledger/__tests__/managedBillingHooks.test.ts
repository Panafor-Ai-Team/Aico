import type { ChatStreamPayload, ModelRuntimeHooks } from '@lobechat/model-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import type { ManagedExecutionContext } from '../../managedPolicy';
import type { LedgerConfig } from '../config';
import { MIN_OUTPUT_TOKENS } from '../estimate';
import type { LedgerGate } from '../gate';
import {
  ABORT_SETTLE_DELAY_MS,
  createManagedBillingHooks,
  isUpstreamRejection,
  type ManagedBillingDeps,
} from '../managedBillingHooks';
import type { ManagedModelRates } from '../pricing';

const cfg = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock('../config', () => ({
  getLedgerConfig: () => cfg,
  isSharedInferenceKey: () => cfg.inferenceKey === 'shared',
}));

vi.mock('../floatGuard', () => ({ assertPlatformCapacity: vi.fn() }));

const baseConfig = (): LedgerConfig => ({
  cappedOutputModels: new Set(['glm-5.3-flash']),
  defaultMaxOutputTokens: 32_000,
  floatFloorRawMicroUsd: 1_000_000,
  floatMaxAgeMs: 600_000,
  holdTtlSeconds: 900,
  inferenceKey: 'per_subject',
  legacyPrimaryKeyExposed: false,
  managedProviderId: 'cheapvibecode',
  maxOpenHolds: 6,
  mode: 'enforce',
  sharedApiKey: null,
});

const db = {} as LobeChatDatabase;

const rates = (extra: Partial<ManagedModelRates> = {}): ManagedModelRates => ({
  contextWindowTokens: 200_000,
  inputPusdPerToken: 12_000n,
  maxOutputTokens: null,
  modelBp: 10_000,
  outputPusdPerToken: 12_000n,
  pricedModelId: 'glm-5.3-flash',
  reasoningBilledTwice: false,
  ...extra,
});

const personal: ManagedExecutionContext = {
  apiKey: 'k',
  billing: { source: 'personal' } as ManagedExecutionContext['billing'],
  modelId: 'glm-5.3-flash',
  userId: 'u1',
};

const org: ManagedExecutionContext = {
  apiKey: 'k',
  billing: { organizationId: 'o1', source: 'organization' } as ManagedExecutionContext['billing'],
  budgetId: 'b1',
  modelId: 'glm-5.3-flash',
  orgId: 'o1',
  orgMemberId: 'm1',
  userId: 'u1',
};

const enforceGate: LedgerGate = { authoritative: true, mode: 'enforce', sharedKey: null };
const shadowGate: LedgerGate = { authoritative: false, mode: 'shadow', sharedKey: null };

const makeDeps = () => {
  const deps = {
    assertPlatformCapacity: vi.fn(async () => {}),
    config: baseConfig(),
    ledger: {
      placeHold: vi.fn(async (_p: unknown) => ({ holdId: 'uhld_1', ok: true as const })),
      recordShadowHold: vi.fn(async (_p: unknown) => 'uhld_s'),
      settleHold: vi.fn(async (_id: string, _p: unknown) => ({ settled: true })),
      shadowAvailability: vi.fn(async (_p: unknown) => null),
    },
    platformBp: vi.fn(async () => 12_500),
    rates: {
      chat: vi.fn(async () => ({ modelId: 'glm-5.3-flash', rates: rates() })),
      model: vi.fn(async () => rates()),
    },
  };
  return deps;
};

let deps: ReturnType<typeof makeDeps>;

const build = (
  gate: LedgerGate = enforceGate,
  authorized: ManagedExecutionContext = personal,
): ModelRuntimeHooks =>
  createManagedBillingHooks({
    authorized,
    db,
    deps: deps as unknown as Partial<ManagedBillingDeps>,
    gate,
  })!;

const chatPayload = (extra: Partial<ChatStreamPayload> = {}): ChatStreamPayload => ({
  messages: [{ content: 'hello', role: 'user' }],
  model: 'glm-5.3-flash',
  temperature: 0,
  ...extra,
});

const codeOf = async (promise: Promise<unknown> | undefined) =>
  promise?.then(
    () => null,
    (e: { code?: string; message?: string }) => e.code ?? e.message,
  );

beforeEach(() => {
  Object.assign(cfg, baseConfig());
  deps = makeDeps();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createManagedBillingHooks', () => {
  it('returns undefined when the ledger is off', () => {
    expect(
      createManagedBillingHooks({
        authorized: personal,
        db,
        gate: { authoritative: false, mode: 'off', sharedKey: null },
      }),
    ).toBeUndefined();
  });

  describe('enforce chat', () => {
    it('places a hold for the estimate and injects the default output cap', async () => {
      const payload = chatPayload();
      await build().beforeChat!(payload);

      expect(payload.max_tokens).toBe(32_000);
      expect(deps.ledger.placeHold).toHaveBeenCalledTimes(1);
      expect(deps.ledger.placeHold.mock.calls[0][0]).toMatchObject({
        billingSource: 'personal',
        maxOutputTokens: 32_000,
        multiplierBp: 12_500,
        operation: 'chat',
        pricedModelId: 'glm-5.3-flash',
        subject: { type: 'wallet', userId: 'u1' },
      });
      expect(
        (deps.ledger.placeHold.mock.calls[0][0] as { holdRawMicroUsd: number }).holdRawMicroUsd,
      ).toBeGreaterThan(0);
    });

    it('uses the model maximum or the requested cap when lower', async () => {
      deps.rates.chat.mockResolvedValue({
        modelId: 'glm-5.3-flash',
        rates: rates({ maxOutputTokens: 8000 }),
      });
      const modelCapped = chatPayload();
      await build().beforeChat!(modelCapped);
      expect(modelCapped.max_tokens).toBe(8000);

      const requested = chatPayload({ max_tokens: 500 });
      await build().beforeChat!(requested);
      expect(requested.max_tokens).toBe(500);
    });

    it('refuses an unpriced model without placing a hold', async () => {
      deps.rates.chat.mockResolvedValue(null as never);
      expect(await codeOf(build().beforeChat!(chatPayload()))).toBe('MODEL_PRICING_UNAVAILABLE');
      expect(deps.ledger.placeHold).not.toHaveBeenCalled();
    });

    it('shrinks the output cap to fit a short balance', async () => {
      deps.ledger.placeHold
        .mockResolvedValueOnce({ ok: false, refusal: { available: 100, reason: 'funds' } } as never)
        .mockResolvedValueOnce({ holdId: 'uhld_2', ok: true });
      const payload = chatPayload();
      await build().beforeChat!(payload);

      expect(deps.ledger.placeHold).toHaveBeenCalledTimes(2);
      expect(payload.max_tokens).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
      expect(payload.max_tokens).toBeLessThan(32_000);
      const second = deps.ledger.placeHold.mock.calls[1][0] as { holdRawMicroUsd: number };
      expect(second.holdRawMicroUsd).toBeLessThanOrEqual(100);
    });

    it('maps a funds refusal that cannot shrink', async () => {
      deps.ledger.placeHold.mockResolvedValue({
        ok: false,
        refusal: { available: 0, reason: 'funds' },
      } as never);
      expect(await codeOf(build().beforeChat!(chatPayload()))).toBe('PERSONAL_FUNDS_UNAVAILABLE');
      expect(await codeOf(build(enforceGate, org).beforeChat!(chatPayload()))).toBe(
        'MEMBER_BUDGET_UNFUNDED',
      );
    });

    describe('a model that ignores max_tokens', () => {
      beforeEach(() => {
        deps.rates.chat.mockResolvedValue({
          modelId: 'deepseek-v4.1-flash',
          rates: rates({
            contextWindowTokens: 1_048_576,
            maxOutputTokens: 393_216,
            pricedModelId: 'deepseek-v4.1-flash',
          }),
        });
      });

      it('holds its own output ceiling but still sends the requested cap', async () => {
        const payload = chatPayload({ max_tokens: 64, model: 'deepseek-v4.1-flash' });
        await build().beforeChat!(payload);

        expect(payload.max_tokens).toBe(64);
        expect(deps.ledger.placeHold.mock.calls[0][0]).toMatchObject({
          maxOutputTokens: 393_216,
        });
      });

      it('is refused rather than shrunk when funds are short', async () => {
        deps.ledger.placeHold.mockResolvedValue({
          ok: false,
          refusal: { available: 100, reason: 'funds' },
        } as never);
        const payload = chatPayload({ model: 'deepseek-v4.1-flash' });

        expect(await codeOf(build().beforeChat!(payload))).toBe('PERSONAL_FUNDS_UNAVAILABLE');
        expect(deps.ledger.placeHold).toHaveBeenCalledTimes(1);
        expect(payload.max_tokens).toBe(32_000);
      });
    });

    it('maps concurrency and renewal refusals', async () => {
      deps.ledger.placeHold.mockResolvedValueOnce({
        ok: false,
        refusal: { reason: 'concurrency' },
      } as never);
      expect(await codeOf(build().beforeChat!(chatPayload()))).toBe('USAGE_CONCURRENCY_LIMIT');

      deps.ledger.placeHold.mockResolvedValueOnce({
        ok: false,
        refusal: { reason: 'renewal_blocked' },
      } as never);
      expect(await codeOf(build(enforceGate, org).beforeChat!(chatPayload()))).toBe(
        'MEMBER_BUDGET_RENEWAL_BLOCKED',
      );
      expect(deps.ledger.placeHold.mock.calls[1][0]).toMatchObject({
        billingSource: 'organization',
        subject: { budgetId: 'b1', orgId: 'o1', orgMemberId: 'm1', type: 'budget' },
      });
    });

    it('fails closed when the ledger throws', async () => {
      deps.ledger.placeHold.mockRejectedValue(new Error('db down'));
      expect(await codeOf(build().beforeChat!(chatPayload()))).toBe(
        'PLATFORM_CAPACITY_EXHAUSTED:ledger_error',
      );
    });

    it('checks platform capacity only with a shared key', async () => {
      await build().beforeChat!(chatPayload());
      expect(deps.assertPlatformCapacity).not.toHaveBeenCalled();

      await build({ ...enforceGate, sharedKey: 'sk-shared' }).beforeChat!(chatPayload());
      expect(deps.assertPlatformCapacity).toHaveBeenCalledTimes(1);
    });

    it('propagates a platform capacity refusal', async () => {
      const { AicoManagedPolicyError } = await import('../../managedPolicy');
      deps.assertPlatformCapacity.mockRejectedValue(
        new AicoManagedPolicyError('PLATFORM_CAPACITY_EXHAUSTED:float_floor'),
      );
      expect(
        await codeOf(build({ ...enforceGate, sharedKey: 'sk-shared' }).beforeChat!(chatPayload())),
      ).toBe('PLATFORM_CAPACITY_EXHAUSTED:float_floor');
      expect(deps.ledger.placeHold).not.toHaveBeenCalled();
    });
  });

  describe('settling chat', () => {
    it('settles the cost recomputed from tokens and ignores usage.cost', async () => {
      const hooks = build();
      const payload = chatPayload();
      await hooks.beforeChat!(payload);
      await hooks.onChatFinal!(
        {
          text: 'hi',
          usage: {
            cost: 999_999,
            totalInputTokens: 1000,
            totalOutputTokens: 500,
            totalTokens: 1500,
          },
        },
        { payload },
      );

      expect(deps.ledger.settleHold).toHaveBeenCalledWith('uhld_1', {
        chargedRawMicroUsd: 18,
        rawCostMicroUsd: 18,
        reason: 'usage',
        resolvedModelId: null,
        tokens: { completion: 500, prompt: 1000, reasoning: 0, total: 1500 },
      });
    });

    it('prices a resolved model at its own rates', async () => {
      deps.rates.model.mockResolvedValue(
        rates({
          inputPusdPerToken: 1_000_000n,
          outputPusdPerToken: 1_000_000n,
          pricedModelId: 'x',
        }),
      );
      const hooks = build();
      const payload = chatPayload();
      await hooks.beforeChat!(payload);
      await hooks.onChatFinal!(
        {
          resolvedModel: 'x',
          text: '',
          usage: { totalInputTokens: 10, totalOutputTokens: 10, totalTokens: 20 },
        },
        { payload },
      );

      expect(deps.rates.model).toHaveBeenCalledWith(db, 'x');
      expect(deps.ledger.settleHold.mock.calls[0][1]).toMatchObject({
        chargedRawMicroUsd: 20,
        resolvedModelId: 'x',
      });
    });

    it.each([
      ['no usage', { text: '' }, 'estimate_no_usage'],
      ['an error', { error: new Error('x'), text: '' }, 'estimate_error'],
      ['zero input tokens', { text: '', usage: { totalInputTokens: 0 } }, 'estimate_no_usage'],
    ])('charges the estimate on %s', async (_label, data, reason) => {
      const hooks = build();
      const payload = chatPayload();
      await hooks.beforeChat!(payload);
      await hooks.onChatFinal!(data as never, { payload });
      expect(deps.ledger.settleHold).toHaveBeenCalledWith('uhld_1', { reason });
    });

    it('releases an upstream rejection and charges other errors', async () => {
      const hooks = build();
      const rejected = chatPayload();
      await hooks.beforeChat!(rejected);
      await hooks.onChatError!({ status: 429 } as never, { payload: rejected });
      expect(deps.ledger.settleHold).toHaveBeenLastCalledWith('uhld_1', {
        reason: 'released_rejected',
      });

      const failed = chatPayload();
      await hooks.beforeChat!(failed);
      await hooks.onChatError!({ status: 500 } as never, { payload: failed });
      expect(deps.ledger.settleHold).toHaveBeenLastCalledWith('uhld_1', {
        reason: 'estimate_error',
      });
    });

    it('does nothing on an error without a hold', async () => {
      await build().onChatError!({ status: 500 } as never, { payload: chatPayload() });
      expect(deps.ledger.settleHold).not.toHaveBeenCalled();
    });

    it('settles once even when final and error both fire', async () => {
      const hooks = build();
      const payload = chatPayload();
      await hooks.beforeChat!(payload);
      await hooks.onChatFinal!({ text: '' }, { payload });
      await hooks.onChatError!({ status: 500 } as never, { payload });
      expect(deps.ledger.settleHold).toHaveBeenCalledTimes(1);
    });

    it('settles the previous hold when a payload is reused', async () => {
      const hooks = build();
      const payload = chatPayload();
      await hooks.beforeChat!(payload);
      await hooks.beforeChat!(payload);
      expect(deps.ledger.settleHold).toHaveBeenCalledWith('uhld_1', { reason: 'estimate_error' });
      expect(deps.ledger.placeHold).toHaveBeenCalledTimes(2);
    });

    it('does not throw when settling fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      deps.ledger.settleHold.mockRejectedValue(new Error('db down'));
      const hooks = build();
      const payload = chatPayload();
      await hooks.beforeChat!(payload);
      await expect(hooks.onChatFinal!({ text: '' }, { payload })).resolves.toBeUndefined();
    });
  });

  describe('aborts', () => {
    it('charges the estimate after the abort delay', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const hooks = build();
      await hooks.beforeChat!(chatPayload(), { signal: controller.signal });

      controller.abort();
      await vi.advanceTimersByTimeAsync(ABORT_SETTLE_DELAY_MS - 1);
      expect(deps.ledger.settleHold).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(deps.ledger.settleHold).toHaveBeenCalledWith('uhld_1', { reason: 'estimate_aborted' });
    });

    it('does not settle twice when the stream finalizes after an abort', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const hooks = build();
      const payload = chatPayload();
      await hooks.beforeChat!(payload, { signal: controller.signal });

      controller.abort();
      await hooks.onChatFinal!({ text: '' }, { payload });
      await vi.advanceTimersByTimeAsync(ABORT_SETTLE_DELAY_MS * 2);
      expect(deps.ledger.settleHold).toHaveBeenCalledTimes(1);
      expect(deps.ledger.settleHold).toHaveBeenCalledWith('uhld_1', {
        reason: 'estimate_no_usage',
      });
    });

    it('handles a signal that is already aborted', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      controller.abort();
      await build().beforeChat!(chatPayload(), { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(ABORT_SETTLE_DELAY_MS);
      expect(deps.ledger.settleHold).toHaveBeenCalledWith('uhld_1', { reason: 'estimate_aborted' });
    });
  });

  describe('shadow', () => {
    it('records a shadow hold and never places one', async () => {
      deps.ledger.shadowAvailability.mockResolvedValue({ available: 0, reason: 'funds' } as never);
      const hooks = build(shadowGate);
      const payload = chatPayload();
      await hooks.beforeChat!(payload);

      expect(deps.ledger.placeHold).not.toHaveBeenCalled();
      expect(deps.ledger.recordShadowHold.mock.calls[0][0]).toMatchObject({
        refuseReason: 'funds',
        wouldRefuse: true,
      });
      expect(payload.max_tokens).toBe(32_000);

      await hooks.onChatFinal!(
        { text: '', usage: { totalInputTokens: 10, totalOutputTokens: 10 } },
        { payload },
      );
      expect(deps.ledger.settleHold.mock.calls[0]).toMatchObject(['uhld_s', { reason: 'usage' }]);
    });

    it('never throws when the ledger fails', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      deps.ledger.recordShadowHold.mockRejectedValue(new Error('db down'));
      deps.ledger.shadowAvailability.mockRejectedValue(new Error('db down'));
      deps.rates.chat.mockRejectedValue(new Error('db down'));
      const hooks = build(shadowGate);
      const payload = chatPayload();

      await expect(hooks.beforeChat!(payload)).resolves.toBeUndefined();
      await expect(hooks.onChatFinal!({ text: '' }, { payload })).resolves.toBeUndefined();
      await expect(
        hooks.beforeCreateImage!({ model: 'img', params: {} } as never),
      ).resolves.toBeUndefined();
    });

    it('records an unpriced model as a pricing refusal', async () => {
      deps.rates.chat.mockResolvedValue(null as never);
      await build(shadowGate).beforeChat!(chatPayload());
      expect(deps.ledger.recordShadowHold.mock.calls[0][0]).toMatchObject({
        holdRawMicroUsd: 0,
        refuseReason: 'pricing',
        wouldRefuse: true,
      });
    });
  });

  describe('other operations', () => {
    it('settles generateObject once when the error and complete hooks both fire', async () => {
      const hooks = build();
      const payload = {
        messages: [{ content: 'x', role: 'user' as const }],
        model: 'glm-5.3-flash',
      };
      await hooks.beforeGenerateObject!(payload);
      expect(deps.ledger.placeHold.mock.calls[0][0]).toMatchObject({
        maxOutputTokens: 32_000,
        operation: 'object',
      });

      await hooks.onGenerateObjectError!({ status: 500 } as never, { payload });
      await hooks.onGenerateObjectComplete!({ latencyMs: 1, success: false }, { payload });
      expect(deps.ledger.settleHold).toHaveBeenCalledTimes(1);
      expect(deps.ledger.settleHold).toHaveBeenCalledWith('uhld_1', { reason: 'estimate_error' });
    });

    it('settles embeddings from usage', async () => {
      deps.rates.model.mockResolvedValue(rates({ outputPusdPerToken: null }));
      const hooks = build();
      const payload = { input: 'hello', model: 'embed-1' };
      await hooks.beforeEmbeddings!(payload);
      expect(deps.ledger.placeHold.mock.calls[0][0]).toMatchObject({
        maxOutputTokens: 0,
        operation: 'embeddings',
      });

      await hooks.onEmbeddingsComplete!(
        { latencyMs: 1, success: true, usage: { totalInputTokens: 1000 } },
        { payload },
      );
      expect(deps.ledger.settleHold.mock.calls[0][1]).toMatchObject({
        chargedRawMicroUsd: 12,
        reason: 'usage',
      });
    });

    it.each([
      ['beforeCreateImage', 'image'],
      ['beforeCreateVideo', 'video'],
      ['beforeTextToSpeech', 'tts'],
      ['beforeTranscribe', 'transcribe'],
    ] as const)('%s is refused under enforce and recorded in shadow', async (hook, operation) => {
      const payload = { model: 'm' } as never;
      expect(await codeOf((build()[hook] as (p: unknown) => Promise<void>)(payload))).toBe(
        'MANAGED_OPERATION_NOT_METERED',
      );

      await (build(shadowGate)[hook] as (p: unknown) => Promise<void>)(payload);
      expect(deps.ledger.recordShadowHold.mock.calls[0][0]).toMatchObject({
        operation,
        refuseReason: 'not_metered',
      });
      expect(deps.ledger.settleHold).toHaveBeenCalledWith('uhld_s', { reason: 'not_metered' });
    });
  });
});

describe('isUpstreamRejection', () => {
  it.each([
    [{ status: 429 }, true],
    [{ error: { status: 400 } }, true],
    [{ errorType: 'ModelNotFound' }, true],
    [{ errorType: 'ExceededContextWindow' }, true],
    [{ status: 500 }, false],
    [{ errorType: 'ProviderBizError' }, false],
    [new TypeError('fetch failed'), false],
    [Object.assign(new Error('aborted'), { name: 'AbortError', status: 400 }), false],
    [null, false],
  ])('%j → %s', (error, expected) => {
    expect(isUpstreamRejection(error)).toBe(expected);
  });
});
