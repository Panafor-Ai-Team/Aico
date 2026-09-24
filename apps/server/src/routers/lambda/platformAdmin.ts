import {
  MANAGED_PROVIDER_ID,
  MANAGED_PROVIDER_IDS,
  type ManagedProviderId,
} from '@lobechat/business-const';
import { TRPCError } from '@trpc/server';
import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import { OrganizationModel } from '@/database/models/organization';
import { PlatformAdminUserModel } from '@/database/models/platformAdminUser';
import { aicoKeyOutbox, memberBudgets, session, users, userWallets } from '@/database/schemas';
import {
  DEFAULT_USAGE_MULTIPLIER_BP,
  MAX_USAGE_MULTIPLIER_BP,
  microUsdToDecimalString,
  MIN_USAGE_MULTIPLIER_BP,
  tomanString,
  usdDecimalStringToMicro,
} from '@/database/utils/aicoMoney';
import {
  hashOperatorPassword,
  meetsOperatorPasswordComplexity,
} from '@/database/utils/operatorPassword';
import { revokeOIDCArtifactsByUserId } from '@/libs/oidc-provider/access-control';
import { platformAdminProcedure, publicProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { getTomanPerUsd } from '@/server/services/aico/fxService';
import { isSharedInferenceKey } from '@/server/services/aico/ledger/config';
import { refreshAicoMasterMonitorState } from '@/server/services/aico/masterMonitor';
import {
  executeOrgBudgetSweep,
  previewOrgBudgetSweep,
  serializeSweepPreview,
  serializeSweepResult,
} from '@/server/services/aico/orgBudgetSweep';
import { listReconciliationRuns, runReconciliation } from '@/server/services/aico/reconciliation';
import {
  resolveTopupAmount,
  topupAmountInputSchema,
} from '@/server/services/aico/resolveTopupAmount';
import { recordAicoSecurityEvent } from '@/server/services/aico/securityAudit';
import {
  AicoOpenRouterKeyService,
  type ReissueOutcome,
} from '@/server/services/openrouter/keyService';
import { OpenRouterModelCatalogSyncService } from '@/server/services/openrouter/modelCatalogSync';

/**
 * Platform-admin procedures live on the Aico control plane only.
 * Do not mount this router on the customer product lambda.
 */

/**
 * Which managed provider a rate edit targets. Defaults to the live provider so
 * an admin editing "the" multiplier cannot silently change the dormant one.
 */
const managedProviderSchema = z.enum(
  MANAGED_PROVIDER_IDS as unknown as [ManagedProviderId, ...ManagedProviderId[]],
);

const userTargetSchema = {
  email: z.string().email().optional(),
  publicCode: z.string().min(1).max(32).optional(),
  userId: z.string().min(1).optional(),
};

const resolveTargetUserId = async (
  organizationModel: OrganizationModel,
  input: { email?: string; publicCode?: string; userId?: string },
) => {
  let userId = input.userId;
  if (!userId && input.email) {
    userId = (await organizationModel.findUserIdByEmail(input.email)) ?? undefined;
  }
  if (!userId && input.publicCode) {
    userId = (await organizationModel.getUserIdByPublicCode(input.publicCode)) ?? undefined;
  }
  if (!userId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'userId, email, or publicCode of an existing user is required',
    });
  }
  return userId;
};

const serializeReconciliationRun = (run: Awaited<ReturnType<typeof runReconciliation>>) => ({
  checks: run.checks,
  error: run.error,
  finishedAt: run.finishedAt?.toISOString() ?? null,
  id: run.id,
  startedAt: run.startedAt.toISOString(),
  status: run.status,
  trigger: run.trigger,
});

const platformProcedure = platformAdminProcedure.use(serverDatabase).use(async ({ ctx, next }) => {
  const organizationModel = new OrganizationModel(ctx.serverDB);
  const adminModel = new PlatformAdminUserModel(ctx.serverDB);
  const admin = await adminModel.findActiveById(ctx.adminId);
  if (!admin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Platform admin required' });
  }
  return next({
    ctx: {
      admin,
      adminModel,
      billingModel: new AicoBillingModel(ctx.serverDB),
      modelCatalogSync: new OpenRouterModelCatalogSyncService(ctx.serverDB),
      organizationModel,
    },
  });
});

