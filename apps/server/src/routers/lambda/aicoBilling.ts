import { BRANDING_NAME } from '@lobechat/business-const';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import { OrganizationModel } from '@/database/models/organization';
import { users } from '@/database/schemas';
import {
  cycleRemainingMicroUsd,
  hasValidManagedKeyId,
  microUsdToDecimalString,
  remainingTomanFromBalance,
} from '@/database/utils/aicoMoney';
import { aicoEnv } from '@/envs/aico';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { getTomanPerUsd } from '@/server/services/aico/fxService';
import { isSharedInferenceKey } from '@/server/services/aico/ledger/config';
import { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

const billingProcedure = authedProcedure.use(serverDatabase).use(async ({ ctx, next }) => {
  return next({
    ctx: {
      billingModel: new AicoBillingModel(ctx.serverDB),
      keyService: new AicoOpenRouterKeyService(ctx.serverDB),
      organizationModel: new OrganizationModel(ctx.serverDB),
    },
  });
});

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Trial is disabled in production until atomic request quotas ship, and stays
 * disabled elsewhere unless both the env flag and the platform config opt in.
 * Missing/unset config defaults to disabled.
 */
const assertTrialAllowed = async (billingModel: AicoBillingModel): Promise<void> => {
  if (isProduction()) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'TRIAL_DISABLED_IN_PRODUCTION' });
  }
  if (!aicoEnv.AICO_ALLOW_TRIAL) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'TRIAL_DISABLED' });
  }
  const config = await billingModel.getTrialConfig();
  if (!config.enabled) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'TRIAL_DISABLED' });
  }
};

/** FX rates arrive as floats from the live feed; period math needs an integer rate. */
const toIntegerFxRate = (rate: number): number => {
  const rounded = Math.round(rate);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'INVALID_FX_RATE' });
  }
  return rounded;
};

