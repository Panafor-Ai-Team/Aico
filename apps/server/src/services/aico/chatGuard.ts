import { ChatErrorType, type ErrorType } from '@lobechat/types';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import { OrganizationModel } from '@/database/models/organization';
import type { LobeChatDatabase } from '@/database/type';
import { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

import { AicoManagedPolicy } from './managedPolicy';

export class AicoChatGuardError extends Error {
  errorType: ErrorType;

  constructor(message: string, errorType: ErrorType = ChatErrorType.InvalidUserKey) {
    super(message);
    this.name = 'AicoChatGuardError';
    this.errorType = errorType;
  }
}

/**
 * @deprecated Quarantined duplicate — do not build on this.
 *
 * `AicoManagedPolicy` is the single mandatory policy boundary; it is what
 * `initModelRuntimeFromDB` calls, and it is the only one of the two that can
 * actually resolve a key (`resolveUserApiKey` here is stubbed to return `null`).
 * This class has no production call sites and survives only because the Phase 2
 * and Phase 3 bypass-probe suites assert against it.
 *
 * Its provider predicates delegate to `AicoManagedPolicy` rather than repeating
 * the literals, so a managed-provider change cannot leave a stale second answer
 * behind for someone to find and trust.
 */
export class AicoChatGuard {
  private readonly orgModel: OrganizationModel;
  private readonly billingModel: AicoBillingModel;
  private readonly keyService: AicoOpenRouterKeyService;

  constructor(db: LobeChatDatabase) {
    this.orgModel = new OrganizationModel(db);
    this.billingModel = new AicoBillingModel(db);
    this.keyService = new AicoOpenRouterKeyService(db);
  }

  /** @deprecated Use `AicoManagedPolicy.isManagedProvider`. */
  static isManagedProvider(provider: string): boolean {
    return AicoManagedPolicy.isManagedProvider(provider);
  }

  /** @deprecated Use `AicoManagedPolicy.resolveRuntimeProvider`. */
  static resolveRuntimeProvider(provider: string): string {
    return AicoManagedPolicy.resolveRuntimeProvider(provider);
  }

  /**
   * `listForUser` already excludes suspended orgs, so a membership that only
   * exists in a suspended org contributes no allow-list here — the member simply
   * has no managed key to resolve (see `resolveManagedApiKey`), which denies chat
   * downstream rather than granting unrestricted access.
   */
  assertModelAllowed = async (userId: string, modelId: string) => {
    const orgs = await this.orgModel.listForUser(userId);
    for (const org of orgs) {
      const members = await this.orgModel.listMembers(org.id);
      const me = members.find((m) => m.userId === userId && m.status === 'active');
      if (!me) continue;
      const allowed = await this.orgModel.getAllowedModelsForMember(me.id);
      if (!allowed || allowed.length === 0 || !allowed.includes(modelId)) {
        throw new AicoChatGuardError(`MODEL_NOT_ALLOWED:${modelId}`, ChatErrorType.BadRequest);
      }
    }

    const trial = await this.billingModel.getUserTrial(userId);
    if (trial && (await this.billingModel.isTrialActive(userId))) {
      const config = await this.billingModel.getTrialConfig();
      const allowed = JSON.parse(config.allowedModelIds || '[]') as string[];
      if (allowed.length > 0 && !allowed.includes(modelId)) {
        throw new AicoChatGuardError(
          `TRIAL_MODEL_NOT_ALLOWED:${modelId}`,
          ChatErrorType.BadRequest,
        );
      }
      if (config.maxRequests != null && trial.requestCount >= config.maxRequests) {
        throw new AicoChatGuardError('TRIAL_REQUEST_LIMIT', ChatErrorType.SubscriptionPlanLimit);
      }
    }
  };

  /**
   * Returns the decrypted API key for managed chat, or `null` when the caller has
   * no managed key and is not on an active trial — the runtime must treat `null`
   * as "no managed credentials" and must NOT fall back to a shared env API key.
   *
   * Fail closed: an active trial without a resolvable key throws instead of
   * returning `null`, so a provisioning failure can never silently fall through
   * to a shared/env OpenRouter key.
   */
  resolveManagedApiKey = async (userId: string): Promise<string | null> => {
    const key = await this.keyService.resolveUserApiKey(userId);
    if (key) return key;

    if (await this.billingModel.isTrialActive(userId)) {
      throw new AicoChatGuardError('TRIAL_KEY_UNAVAILABLE', ChatErrorType.InvalidUserKey);
    }

    return null;
  };

  recordTrialRequest = async (userId: string) => {
    if (await this.billingModel.isTrialActive(userId)) {
      await this.billingModel.incrementTrialRequest(userId);
    }
  };

  /**
   * Post-chat bookkeeping for managed traffic.
   * Prefer callers that pass explicit billing context — first-match org lookup is legacy-only.
   */
  afterManagedChat = async (
    userId: string,
    params: {
      billingSource?: 'personal' | 'organization';
      completionTokens?: number;
      costMicroUsd?: number;
      modelId: string;
      orgId?: string | null;
      orgMemberId?: string | null;
      promptTokens?: number;
      totalTokens?: number;
    },
  ): Promise<void> => {
    await this.recordTrialRequest(userId);

    let orgId: string | null = params.orgId ?? null;
    let orgMemberId: string | null = params.orgMemberId ?? null;
    let billingSource: 'personal' | 'organization' = params.billingSource ?? 'personal';

    if (!params.billingSource) {
      // Legacy path — do not invent billing; only sync if a single active org budget exists.
      const orgs = await this.orgModel.listForUser(userId);
      for (const org of orgs) {
        const members = await this.orgModel.listMembers(org.id);
        const me = members.find((m) => m.userId === userId && m.status === 'active');
        if (!me) continue;
        const budget = await this.orgModel.getMemberBudget(me.id);
        if (budget?.openrouterKeyId) {
          orgId = org.id;
          orgMemberId = me.id;
          billingSource = 'organization';
          await this.keyService.syncMemberUsage(me.id).catch(() => null);
          break;
        }
      }
    } else if (billingSource === 'organization' && orgMemberId) {
      await this.keyService.syncMemberUsage(orgMemberId).catch(() => null);
    } else if (billingSource === 'personal') {
      await this.keyService.getUserRemaining(userId).catch(() => null);
    }

    await this.billingModel.recordUsage({
      billingSource,
      completionTokens: params.completionTokens ?? 0,
      costMicroUsd: params.costMicroUsd ?? 0,
      modelId: params.modelId,
      orgId,
      orgMemberId,
      promptTokens: params.promptTokens ?? 0,
      totalTokens: params.totalTokens ?? 0,
      userId,
    });
  };
}