export const platformAdminRouter = router({
  /**
   * Soft gate for the control-plane SPA: authenticated users learn whether they
   * are platform admins without throwing FORBIDDEN (so the UI can stay on login /
   * "not allowed" instead of the admin panel shell).
   */
  checkAccess: publicProcedure.use(serverDatabase).query(async ({ ctx }) => {
    if (!ctx.adminId) {
      return { email: null, isPlatformAdmin: false, adminId: null };
    }
    const admin = await new PlatformAdminUserModel(ctx.serverDB).findActiveById(ctx.adminId);
    return {
      adminId: admin?.id ?? null,
      email: admin?.email ?? null,
      isPlatformAdmin: Boolean(admin),
    };
  }),

  /** FX helper for the control-plane admin UI (replaces aicoBilling.getFxRate there). */
  getFxRate: platformProcedure.query(async ({ ctx }) => {
    const config = await ctx.billingModel.getFxConfig();
    const { rate, source } = await getTomanPerUsd(config.tomanPerUsd);
    return { source, tomanPerUsd: Math.round(rate) };
  }),

  updateFxRate: platformProcedure
    .input(
      z.object({
        tomanPerUsd: z.number().int().positive().max(10_000_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.billingModel.updateFxConfig({
        tomanPerUsd: input.tomanPerUsd,
      });
      await recordAicoSecurityEvent(ctx.serverDB, {
        action: 'platform.fx.update',
        actorAdminId: ctx.adminId,
        ipAddress: ctx.clientIp,
        metadata: { tomanPerUsd: row.tomanPerUsd },
        targetId: 'default',
        targetType: 'platform_fx_config',
        userAgent: ctx.userAgent,
      });
      return {
        source: 'admin' as const,
        tomanPerUsd: Math.round(Number(row.tomanPerUsd)),
      };
    }),

  /**
   * Platform usage multiplier (AICO-180), one row per managed provider
   * (AICO-186). Per-user relief is expressed as a coupon on top, never as a
   * second multiplier.
   */
  getUsageMultiplier: platformProcedure
    .input(z.object({ providerId: managedProviderSchema.optional() }).optional())
    .query(async ({ ctx, input }) => {
      const providerId = input?.providerId ?? MANAGED_PROVIDER_ID;
      const config = await ctx.billingModel.getUsageMultiplierConfig(providerId);
      return {
        multiplierBp: Number(config.multiplierBp ?? DEFAULT_USAGE_MULTIPLIER_BP),
        providerId,
        updatedAt: config.updatedAt ?? null,
      };
    }),

  /** Every managed provider's rate, for the platform admin table. */
  listUsageMultipliers: platformProcedure.query(async ({ ctx }) => {
    const rows = await ctx.billingModel.listUsageMultipliers([...MANAGED_PROVIDER_IDS]);
    return {
      activeProviderId: MANAGED_PROVIDER_ID,
      providers: rows.map((row) => ({
        isActive: row.id === MANAGED_PROVIDER_ID,
        multiplierBp: Number(row.multiplierBp ?? DEFAULT_USAGE_MULTIPLIER_BP),
        providerId: row.id,
        updatedAt: row.updatedAt ?? null,
      })),
    };
  }),

  updateUsageMultiplier: platformProcedure
    .input(
      z.object({
        multiplierBp: z.number().int().min(MIN_USAGE_MULTIPLIER_BP).max(MAX_USAGE_MULTIPLIER_BP),
        providerId: managedProviderSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const providerId = input.providerId ?? MANAGED_PROVIDER_ID;
      const row = await ctx.billingModel.updateUsageMultiplier({
        multiplierBp: input.multiplierBp,
        providerId,
      });
      await recordAicoSecurityEvent(ctx.serverDB, {
        action: 'platform.usageMultiplier.update',
        actorAdminId: ctx.adminId,
        ipAddress: ctx.clientIp,
        metadata: { multiplierBp: Number(row.multiplierBp), providerId },
        targetId: providerId,
        targetType: 'platform_usage_multiplier_config',
        userAgent: ctx.userAgent,
      });
      return { multiplierBp: Number(row.multiplierBp), providerId };
    }),

  /**
   * Catalog models with the coefficient upstream publishes for each. Read-only:
   * coefficients come from the catalog sync (every 6h), not from admin edits.
   */
  listModelMultipliers: platformProcedure
    .input(z.object({ providerId: managedProviderSchema.optional() }).optional())
    .query(async ({ ctx, input }) => {
      const providerId = input?.providerId ?? MANAGED_PROVIDER_ID;
      const catalog = await ctx.modelCatalogSync.listCatalogCoefficients();

      return {
        models: catalog.map((model) => ({
          displayName: model.displayName,
          enabled: model.enabled,
          modelId: model.id,
          publishedBp: model.publishedBp,
        })),
        providerId,
      };
    }),

  /**
   * Choose which catalog models the site offers. The flag survives catalog
   * syncs, so a choice made here is not undone by the next refresh.
   */
  setModelsEnabled: platformProcedure
    .input(
      z.object({
        enabled: z.boolean(),
        modelIds: z.array(z.string().min(1).max(256)).min(1).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const count = await ctx.modelCatalogSync.setModelsEnabled(input.modelIds, input.enabled);
      await recordAicoSecurityEvent(ctx.serverDB, {
        action: 'platform.modelEnabled.update',
        actorAdminId: ctx.adminId,
        ipAddress: ctx.clientIp,
        metadata: { count, enabled: input.enabled, modelIds: input.modelIds.slice(0, 50) },
        targetId: input.modelIds.length === 1 ? input.modelIds[0] : `bulk:${count}`,
        targetType: 'openrouter_model_catalog',
        userAgent: ctx.userAgent,
      });
      return { count, enabled: input.enabled };
    }),

  listOrganizations: platformProcedure
    .input(
      z
        .object({
          page: z.number().int().min(1).optional(),
          pageSize: z.number().int().min(1).max(100).optional(),
          query: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      return ctx.organizationModel.listOrganizations(input ?? {});
    }),

  createOrganization: platformProcedure
    .input(
      z.object({
        managerEmail: z.string().email().optional(),
        managerUserId: z.string().min(1).optional(),
        name: z.string().min(1).max(120),
        slug: z.string().min(1).max(80).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let ownerUserId = input.managerUserId;
      if (!ownerUserId && input.managerEmail) {
        ownerUserId =
          (await ctx.organizationModel.findUserIdByEmail(input.managerEmail)) ?? undefined;
      }
      if (!ownerUserId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'managerUserId or existing managerEmail is required',
        });
      }

      const org = await ctx.organizationModel.createOrganization({
        name: input.name,
        ownerUserId,
        slug: input.slug,
      });
      await recordAicoSecurityEvent(ctx.serverDB, {
        action: 'platform.org.create',
        actorAdminId: ctx.adminId,
        ipAddress: ctx.clientIp,
        metadata: { name: org.name, slug: org.slug },
        organizationId: org.id,
        targetId: org.id,
        targetType: 'organization',
        userAgent: ctx.userAgent,
      });
      return { id: org.id, name: org.name, publicCode: org.publicCode, slug: org.slug };
    }),

  assignManager: platformProcedure
    .input(
      z.object({
        managerEmail: z.string().email().optional(),
        orgId: z.string().min(1),
        role: z.enum(['owner', 'admin']).default('admin'),
        userId: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let userId = input.userId;
      if (!userId && input.managerEmail) {
        userId = (await ctx.organizationModel.findUserIdByEmail(input.managerEmail)) ?? undefined;
      }
      if (!userId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'userId or existing managerEmail is required',
        });
      }

      const org = await ctx.organizationModel.getById(input.orgId);
      if (!org) throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });

      return ctx.organizationModel
        .assignManager({
          orgId: input.orgId,
          role: input.role,
          userId,
        })
        .then(async (row) => {
          await recordAicoSecurityEvent(ctx.serverDB, {
            action: 'platform.org.assign_manager',
            actorAdminId: ctx.adminId,
            ipAddress: ctx.clientIp,
            metadata: { role: input.role, targetUserId: userId },
            organizationId: input.orgId,
            targetId: userId,
            targetType: 'user',
            userAgent: ctx.userAgent,
          });
          return row;
        });
    }),

  suspendOrganization: platformProcedure
    .input(z.object({ orgId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const row = await ctx.organizationModel.setOrganizationStatus(input.orgId, 'suspended');
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });

        // Fail closed: a suspended org's members must lose OpenRouter access immediately,
        // not just at the next usage-sync poll.
        const keyService = new AicoOpenRouterKeyService(ctx.serverDB);
        await keyService.disableAllOrgMemberKeys(input.orgId);

        await recordAicoSecurityEvent(ctx.serverDB, {
          action: 'platform.org.suspend',
          actorAdminId: ctx.adminId,
          ipAddress: ctx.clientIp,
          organizationId: input.orgId,
          targetId: input.orgId,
          targetType: 'organization',
          userAgent: ctx.userAgent,
        });

        return row;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        const message = error instanceof Error ? error.message : 'SUSPEND_FAILED';
        if (message === 'ORG_ALREADY_DELETED') {
          throw new TRPCError({ code: 'BAD_REQUEST', message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  activateOrganization: platformProcedure
    .input(z.object({ orgId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const row = await ctx.organizationModel.setOrganizationStatus(input.orgId, 'active');
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
        await recordAicoSecurityEvent(ctx.serverDB, {
          action: 'platform.org.activate',
          actorAdminId: ctx.adminId,
          ipAddress: ctx.clientIp,
          organizationId: input.orgId,
          targetId: input.orgId,
          targetType: 'organization',
          userAgent: ctx.userAgent,
        });
        return row;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        const message = error instanceof Error ? error.message : 'ACTIVATE_FAILED';
        if (message === 'ORG_ALREADY_DELETED') {
          throw new TRPCError({ code: 'BAD_REQUEST', message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /** Past manual credit / debit reasons, for the admin forms to suggest. */
  listManualReasons: platformProcedure
    .input(z.object({ kind: z.enum(['credit', 'debit']) }))
    .query(({ ctx, input }) => ctx.billingModel.listManualReasons(input.kind)),

  addManualCredit: platformProcedure
    .input(
      topupAmountInputSchema.extend({
        // Required: the books check flags any credit that does not say why.
        description: z.string().trim().min(1).max(500),
        // FIN-013: required, not optional. A null gateway_ref_id skips the
        // partial unique index entirely, which left every manual credit
        // replayable by a simple retry.
        idempotencyKey: z.string().min(8).max(128),
        orgId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let amountMicroUsd: number;
      let amountToman: number;
      let result: Awaited<ReturnType<typeof ctx.organizationModel.addManualCredit>>;

      try {
        const fxConfig = await ctx.billingModel.getFxConfig();
        const amounts = await resolveTopupAmount(input, { adminRate: fxConfig.tomanPerUsd });
        amountMicroUsd = amounts.amountMicroUsd;
        amountToman = amounts.amountToman;
        result = await ctx.organizationModel.addManualCredit({
          amountMicroUsd,
          amountToman,
          createdByAdminId: ctx.adminId,
          description: input.description,
          fxRateTomanPerUsd: amounts.fxRateTomanPerUsd,
          idempotencyKey: input.idempotencyKey,
          orgId: input.orgId,
          type: 'manual_credit',
        });
      } catch (error) {
        // Nothing committed on this path — a retry is safe.
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Failed to add credit',
        });
      }

      // FIN-013: the money has moved; a failure below must not be reported as a
      // failed credit, or the admin's retry credits the org a second time.
      await recordAicoSecurityEvent(ctx.serverDB, {
        action: 'platform.credit.org_add',
        actorAdminId: ctx.adminId,
        ipAddress: ctx.clientIp,
        metadata: {
          amountMicroUsd,
          amountToman,
          idempotencyKey: input.idempotencyKey,
          transactionId: result.transaction.id,
        },
        organizationId: input.orgId,
        targetId: result.transaction.id,
        targetType: 'wallet_transaction',
        userAgent: ctx.userAgent,
      }).catch((error) => console.error('[aico] failed to record credit audit event', error));

      return {
        organization: {
          ...result.organization,
          walletBalanceMicroUsd: String(result.organization.walletBalanceMicroUsd ?? 0),
          walletBalanceUsd: microUsdToDecimalString(result.organization.walletBalanceMicroUsd ?? 0),
        },
        transaction: {
          ...result.transaction,
          amountMicroUsd: String(result.transaction.amountMicroUsd ?? 0),
          amountUsd: microUsdToDecimalString(result.transaction.amountMicroUsd ?? 0),
        },
      };
    }),

  /**
   * Operator-side dry run of the org budget sweep. Read-only — no key is
   * disabled, so an operator can inspect an org and walk away.
   */
  previewOrgBudgetSweep: platformProcedure
    .input(z.object({ orgId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        return serializeSweepPreview(
          await previewOrgBudgetSweep({ db: ctx.serverDB, orgId: input.orgId }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'PREVIEW_FAILED';
        if (message === 'ORG_NOT_FOUND') throw new TRPCError({ code: 'NOT_FOUND', message });
        throw new TRPCError({ cause: error, code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /**
   * Operator-side bulk reclaim of every member allowance in an org back to the
   * org wallet. Same service as the manager-facing `sweepAllMemberBudgets`;
   * only the recorded actor differs.
   */
  sweepOrgMemberBudgets: platformProcedure
    .input(
      z.object({
        confirm: z.literal(true),
        idempotencyKey: z.string().min(8).max(128),
        orgId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let result;
      try {
        result = await executeOrgBudgetSweep({
          // Control-plane operators have no product user id; the audit row below
          // carries `actorAdminId` instead, and the ledger rows stay actor-less.
          actorUserId: null,
          batchId: input.idempotencyKey,
          db: ctx.serverDB,
          orgId: input.orgId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'SWEEP_FAILED';
        if (message === 'ORG_NOT_FOUND') throw new TRPCError({ code: 'NOT_FOUND', message });
        throw new TRPCError({ cause: error, code: 'INTERNAL_SERVER_ERROR', message });
      }

      await recordAicoSecurityEvent(ctx.serverDB, {
        action: 'platform.org.budget_sweep',
        actorAdminId: ctx.adminId,
        ipAddress: ctx.clientIp,
        metadata: {
          batchId: result.batchId,
          deferredCount: result.deferredCount,
          reclaimedCount: result.reclaimedCount,
          skippedCount: result.skippedCount,
          totalReclaimedMicroUsd: result.totalReclaimedMicroUsd,
        },
        organizationId: input.orgId,
        targetId: input.orgId,
        targetType: 'organization',
        userAgent: ctx.userAgent,
      });

      return serializeSweepResult(result);
    }),

  addManualUserCredit: platformProcedure
    .input(
      topupAmountInputSchema.extend({
        // Required — see addManualCredit above.
        description: z.string().trim().min(1).max(500),
        email: z.string().email().optional(),
        // FIN-013: required — see addManualCredit above.
        idempotencyKey: z.string().min(8).max(128),
        publicCode: z.string().min(1).max(32).optional(),
        userId: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let userId = input.userId;
      if (!userId && input.email) {
        userId = (await ctx.organizationModel.findUserIdByEmail(input.email)) ?? undefined;
      }
      if (!userId && input.publicCode) {
        userId = (await ctx.organizationModel.getUserIdByPublicCode(input.publicCode)) ?? undefined;
      }
      if (!userId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'userId, email, or publicCode of an existing user is required',
        });
      }

      let amountMicroUsd: number;
      let amountToman: number;
      let result: Awaited<ReturnType<typeof ctx.billingModel.manualCreditUser>>;

      try {
        const fxConfig = await ctx.billingModel.getFxConfig();
        const amounts = await resolveTopupAmount(input, { adminRate: fxConfig.tomanPerUsd });
        amountMicroUsd = amounts.amountMicroUsd;
        amountToman = amounts.amountToman;
        result = await ctx.billingModel.manualCreditUser({
          amountMicroUsd,
          amountToman,
          createdByAdminId: ctx.adminId,
          description: input.description,
          fxRateTomanPerUsd: amounts.fxRateTomanPerUsd,
          idempotencyKey: input.idempotencyKey,
          userId,
        });
      } catch (error) {
        // Nothing has been committed on this path, so reporting a failure here
        // is honest and a retry is safe.
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Failed to add user credit',
        });
      }

      // FIN-013: the money has moved. Nothing below may turn this into a reported
      // failure — an admin who sees "credit failed" over a committed credit
      // retries, and the retry credits the wallet a second time.
      try {
        // Push the new balance to the managed key so the user can spend it.
        await new AicoOpenRouterKeyService(ctx.serverDB).ensureUserKey(userId);
      } catch (error) {
        console.error('[aico] user credit committed but OpenRouter key push failed', error);
        // Without a retry the wallet stays funded behind a stale key limit until
        // an operator re-runs the credit by hand.
        await ctx.serverDB
          .insert(aicoKeyOutbox)
          .values({ action: 'sync_user_key', nextAttemptAt: new Date(), status: 'pending', userId })
          .catch((enqueueError) =>
            console.error('[aico] failed to enqueue sync_user_key retry', enqueueError),
          );
      }

      await recordAicoSecurityEvent(ctx.serverDB, {
        action: 'platform.credit.user_add',
        actorAdminId: ctx.adminId,
        ipAddress: ctx.clientIp,
        metadata: {
          amountMicroUsd,
          amountToman,
          idempotencyKey: input.idempotencyKey,
          targetUserId: userId,
          transactionId: result.transaction.id,
        },
        targetId: userId,
        targetType: 'user',
        userAgent: ctx.userAgent,
      }).catch((error) => console.error('[aico] failed to record credit audit event', error));

      return {
        transaction: {
          ...result.transaction,
          amountMicroUsd: String(result.transaction.amountMicroUsd ?? 0),
          amountToman: tomanString(result.transaction.amountToman ?? 0),
          amountUsd: microUsdToDecimalString(result.transaction.amountMicroUsd ?? 0),
        },
        userId,
        wallet: {
          balanceMicroUsd: String(result.wallet.balanceMicroUsd ?? 0),
          balanceToman: tomanString(result.wallet.balanceToman ?? 0),
          balanceUsd: microUsdToDecimalString(result.wallet.balanceMicroUsd ?? 0),
        },
      };
    }),

  addPlatformAdmin: platformProcedure
    .input(
      z.object({
        email: z.string().email(),
        name: z.string().max(120).optional(),
        password: z.string().min(8).max(64),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!meetsOperatorPasswordComplexity(input.password)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'PASSWORD_TOO_WEAK' });
      }
      const email = input.email.trim().toLowerCase();
      const existing = await ctx.adminModel.findByEmail(email);
      if (existing) {
        throw new TRPCError({ code: 'CONFLICT', message: 'OPERATOR_EMAIL_EXISTS' });
      }
      const row = await ctx.adminModel.create({
        email,
        name: input.name,
        passwordHash: await hashOperatorPassword(input.password),
      });
      await recordAicoSecurityEvent(ctx.serverDB, {
        action: 'platform.admin.add',
        actorAdminId: ctx.adminId,
        ipAddress: ctx.clientIp,
        metadata: { targetAdminId: row.id, targetEmail: email },
        targetId: row.id,
        targetType: 'platform_admin_user',
        userAgent: ctx.userAgent,
      });
      return { createdAt: row.createdAt, email: row.email, id: row.id, name: row.name };
    }),

  listPlatformAdmins: platformProcedure.query(async ({ ctx }) => {
    const rows = await ctx.adminModel.list();
    return rows.map((row) => ({
      banned: row.banned,
      createdAt: row.createdAt,
      email: row.email,
      id: row.id,
      name: row.name,
    }));
  }),

  getTrialConfig: platformProcedure.query(async ({ ctx }) => {
    const config = await ctx.billingModel.getTrialConfig();
    return {
      allowedModelIds: JSON.parse(config.allowedModelIds || '[]') as string[],
      durationDays: config.durationDays,
      enabled: config.enabled,
      maxRequests: config.maxRequests,
      trialBudgetMicroUsd: String(config.trialBudgetMicroUsd ?? 0),
      trialBudgetUsd: microUsdToDecimalString(config.trialBudgetMicroUsd ?? 0),
    };
  }),

  updateTrialConfig: platformProcedure
    .input(
      z.object({
        allowedModelIds: z.array(z.string()).optional(),
        durationDays: z.number().int().min(1).max(90).optional(),
        enabled: z.boolean().optional(),
        maxRequests: z.number().int().positive().nullable().optional(),
        trialBudgetUsd: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const trialBudgetMicroUsd =
        input.trialBudgetUsd !== undefined
          ? Number(usdDecimalStringToMicro(input.trialBudgetUsd))
          : undefined;
      const row = await ctx.billingModel.updateTrialConfig({
        allowedModelIds: input.allowedModelIds,
        durationDays: input.durationDays,
        enabled: input.enabled,
        maxRequests: input.maxRequests,
        trialBudgetMicroUsd,
      });
      return {
        allowedModelIds: JSON.parse(row.allowedModelIds || '[]') as string[],
        durationDays: row.durationDays,
        enabled: row.enabled,
        maxRequests: row.maxRequests,
        trialBudgetMicroUsd: String(row.trialBudgetMicroUsd ?? 0),
        trialBudgetUsd: microUsdToDecimalString(row.trialBudgetMicroUsd ?? 0),
      };
    }),

  getPlatformFinancials: platformProcedure
    .input(
      z
        .object({
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx }) => {
      const [txs, wallets, orgBalanceMicroUsd, totalOpenRouterCostMicroUsd, fxConfig] =
        await Promise.all([
          ctx.billingModel.listRecentTransactions(200),
          ctx.billingModel.listAllWallets(),
          ctx.organizationModel.getTotalWalletBalanceMicroUsd(),
          ctx.billingModel.sumUsageCostMicroUsd(),
          ctx.billingModel.getFxConfig(),
        ]);
      const fx = await getTomanPerUsd(fxConfig.tomanPerUsd);
      // Admin debits net out the grants they take back.
      const topups = txs.filter(
        (t) => t.type === 'topup' || t.type === 'manual_credit' || t.type === 'manual_debit',
      );
      const totalRevenueToman = topups.reduce((sum, t) => sum + Number(t.amountToman || 0), 0);
      const totalMicroCredited = Math.trunc(
        topups.reduce((sum, t) => sum + Number(t.amountMicroUsd || 0), 0),
      );
      const b2cBalanceMicroUsd = Math.trunc(
        wallets.reduce((sum, w) => sum + Number(w.balanceMicroUsd || 0), 0),
      );
      // SUM/driver may yield a float; FX is integer toman/USD from getTomanPerUsd.
      const costMicroUsd = Math.trunc(Number(totalOpenRouterCostMicroUsd) || 0);
      const fxRate = Math.round(fx.rate);
      // Approximate margin in toman using integer FX (floored).
      const costTomanEstimate = Number((BigInt(costMicroUsd) * BigInt(fxRate)) / 1_000_000n);
      const marginToman = totalRevenueToman - costTomanEstimate;

      return {
        b2bBalanceMicroUsd: String(Math.trunc(Number(orgBalanceMicroUsd) || 0)),
        b2bBalanceUsd: microUsdToDecimalString(Math.trunc(Number(orgBalanceMicroUsd) || 0)),
        b2cBalanceMicroUsd: String(b2cBalanceMicroUsd),
        b2cBalanceUsd: microUsdToDecimalString(b2cBalanceMicroUsd),
        b2cWalletCount: wallets.length,
        from: null as string | null,
        marginToman: String(Math.trunc(marginToman)),
        recentTransactions: txs.slice(0, 50).map((t) => ({
          actorEmail: t.actorAdminEmail || t.actorUserEmail || null,
          amountMicroUsd: String(t.amountMicroUsd ?? 0),
          amountToman: tomanString(t.amountToman ?? 0),
          amountUsd: microUsdToDecimalString(t.amountMicroUsd ?? 0),
          createdAt: t.createdAt.toISOString(),
          description: t.description,
          id: t.id,
          orgId: t.orgId,
          orgName: t.orgName,
          type: t.type,
          userEmail: t.userEmail,
          userId: t.userId,
        })),
        to: null as string | null,
        totalOpenRouterCostMicroUsd: String(costMicroUsd),
        totalOpenRouterCostUsd: microUsdToDecimalString(costMicroUsd),
        totalRevenueToman: String(Math.trunc(totalRevenueToman)),
        totalUsdCredited: microUsdToDecimalString(totalMicroCredited),
      };
    }),

  getMasterAccountStatus: platformProcedure.query(async ({ ctx }) => {
    const usageMicro = await ctx.billingModel.sumUsageCostMicroUsd();
    const status = await refreshAicoMasterMonitorState(ctx.serverDB, usageMicro);
    return {
      balanceUsd: null as string | null,
      belowThreshold: status.belowThreshold,
      isStub: status.isStub,
      lastSuccessfulCheckAt: status.lastSuccessfulCheckAt,
      status: status.status,
      thresholdUsd: status.thresholdUsd,
      totalObservedUsageUsd: status.totalObservedUsageUsd,
    };
  }),

  listUserWallets: platformProcedure.query(async ({ ctx }) => {
    const wallets = await ctx.billingModel.listAllWallets();
    const userIds = wallets.map((w) => w.userId);
    const [publicCodes, identities] = await Promise.all([
      ctx.organizationModel.getUserPublicCodesByIds(userIds),
      ctx.organizationModel.getUserIdentitiesByIds(userIds),
    ]);
    return wallets.map((w) => {
      const identity = identities.get(w.userId);
      return {
        balanceMicroUsd: String(w.balanceMicroUsd ?? 0),
        balanceToman: tomanString(w.balanceToman ?? 0),
        balanceUsd: microUsdToDecimalString(w.balanceMicroUsd ?? 0),
        /** What an admin debit may take back: balance less settled spend. */
        availableUsd: microUsdToDecimalString(
          Math.max(
            0,
            Number(w.balanceMicroUsd ?? 0) - Math.max(0, Number(w.settledUsageMicroUsd ?? 0)),
          ),
        ),
        banReason: identity?.banReason ?? null,
        banned: Boolean(identity?.banned),
        email: identity?.email ?? null,
        hasManagedKey: isSharedInferenceKey() || Boolean(w.openrouterKeyId),
        isActive: w.isActive,
        publicCode: publicCodes.get(w.userId) ?? null,
        userId: w.userId,
        username: identity?.username ?? null,
      };
    });
  }),

  deactivateUser: platformProcedure
    .input(
      z.object({
        reason: z.string().trim().min(1).max(500),
        userId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [user] = await ctx.serverDB
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });

      await ctx.serverDB
        .update(users)
        .set({
          banExpires: null,
          banReason: input.reason,
          banned: true,
        })
        .where(eq(users.id, input.userId));

      await ctx.serverDB.delete(session).where(eq(session.userId, input.userId));
      await revokeOIDCArtifactsByUserId(ctx.serverDB, input.userId);

      await ctx.serverDB
        .update(userWallets)
        .set({ isActive: false })
        .where(eq(userWallets.userId, input.userId));

      const keyService = new AicoOpenRouterKeyService(ctx.serverDB);
      await keyService.disableUserKey(input.userId);

      return { ok: true as const };
    }),

  reactivateUser: platformProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const [user] = await ctx.serverDB
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });

      await ctx.serverDB
        .update(users)
        .set({
          banExpires: null,
          banReason: null,
          banned: false,
        })
        .where(eq(users.id, input.userId));

      // FIN-015: flipping `isActive` alone left the balance parked in
      // `frozenMicroUsd` with no way back, so a "reactivated" user had no
      // spendable funds and a key that stayed disabled. Restore the money and
      // the capacity it bought, on the ledger, then push the limit.
      const restored = await ctx.billingModel.unfreezePersonalWallet({
        createdByAdminId: ctx.adminId,
        description: 'Restored on account reactivation',
        userId: input.userId,
      });

      const keyService = new AicoOpenRouterKeyService(ctx.serverDB);
      await keyService.ensureUserKey(input.userId);

      return {
        ok: true as const,
        restoredMicroUsd: String(restored?.transaction?.amountMicroUsd ?? 0),
      };
    }),

  getOpenRouterModelSyncStatus: platformProcedure.query(async ({ ctx }) => {
    return ctx.modelCatalogSync.getStatus();
  }),

  listOpenRouterModelSyncHistory: platformProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.modelCatalogSync.listHistory(input?.limit ?? 20);
    }),

  syncOpenRouterModels: platformProcedure.mutation(async ({ ctx }) => {
    const status = await ctx.modelCatalogSync.sync(`manual:${ctx.adminId}`);
    if (status.lastStatus !== 'success') {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: status.lastError || 'OpenRouter model sync failed',
      });
    }
    return status;
  }),
  /**
   * Take unspent money back from a personal wallet (e.g. an admin grant that
   * was never paid for). Ledgered as a negative `manual_debit`, then the live
   * key is shrunk so it cannot spend what the books no longer hold.
   */
  addManualUserDebit: platformProcedure
    .input(
      z.object({
        ...userTargetSchema,
        amountUsd: z.string().regex(/^\d+(\.\d{1,6})?$/),
        description: z.string().trim().min(1).max(500),
        idempotencyKey: z.string().min(8).max(128),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = await resolveTargetUserId(ctx.organizationModel, input);
      const amountMicroUsd = Number(usdDecimalStringToMicro(input.amountUsd));
      if (amountMicroUsd <= 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'AMOUNT_MUST_BE_POSITIVE' });
      }

      let result: Awaited<ReturnType<typeof ctx.billingModel.manualDebitUser>>;
      try {
        result = await ctx.billingModel.manualDebitUser({
          amountMicroUsd,
          createdByAdminId: ctx.adminId,
          description: input.description,
          idempotencyKey: input.idempotencyKey,
          userId,
        });
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Failed to debit user',
        });
      }

      // The debit is committed; from here on only the key can lag behind it.
      let key: ReissueOutcome | null = null;
      try {
        key = await new AicoOpenRouterKeyService(ctx.serverDB).shrinkUserKey(userId);
      } catch (error) {
        console.error('[aico] user debit committed but managed key shrink failed', error);
      }
      if (!key || key.status === 'ambiguous') {
        await ctx.serverDB
          .insert(aicoKeyOutbox)
          .values({ action: 'sync_user_key', nextAttemptAt: new Date(), status: 'pending', userId })
          .catch((enqueueError) =>
            console.error('[aico] failed to enqueue sync_user_key retry', enqueueError),
          );
      }

      await recordAicoSecurityEvent(ctx.serverDB, {
        action: 'platform.credit.user_debit',
        actorAdminId: ctx.adminId,
        ipAddress: ctx.clientIp,
        metadata: {
          amountMicroUsd,
          idempotencyKey: input.idempotencyKey,
          keyStatus: key?.status ?? 'failed',
          targetUserId: userId,
          transactionId: result.transaction.id,
        },
        targetId: userId,
        targetType: 'user',
        userAgent: ctx.userAgent,
      }).catch((error) => console.error('[aico] failed to record debit audit event', error));

      return {
        keyStatus: key?.status ?? 'queued',
        transactionId: result.transaction.id,
        userId,
        wallet: {
          availableUsd: microUsdToDecimalString(
            Math.max(0, result.wallet.balanceMicroUsd - result.wallet.settledUsageMicroUsd),
          ),
          balanceUsd: microUsdToDecimalString(result.wallet.balanceMicroUsd ?? 0),
        },
      };
    }),

  /**
   * Re-mint managed keys at their current headroom (e.g. after the provider's
   * secret prefix changed), retiring the old ones. Subjects still on a retired
   * provider are migrated instead. Sequential on purpose: CVC rate-limits.
   */
  reissueManagedKeys: platformProcedure
    .input(
      z.discriminatedUnion('scope', [
        z.object({ scope: z.literal('all') }),
        z.object({ scope: z.literal('user'), ...userTargetSchema }),
        z.object({ orgMemberId: z.string().min(1), scope: z.literal('member') }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      const keyService = new AicoOpenRouterKeyService(ctx.serverDB);
      const userIds: string[] = [];
      const memberIds: string[] = [];

      if (input.scope === 'user') {
        userIds.push(await resolveTargetUserId(ctx.organizationModel, input));
      } else if (input.scope === 'member') {
        memberIds.push(input.orgMemberId);
      } else {
        const wallets = await ctx.serverDB
          .select({ userId: userWallets.userId })
          .from(userWallets)
          .where(and(isNotNull(userWallets.openrouterKeyId), eq(userWallets.isActive, true)));
        userIds.push(...wallets.map((w) => w.userId));
        const budgets = await ctx.serverDB
          .select({ orgMemberId: memberBudgets.orgMemberId })
          .from(memberBudgets)
          .where(and(isNotNull(memberBudgets.openrouterKeyId), eq(memberBudgets.isActive, true)));
        memberIds.push(...budgets.map((b) => b.orgMemberId));
      }

      const results: {
        error?: string;
        id: string;
        kind: 'member' | 'user';
        outcome?: ReissueOutcome;
      }[] = [];
      for (const id of userIds) {
        try {
          results.push({ id, kind: 'user', outcome: await keyService.reissueUserKey(id) });
        } catch (error) {
          results.push({ error: (error as Error).message.slice(0, 200), id, kind: 'user' });
        }
      }
      for (const id of memberIds) {
        try {
          results.push({ id, kind: 'member', outcome: await keyService.reissueMemberKey(id) });
        } catch (error) {
          results.push({ error: (error as Error).message.slice(0, 200), id, kind: 'member' });
        }
      }

      await recordAicoSecurityEvent(ctx.serverDB, {
        action: 'platform.keys.reissue',
        actorAdminId: ctx.adminId,
        ipAddress: ctx.clientIp,
        metadata: {
          results: results.map((r) => ({
            error: r.error ?? null,
            id: r.id,
            kind: r.kind,
            status: r.outcome?.status ?? 'error',
          })),
          scope: input.scope,
        },
        targetId: input.scope === 'all' ? 'all' : (userIds[0] ?? memberIds[0]),
        targetType: input.scope === 'member' ? 'organization_member' : 'user',
        userAgent: ctx.userAgent,
      }).catch((error) => console.error('[aico] failed to record reissue audit event', error));

      return results.map((r) => ({
        error: r.error ?? null,
        id: r.id,
        kind: r.kind,
        status: r.outcome?.status ?? 'error',
      }));
    }),

  getReconciliationStatus: platformProcedure.query(async ({ ctx }) => {
    const runs = await listReconciliationRuns(ctx.serverDB, 20);
    return {
      history: runs.map((r) => ({
        finishedAt: r.finishedAt?.toISOString() ?? null,
        id: r.id,
        startedAt: r.startedAt.toISOString(),
        status: r.status,
        trigger: r.trigger,
      })),
      latest: runs[0] ? serializeReconciliationRun(runs[0]) : null,
    };
  }),

  /** Manual "Run now"; within a minute of the last run it returns that run. */
  runReconciliation: platformProcedure.mutation(async ({ ctx }) => {
    const run = await runReconciliation(ctx.serverDB, { adminId: ctx.adminId, trigger: 'manual' });
    return serializeReconciliationRun(run);
  }),
});

export type PlatformAdminRouter = typeof platformAdminRouter;