export const aicoBillingRouter = router({
  getFxRate: billingProcedure.query(async ({ ctx }) => {
    const config = await ctx.billingModel.getFxConfig();
    const { rate, source } = await getTomanPerUsd(config.tomanPerUsd);
    return { source, tomanPerUsd: toIntegerFxRate(rate) };
  }),

  getMyWallet: billingProcedure.query(async ({ ctx }) => {
    const [wallet, publicCode] = await Promise.all([
      ctx.billingModel.getOrCreateUserWallet(ctx.userId),
      ctx.organizationModel.ensureUserPublicCode(ctx.userId),
    ]);
    const balanceMicroUsd = Number(wallet.balanceMicroUsd ?? 0);
    return {
      // Money is always a string: micro-USD integers and 6-decimal USD, never a float.
      balanceMicroUsd: String(balanceMicroUsd),
      balanceToman: String(wallet.balanceToman ?? 0),
      balanceUsd: microUsdToDecimalString(balanceMicroUsd),
      // Under the shared inference key no subject needs its own key.
      hasManagedKey: isSharedInferenceKey() || Boolean(wallet.openrouterKeyId),
      isActive: wallet.isActive,
      preferredBillingSource: wallet.preferredBillingSource as 'personal' | 'organization',
      preferredOrganizationId: wallet.preferredOrganizationId,
      publicCode,
      // Never expose key material
    };
  }),

  /**
   * Personal wallet + each org membership budget as separate spendable sources.
   * Credits never pool — each source has its own remaining balance and managed key.
   * Personal remaining prefers OpenRouter `limit_remaining`; org remaining syncs
   * settled usage from OpenRouter when a managed key exists.
   */
  getMyBillingSources: billingProcedure.query(async ({ ctx }) => {
    const [wallet, orgs, trialConfig, trialRow, trialActiveRaw] = await Promise.all([
      ctx.billingModel.getOrCreateUserWallet(ctx.userId),
      ctx.organizationModel.listForUser(ctx.userId),
      ctx.billingModel.getTrialConfig(),
      ctx.billingModel.getUserTrial(ctx.userId),
      ctx.billingModel.isTrialActive(ctx.userId),
    ]);

    // Same gate as getMyTrial / managed policy — never advertise a trial chat cannot use.
    const trialEnabled = !isProduction() && aicoEnv.AICO_ALLOW_TRIAL && trialConfig.enabled;
    const trialActive = trialEnabled && trialActiveRaw;
    const trialAvailable = trialEnabled && !trialRow;

    const keyService = ctx.keyService;
    // FIN-018: `getUserRemaining` already degrades honestly and holds the last
    // settled usage. This catch is only for a failure in that path itself —
    // which must still be logged and reported as unknown, never as an unspent
    // wallet.
    const personalReading = await keyService
      .getUserRemaining(ctx.userId, { persist: true })
      .catch((error) => {
        console.warn('[aicoBilling] personal remaining lookup failed', {
          error,
          userId: ctx.userId,
        });
        const settled = Math.max(0, Number(wallet.settledUsageMicroUsd ?? 0));
        return {
          remainingMicroUsd: Math.max(0, Number(wallet.balanceMicroUsd ?? 0) - settled),
          usageKnown: false,
        };
      });
    const personalRemaining = personalReading.remainingMicroUsd;

    const personal = {
      hasManagedKey: isSharedInferenceKey() || hasValidManagedKeyId(wallet.openrouterKeyId),
      isActive: Boolean(wallet.isActive),
      remainingMicroUsd: String(personalRemaining),
      // FIN-016: the toman card had no `remaining` counterpart at any layer, so
      // the primary currency for the fa-IR user base could never move.
      remainingToman: String(
        remainingTomanFromBalance({
          balanceMicroUsd: wallet.balanceMicroUsd,
          balanceToman: wallet.balanceToman,
          remainingMicroUsd: personalRemaining,
        }),
      ),
      remainingUsd: microUsdToDecimalString(personalRemaining),
      source: 'personal' as const,
      /** False when `remaining*` is a held fallback rather than a live reading. */
      usageKnown: personalReading.usageKnown,
    };

    const organizationSources = (
      await Promise.all(
        orgs.map(async (org) => {
          const members = await ctx.organizationModel.listMembers(org.id);
          const me = members.find((m) => m.userId === ctx.userId && m.status === 'active');
          if (!me) return null;

          let budget = await ctx.organizationModel.getMemberBudget(me.id);
          const sharedKey = isSharedInferenceKey();
          // Open ledger holds are committed to in-flight calls; always 0 with the ledger off.
          const orgRemaining = () =>
            Math.max(
              0,
              cycleRemainingMicroUsd(budget ?? {}) - Math.max(0, Number(budget?.heldMicroUsd ?? 0)),
            );

          if (!sharedKey && budget && hasValidManagedKeyId(budget.openrouterKeyId)) {
            await keyService.syncMemberCycleUsage(me.id).catch(() => null);
            budget = await ctx.organizationModel.getMemberBudget(me.id);
          }

          const renewalStatus = budget?.renewalStatus ?? null;
          const renewalBlocked =
            renewalStatus === 'renewal_pending' || renewalStatus === 'renewal_failed';

          let remainingMicroUsd = orgRemaining();

          if (
            !sharedKey &&
            budget?.isActive &&
            !renewalBlocked &&
            remainingMicroUsd > 0 &&
            !hasValidManagedKeyId(budget.openrouterKeyId)
          ) {
            await keyService.ensureMemberKey(me.id).catch((error) => {
              console.warn('[aicoBilling] lazy member key repair failed', {
                orgId: org.id,
                orgMemberId: me.id,
                error,
              });
              return null;
            });
            budget = await ctx.organizationModel.getMemberBudget(me.id);
            remainingMicroUsd = orgRemaining();
          }

          return {
            hasManagedKey: sharedKey || hasValidManagedKeyId(budget?.openrouterKeyId),
            isActive: Boolean(budget?.isActive),
            organizationId: org.id,
            organizationName: org.name,
            remainingMicroUsd: String(remainingMicroUsd),
            remainingUsd: microUsdToDecimalString(remainingMicroUsd),
            renewalBlocked,
            source: 'organization' as const,
          };
        }),
      )
    ).filter(Boolean) as Array<{
      hasManagedKey: boolean;
      isActive: boolean;
      organizationId: string;
      organizationName: string;
      remainingMicroUsd: string;
      remainingUsd: string;
      renewalBlocked: boolean;
      source: 'organization';
    }>;

    return {
      preferredBillingSource: wallet.preferredBillingSource as 'personal' | 'organization',
      preferredOrganizationId: wallet.preferredOrganizationId,
      sources: [personal, ...organizationSources],
      trialActive,
      trialAvailable,
    };
  }),

  getMyPublicCode: billingProcedure.query(async ({ ctx }) => {
    return { publicCode: await ctx.organizationModel.ensureUserPublicCode(ctx.userId) };
  }),

  getMyUsage: billingProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const rows = await ctx.billingModel.listUserUsage(ctx.userId, input?.limit ?? 50);
      return rows.map((row) => ({
        completionTokens: row.completionTokens,
        costMicroUsd: String(row.costMicroUsd),
        costUsd: microUsdToDecimalString(row.costMicroUsd),
        createdAt: row.createdAt,
        id: row.id,
        modelId: row.modelId,
        promptTokens: row.promptTokens,
        settlementStatus: row.settlementStatus,
        totalTokens: row.totalTokens,
      }));
    }),

  getMyTransactions: billingProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const rows = await ctx.billingModel.listUserTransactions(ctx.userId, input?.limit ?? 50);
      return rows.map((row) => ({
        amountMicroUsd: String(row.amountMicroUsd),
        amountToman: String(row.amountToman),
        amountUsd: microUsdToDecimalString(row.amountMicroUsd),
        createdAt: row.createdAt,
        description: row.description,
        id: row.id,
        type: row.type,
      }));
    }),

  /**
   * UX-only: remembers which wallet the SPA pre-selects. Every managed request
   * still carries an explicit billing context that is authorized server-side.
   */
  setBillingPreference: billingProcedure
    .input(
      z.object({
        organizationId: z.string().min(1).optional(),
        source: z.enum(['personal', 'organization']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.source === 'organization') {
        if (!input.organizationId) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'ORGANIZATION_ID_REQUIRED' });
        }
        const role = await ctx.organizationModel.getMemberRole(ctx.userId, input.organizationId);
        if (!role) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'ORG_MEMBERSHIP_REQUIRED' });
        }
      }

      const wallet = await ctx.billingModel.setBillingPreference({
        organizationId: input.organizationId,
        source: input.source,
        userId: ctx.userId,
      });

      return {
        preferredBillingSource: wallet.preferredBillingSource as 'personal' | 'organization',
        preferredOrganizationId: wallet.preferredOrganizationId,
      };
    }),

  getMyTrial: billingProcedure.query(async ({ ctx }) => {
    const [trial, config, active] = await Promise.all([
      ctx.billingModel.getUserTrial(ctx.userId),
      ctx.billingModel.getTrialConfig(),
      ctx.billingModel.isTrialActive(ctx.userId),
    ]);

    // Production (and any environment without the explicit flags) must not
    // advertise a Trial the chat path would refuse to execute.
    const enabled = !isProduction() && aicoEnv.AICO_ALLOW_TRIAL && config.enabled;

    return {
      active: enabled && active,
      config: {
        allowedModelIds: JSON.parse(config.allowedModelIds || '[]') as string[],
        durationDays: config.durationDays,
        enabled,
        maxRequests: config.maxRequests,
        trialBudgetMicroUsd: String(config.trialBudgetMicroUsd),
        trialBudgetUsd: microUsdToDecimalString(config.trialBudgetMicroUsd),
      },
      trial:
        enabled && trial
          ? {
              expiresAt: trial.expiresAt.toISOString(),
              requestCount: trial.requestCount,
              startedAt: trial.startedAt.toISOString(),
              status: trial.status,
            }
          : null,
    };
  }),

  activateTrial: billingProcedure.mutation(async ({ ctx }) => {
    await assertTrialAllowed(ctx.billingModel);

    const user = await ctx.serverDB.query.users.findFirst({
      where: eq(users.id, ctx.userId),
    });
    if (!user?.phone || !user.phoneNumberVerified) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'PHONE_VERIFICATION_REQUIRED',
      });
    }

    try {
      const trial = await ctx.billingModel.activateTrial({
        phone: user.phone,
        userId: ctx.userId,
      });

      const config = await ctx.billingModel.getTrialConfig();
      try {
        await ctx.keyService.ensureTrialKey(ctx.userId, Number(config.trialBudgetMicroUsd));
      } catch (error) {
        // Trial row already exists — the managed policy fails closed at chat time
        // when no key was provisioned, so don't roll back activation here.
        console.error('[aicoBilling] failed to provision trial OpenRouter key', error);
      }

      return {
        expiresAt: trial.expiresAt.toISOString(),
        startedAt: trial.startedAt.toISOString(),
        status: trial.status,
      };
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      const message = error instanceof Error ? error.message : 'TRIAL_FAILED';
      throw new TRPCError({
        code:
          message === 'TRIAL_DISABLED'
            ? 'FORBIDDEN'
            : message.startsWith('TRIAL_')
              ? 'BAD_REQUEST'
              : 'INTERNAL_SERVER_ERROR',
        message,
      });
    }
  }),

  /**
   * Provider surface hint — never returns keys.
   * Aico is always white-label managed OpenRouter for every signed-in user:
   * they top up / get org credit / activate trial, and we provision limited
   * keys server-side. The SPA must never show the multi-provider catalog.
   */
  getManagedProviderStatus: billingProcedure.query(async ({ ctx }) => {
    const [wallet, trialActive, orgs] = await Promise.all([
      ctx.billingModel.getUserWallet(ctx.userId),
      ctx.billingModel.isTrialActive(ctx.userId),
      ctx.organizationModel.listForUser(ctx.userId),
    ]);

    const hasOrgCredit = (
      await Promise.all(
        orgs.map(async (org) => {
          const members = await ctx.organizationModel.listMembers(org.id);
          const me = members.find((m) => m.userId === ctx.userId && m.status === 'active');
          if (!me) return false;
          const budget = await ctx.organizationModel.getMemberBudget(me.id);
          const held = Math.max(0, Number(budget?.heldMicroUsd ?? 0));
          return Boolean(budget?.isActive && cycleRemainingMicroUsd(budget) - held > 0);
        }),
      )
    ).some(Boolean);

    // Keyless wallets are normal under the shared key, so read the ledger instead.
    const hasPersonalCredit = isSharedInferenceKey()
      ? Boolean(wallet) &&
        (await ctx.keyService.getUserRemaining(ctx.userId).catch(() => ({ remainingMicroUsd: 0 })))
          .remainingMicroUsd > 0
      : Boolean(wallet?.openrouterKeyId);

    return {
      brandName: BRANDING_NAME,
      hasCredit: hasPersonalCredit || trialActive || hasOrgCredit,
      managed: true,
      providerId: 'aico',
      runtimeProviderId: 'openrouter',
    };
  }),
});

export type AicoBillingRouter = typeof aicoBillingRouter;
