import type { ChatStreamPayload, ModelRuntimeHooks, OnFinishData } from '@lobechat/model-runtime';
import { AgentRuntimeErrorType, ChatErrorType } from '@lobechat/types';

import {
  AicoUsageLedgerModel,
  type HoldOperation,
  type HoldRefusal,
  type HoldSubject,
  type SettleParams,
  type SettleTokens,
} from '@/database/models/aicoUsageLedger';
import type { LobeChatDatabase } from '@/database/type';
import { applyMultiplierMicroUsd } from '@/database/utils/aicoMoney';

import { AicoManagedPolicyError, type ManagedExecutionContext } from '../managedPolicy';
import { getCachedUsageMultiplierBp } from '../usageMultiplier';
import { getLedgerConfig, type LedgerConfig } from './config';
import {
  estimateChatInputTokens,
  estimateEmbeddingInputTokens,
  holdRawForChat,
  resolveMaxOutputTokens,
  shrinkMaxOutputToFit,
} from './estimate';
import { assertPlatformCapacity } from './floatGuard';
import type { LedgerGate } from './gate';
import {
  getManagedModelRates,
  type ManagedModelRates,
  rawCostMicroUsd,
  resolveChatRates,
} from './pricing';

export interface ManagedBillingDeps {
  assertPlatformCapacity: typeof assertPlatformCapacity;
  config: LedgerConfig;
  ledger: Pick<
    AicoUsageLedgerModel,
    'placeHold' | 'recordShadowHold' | 'settleHold' | 'shadowAvailability'
  >;
  platformBp: () => Promise<number>;
  rates: { chat: typeof resolveChatRates; model: typeof getManagedModelRates };
}

/** How long after a client abort the hold is charged, if the stream never finalizes. */
export const ABORT_SETTLE_DELAY_MS = 5000;

interface Handle {
  abortCleanup?: () => void;
  finalizing: boolean;
  holdId: string;
  holdRaw: number;
  rates: ManagedModelRates | null;
  settled: boolean;
}

const REJECTION_ERROR_TYPES = new Set<string>([
  AgentRuntimeErrorType.ExceededContextWindow,
  AgentRuntimeErrorType.InsufficientQuota,
  AgentRuntimeErrorType.InvalidProviderAPIKey,
  AgentRuntimeErrorType.LocationNotSupportError,
  AgentRuntimeErrorType.ModelNotFound,
  AgentRuntimeErrorType.PermissionDenied,
  AgentRuntimeErrorType.QuotaLimitReached,
]);

const REJECTION_STATUSES = new Set([400, 401, 403, 404, 409, 413, 422, 429]);

/**
 * True when the upstream refused the request before doing billable work, so
 * the hold can be released for free. Anything unclear (5xx, network, timeout,
 * abort) is not a rejection: the upstream may have billed partial output.
 */
export const isUpstreamRejection = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const e = error as {
    error?: { status?: unknown };
    errorType?: unknown;
    name?: unknown;
    status?: unknown;
  };
  if (e.name === 'AbortError') return false;
  if (typeof e.errorType === 'string' && REJECTION_ERROR_TYPES.has(e.errorType)) return true;
  const status = Number(e.status ?? e.error?.status);
  return REJECTION_STATUSES.has(status);
};

const mapUsage = (usage: OnFinishData['usage'] | undefined): SettleTokens | null => {
  const prompt = Math.trunc(Number(usage?.totalInputTokens ?? 0));
  if (!usage || !(prompt > 0)) return null;
  const completion = Math.max(0, Math.trunc(Number(usage.totalOutputTokens ?? 0)));
  return {
    completion,
    prompt,
    reasoning: Math.max(0, Math.trunc(Number(usage.outputReasoningTokens ?? 0))),
    total: Math.max(0, Math.trunc(Number(usage.totalTokens ?? prompt + completion))),
  };
};

const policyError = (code: string) =>
  new AicoManagedPolicyError(code, ChatErrorType.InvalidUserKey);

/**
 * Hold-and-settle metering for one managed runtime. Every call reserves its
 * worst case before it reaches the upstream and settles when it ends; a hold
 * that never settles is charged in full at expiry. Returns undefined when the
 * ledger is off.
 */
export const createManagedBillingHooks = (params: {
  authorized: ManagedExecutionContext;
  db: LobeChatDatabase;
  deps?: Partial<ManagedBillingDeps>;
  gate: LedgerGate;
}): ModelRuntimeHooks | undefined => {
  const { authorized, db, gate } = params;
  if (gate.mode === 'off') return undefined;

  const deps: ManagedBillingDeps = {
    assertPlatformCapacity,
    config: getLedgerConfig(),
    ledger: new AicoUsageLedgerModel(db),
    platformBp: () => getCachedUsageMultiplierBp(db),
    rates: { chat: resolveChatRates, model: getManagedModelRates },
    ...params.deps,
  };
  const { config: cfg, ledger } = deps;
  const enforce = gate.mode === 'enforce';
  const isOrg = authorized.billing.source === 'organization';
  const billingSource = isOrg ? 'organization' : 'personal';
  const handles = new WeakMap<object, Handle>();

  const subject = (): HoldSubject => {
    if (!isOrg) return { type: 'wallet', userId: authorized.userId };
    if (!authorized.budgetId || !authorized.orgId || !authorized.orgMemberId) {
      throw policyError('MEMBER_BUDGET_INACTIVE:not_found');
    }
    return {
      budgetId: authorized.budgetId,
      orgId: authorized.orgId,
      orgMemberId: authorized.orgMemberId,
      type: 'budget',
      userId: authorized.userId,
    };
  };

  const refusalError = (refusal: HoldRefusal) => {
    switch (refusal.reason) {
      case 'funds': {
        return policyError(isOrg ? 'MEMBER_BUDGET_UNFUNDED' : 'PERSONAL_FUNDS_UNAVAILABLE');
      }
      case 'concurrency': {
        return policyError('USAGE_CONCURRENCY_LIMIT');
      }
      case 'inactive': {
        return policyError(isOrg ? 'MEMBER_BUDGET_INACTIVE' : 'PERSONAL_WALLET_INACTIVE');
      }
      case 'not_found': {
        return policyError(
          isOrg ? 'MEMBER_BUDGET_INACTIVE:not_found' : 'PERSONAL_WALLET_INACTIVE:not_found',
        );
      }
      case 'renewal_blocked': {
        return policyError('MEMBER_BUDGET_RENEWAL_BLOCKED');
      }
    }
  };

  const settle = async (handle: Handle, settleParams: SettleParams) => {
    if (handle.settled) return;
    handle.settled = true;
    handle.abortCleanup?.();
    try {
      await ledger.settleHold(handle.holdId, settleParams);
    } catch (error) {
      // The hold stays open and maintenance charges it in full at expiry.
      console.error('[aico-ledger] settle failed', {
        holdId: handle.holdId,
        message: (error as Error)?.message,
        reason: settleParams.reason,
      });
    }
  };

  interface PlaceArgs {
    estInput: number;
    maxOutput: number;
    modelId: string;
    operation: HoldOperation;
    payload: object;
    rates: ManagedModelRates;
    /** Chat only: shrink `max_tokens` to fit when funds are short. */
    shrinkable?: { max_tokens?: number };
  }

  const placeEnforce = async (args: PlaceArgs): Promise<Handle> => {
    const { estInput, modelId, operation, rates, shrinkable } = args;
    let maxOutput = args.maxOutput;
    const holdSubject = subject();

    let platformBp: number;
    try {
      platformBp = await deps.platformBp();
    } catch {
      throw policyError('PLATFORM_CAPACITY_EXHAUSTED:ledger_error');
    }

    const place = async () => {
      const holdRaw = holdRawForChat(rates, estInput, maxOutput);
      if (gate.sharedKey) {
        await deps.assertPlatformCapacity({
          db,
          holdRawMicroUsd: holdRaw,
          sharedKey: gate.sharedKey,
        });
      }
      const result = await ledger.placeHold({
        billingSource,
        estInputTokens: estInput,
        holdRawMicroUsd: holdRaw,
        maxOpenHolds: cfg.maxOpenHolds,
        maxOutputTokens: maxOutput,
        modelId,
        modelMultiplierBp: rates.modelBp,
        multiplierBp: platformBp,
        operation,
        pricedModelId: rates.pricedModelId,
        subject: holdSubject,
        ttlSeconds: cfg.holdTtlSeconds,
      });
      return { holdRaw, result };
    };

    try {
      let { holdRaw, result } = await place();

      if (!result.ok && result.refusal.reason === 'funds' && shrinkable) {
        const shrunk = shrinkMaxOutputToFit({
          available: result.refusal.available,
          estInput,
          maxOutput,
          rates,
          toSubjectUnit: (raw) => (isOrg ? applyMultiplierMicroUsd(raw, platformBp) : raw),
        });
        if (shrunk && shrunk < maxOutput) {
          maxOutput = shrunk;
          shrinkable.max_tokens = shrunk;
          ({ holdRaw, result } = await place());
        }
      }

      if (!result.ok) throw refusalError(result.refusal);

      return { finalizing: false, holdId: result.holdId, holdRaw, rates, settled: false };
    } catch (error) {
      if (error instanceof AicoManagedPolicyError) throw error;
      console.error('[aico-ledger] placing hold failed', {
        message: (error as Error)?.message,
        operation,
      });
      throw policyError('PLATFORM_CAPACITY_EXHAUSTED:ledger_error');
    }
  };

  /** Shadow never throws and never blocks: it only records what enforce would do. */
  const placeShadow = async (
    args: Omit<PlaceArgs, 'rates'> & { rates: ManagedModelRates | null; refuseReason?: string },
  ): Promise<Handle | null> => {
    try {
      const { estInput, maxOutput, modelId, operation, rates } = args;
      const holdSubject = subject();
      const platformBp = await deps.platformBp();
      const holdRaw = rates ? holdRawForChat(rates, estInput, maxOutput) : 0;

      const refusal = args.refuseReason
        ? null
        : await ledger.shadowAvailability({
            holdBilledMicroUsd: applyMultiplierMicroUsd(holdRaw, platformBp),
            maxOpenHolds: cfg.maxOpenHolds,
            subject: holdSubject,
          });
      const refuseReason = args.refuseReason ?? refusal?.reason ?? null;

      const holdId = await ledger.recordShadowHold({
        billingSource,
        estInputTokens: estInput,
        holdRawMicroUsd: holdRaw,
        maxOpenHolds: cfg.maxOpenHolds,
        maxOutputTokens: maxOutput,
        modelId,
        modelMultiplierBp: rates?.modelBp ?? 10_000,
        multiplierBp: platformBp,
        operation,
        pricedModelId: rates?.pricedModelId ?? null,
        refuseReason,
        subject: holdSubject,
        ttlSeconds: cfg.holdTtlSeconds,
        wouldRefuse: Boolean(refuseReason),
      });
      return { finalizing: false, holdId, holdRaw, rates, settled: false };
    } catch (error) {
      console.warn('[aico-ledger] shadow hold failed', {
        message: (error as Error)?.message,
        operation: args.operation,
      });
      return null;
    }
  };

  /** Places (or records) a hold for a priced call and registers its handle. */
  const begin = async (
    args: Omit<PlaceArgs, 'rates'> & { rates: ManagedModelRates | null },
  ): Promise<Handle | null> => {
    const previous = handles.get(args.payload);
    if (previous && !previous.settled) await settle(previous, { reason: 'estimate_error' });

    if (!args.rates) {
      if (enforce) throw policyError('MODEL_PRICING_UNAVAILABLE');
      const handle = await placeShadow({ ...args, refuseReason: 'pricing' });
      if (handle) {
        handles.set(args.payload, handle);
        await settle(handle, { reason: 'not_metered' });
      }
      return null;
    }

    const handle = enforce
      ? await placeEnforce({ ...args, rates: args.rates })
      : await placeShadow(args);
    if (handle) handles.set(args.payload, handle);
    return handle;
  };

  const registerAbort = (handle: Handle, signal?: AbortSignal) => {
    if (!signal) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      timer = setTimeout(() => {
        if (!handle.finalizing && !handle.settled)
          void settle(handle, { reason: 'estimate_aborted' });
      }, ABORT_SETTLE_DELAY_MS);
      (timer as { unref?: () => void }).unref?.();
    };
    if (signal.aborted) {
      onAbort();
      handle.abortCleanup = () => {
        if (timer) clearTimeout(timer);
      };
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    handle.abortCleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
    };
  };

  /** Settles from reported usage, or charges the hold when none was reported. */
  const finish = async (
    handle: Handle | undefined,
    data: { failed: boolean; resolvedModel?: string; usage?: OnFinishData['usage'] },
  ) => {
    if (!handle || handle.settled) return;
    handle.finalizing = true;

    const tokens = mapUsage(data.usage);
    if (!tokens || !handle.rates) {
      await settle(handle, { reason: data.failed ? 'estimate_error' : 'estimate_no_usage' });
      return;
    }

    let rates = handle.rates;
    if (data.resolvedModel && data.resolvedModel !== rates.pricedModelId) {
      try {
        rates = (await deps.rates.model(db, data.resolvedModel)) ?? rates;
      } catch {
        // Keep the hold-time rates.
      }
    }

    // Recomputed from tokens; a provider-reported `usage.cost` is never trusted.
    const raw = rawCostMicroUsd(rates, tokens);
    if (raw > handle.holdRaw) {
      console.warn('[aico-ledger] actual exceeded hold', {
        holdId: handle.holdId,
        model: rates.pricedModelId,
        ratio: handle.holdRaw > 0 ? raw / handle.holdRaw : null,
      });
    }
    await settle(handle, {
      chargedRawMicroUsd: raw,
      rawCostMicroUsd: raw,
      reason: 'usage',
      resolvedModelId: data.resolvedModel ?? null,
      tokens,
    });
  };

  const fail = async (handle: Handle | undefined, error: unknown) => {
    if (!handle || handle.settled) return;
    handle.finalizing = true;
    await settle(handle, {
      reason: isUpstreamRejection(error) ? 'released_rejected' : 'estimate_error',
    });
  };

  const notMetered = async (operation: HoldOperation, modelId: string) => {
    if (enforce) throw policyError('MANAGED_OPERATION_NOT_METERED');
    const handle = await placeShadow({
      estInput: 0,
      maxOutput: 0,
      modelId,
      operation,
      payload: {},
      rates: null,
      refuseReason: 'not_metered',
    });
    if (handle) await settle(handle, { reason: 'not_metered' });
  };

  return {
    beforeChat: async (payload: ChatStreamPayload, options) => {
      const priced = await deps.rates.chat(db, payload).catch((error) => {
        if (enforce) throw policyError('PLATFORM_CAPACITY_EXHAUSTED:ledger_error');
        console.warn('[aico-ledger] pricing lookup failed', (error as Error)?.message);
        return null;
      });
      const rates = priced?.rates ?? null;

      let maxOutput = 0;
      if (rates) {
        maxOutput = resolveMaxOutputTokens({
          defaultMax: cfg.defaultMaxOutputTokens,
          modelMax: rates.maxOutputTokens,
          requested: payload.max_tokens,
        });
        payload.max_tokens = maxOutput;
      }

      const handle = await begin({
        estInput: estimateChatInputTokens(payload, rates?.contextWindowTokens ?? null),
        maxOutput,
        modelId: payload.model,
        operation: 'chat',
        payload,
        rates,
        shrinkable: payload,
      });
      if (handle) registerAbort(handle, options?.signal);
    },

    beforeCreateImage: async (payload) => notMetered('image', payload.model),
    beforeCreateVideo: async (payload) => notMetered('video', payload.model),

    beforeEmbeddings: async (payload) => {
      const rates = await deps.rates.model(db, payload.model).catch((error) => {
        if (enforce) throw policyError('PLATFORM_CAPACITY_EXHAUSTED:ledger_error');
        console.warn('[aico-ledger] pricing lookup failed', (error as Error)?.message);
        return null;
      });
      await begin({
        estInput: estimateEmbeddingInputTokens(
          payload.input as string | string[],
          rates?.contextWindowTokens ?? null,
        ),
        maxOutput: 0,
        modelId: payload.model,
        operation: 'embeddings',
        payload,
        rates,
      });
    },

    beforeGenerateObject: async (payload) => {
      // Priced like chat so an auto id resolves to its routed (or dearest) model.
      const priced = await deps.rates
        .chat(db, payload as unknown as ChatStreamPayload)
        .catch((error) => {
          if (enforce) throw policyError('PLATFORM_CAPACITY_EXHAUSTED:ledger_error');
          console.warn('[aico-ledger] pricing lookup failed', (error as Error)?.message);
          return null;
        });
      const rates = priced?.rates ?? null;
      await begin({
        estInput: estimateChatInputTokens(payload, rates?.contextWindowTokens ?? null),
        // Output cannot be capped upstream here, so assume the full default cap.
        maxOutput: rates
          ? resolveMaxOutputTokens({
              defaultMax: cfg.defaultMaxOutputTokens,
              modelMax: rates.maxOutputTokens,
              requested: null,
            })
          : 0,
        modelId: payload.model,
        operation: 'object',
        payload,
        rates,
      });
    },

    beforeTextToSpeech: async (payload) => notMetered('tts', payload.model),
    beforeTranscribe: async (payload) => notMetered('transcribe', payload.model),

    onChatError: async (error, { payload }) => fail(handles.get(payload), error),

    onChatFinal: async (data, { payload }) => {
      const handle = handles.get(payload);
      // Synchronously, before any await, so a pending abort timer stands down.
      if (handle) handle.finalizing = true;
      await finish(handle, {
        failed: Boolean(data.error),
        resolvedModel: data.resolvedModel,
        usage: data.usage,
      });
    },

    onEmbeddingsComplete: async (data, { payload }) =>
      finish(handles.get(payload), { failed: !data.success, usage: data.usage }),

    onEmbeddingsError: async (error, { payload }) => fail(handles.get(payload), error),

    onGenerateObjectComplete: async (data, { payload }) =>
      finish(handles.get(payload), { failed: !data.success, usage: data.usage }),

    onGenerateObjectError: async (error, { payload }) => fail(handles.get(payload), error),
  };
};
