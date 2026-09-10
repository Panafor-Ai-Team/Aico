import { AicoBillingModel } from '@/database/models/aicoBilling';
import { OrganizationModel } from '@/database/models/organization';
import type { LobeChatDatabase } from '@/database/type';
import {
  applyMultiplierMicroUsd,
  billedUsageFromCapacity,
  billedUsageFromRaw,
  type BudgetPeriod,
  currentCycleLimitMicroUsd,
  DEFAULT_USAGE_MULTIPLIER_BP,
  isStaleManagedKeyId,
  keyLimitFromBilled,
  microUsdToDecimalString,
  openRouterUsdToMicroFloor,
  periodToOpenRouterLimitReset,
  rebaseCheckpoint,
  type UsageMultiplierCheckpoint,
} from '@/database/utils/aicoMoney';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';

import {
  createOpenRouterManagementClient,
  type OpenRouterKeyLimitReset,
  type OpenRouterManagementClient,
} from './management';

const locks = new Map<string, Promise<unknown>>();
const runExclusive = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const tail = locks.get(key) ?? Promise.resolve();
  const result = tail.then(fn, fn);
  locks.set(
    key,
    result.catch(() => undefined),
  );
  return result;
};

const microToOpenRouterLimitUsd = (micro: number): number => Number(microUsdToDecimalString(micro));

/**
 * Provisions / updates OpenRouter keys for B2C wallets and B2B member budgets.
 * Plaintext keys are encrypted with KeyVaultsGateKeeper and never returned to SPA.
 */
export class AicoOpenRouterKeyService {
  private readonly _client: OpenRouterManagementClient | null | undefined;
  private readonly decryptOnly: boolean;
  private readonly orgModel: OrganizationModel;
  private readonly billingModel: AicoBillingModel;

  /**
   * @param client Injected management client (tests). Pass `null` for decrypt-only
   *   usage so the OpenRouter management client is never constructed.
   */
  constructor(
    private readonly db: LobeChatDatabase,
    client?: OpenRouterManagementClient | null,
  ) {
    this.decryptOnly = client === null;
    this._client = client;
    this.orgModel = new OrganizationModel(db);
    this.billingModel = new AicoBillingModel(db);
  }

  private get client(): OpenRouterManagementClient {
    if (this.decryptOnly) {
      throw new Error('AicoOpenRouterKeyService is decrypt-only — management client unavailable');
    }
    if (this._client) return this._client;
    const created = createOpenRouterManagementClient();
    // Lazily memoise onto the private field; cast through `unknown` because a
    // private member never structurally overlaps a public one.
    (this as unknown as { _client: OpenRouterManagementClient })._client = created;
    return created;
  }

  private async encryptKey(plaintext: string): Promise<string> {
    const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
    return gateKeeper.encrypt(plaintext);
  }

  async decryptKey(encrypted: string): Promise<string | null> {
    const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
    const { plaintext, wasAuthentic } = await gateKeeper.decrypt(encrypted);
    return wasAuthentic ? plaintext : null;
  }

  /** Best-effort retire a managed key before recreating (FIN-004). */
  private async retireManagedKey(hash: string): Promise<void> {
    try {
      await this.client.updateKey({ disabled: true, hash });
    } catch (error) {
      console.warn('[aico] failed to disable stale OpenRouter key before recreate', error);
    }
    try {
      await this.client.deleteKey(hash);
    } catch (error) {
      console.warn('[aico] failed to delete stale OpenRouter key before recreate', error);
    }
  }

  /**
   * The raw OpenRouter counter that the member key's limit is enforced against.
   * Keys with a `limit_reset` are metered on the period counter, so the
   * multiplier checkpoint baseline must be period-scoped too — using lifetime
   * `info.usage` here would leave the baseline and the metered value in
   * different units and corrupt every subsequent conversion.
   */
  private rawMeteredUsageMicro = (
    budget: { period?: string | null },
    info: {
      usage?: number | null;
      usageDaily?: number | null;
      usageMonthly?: number | null;
      usageWeekly?: number | null;
    },
  ): number => {
    const periodUsageUsd =
      budget.period === 'daily'
        ? info.usageDaily
        : budget.period === 'weekly'
          ? info.usageWeekly
          : budget.period === 'monthly'
            ? info.usageMonthly
            : null;
    const source = periodUsageUsd ?? info.usage ?? 0;
    return Number(openRouterUsdToMicroFloor(source));
  };

  /**
   * AICO-180 lazy rebase for member budgets. A budget is an allowance rather
   * than a payment, so it has no purchased capacity to fall back on: freeze
   * usage-to-date at the old rate and restart the meter at the new one.
   */
  private syncMemberCheckpoint = async (params: {
    checkpoint: UsageMultiplierCheckpoint;
    orgMemberId: string;
    rawUsage: number;
  }): Promise<{ bp: number; checkpoint: UsageMultiplierCheckpoint }> => {
    const bp = await this.billingModel.getUsageMultiplierBp();
    const currentBp = Number(params.checkpoint.checkpointMultiplierBp ?? bp);
    if (currentBp === bp) return { bp, checkpoint: params.checkpoint };

    const rebased = rebaseCheckpoint({
      checkpoint: params.checkpoint,
      nextBp: bp,
      rawUsage: params.rawUsage,
    });
    await this.orgModel.updateMemberBudgetCheckpoint({
      billedUsageBeforeBaselineMicroUsd: rebased.billedUsageBeforeBaselineMicroUsd,
      checkpointMultiplierBp: bp,
      orgMemberId: params.orgMemberId,
      usageBaselineMicroUsd: rebased.usageBaselineMicroUsd,
    });

    return { bp, checkpoint: { ...rebased, checkpointMultiplierBp: bp } };
  };

  ensureUserKey = async (userId: string) => {
    return runExclusive(`user-key:${userId}`, async () => {
      const wallet = await this.billingModel.getOrCreateUserWallet(userId);
      const balanceMicro = Number(wallet.balanceMicroUsd ?? 0);

      // AICO-184: every top-up already converted itself to raw spend at the
      // rate in force when it was paid, so the key limit is simply the
      // capacity bought. The current multiplier does not enter here — that is
      // what stops a rate change from revaluing money already paid.
      const limitMicro = Number(wallet.rawCapacityMicroUsd ?? 0);
      const limitUsd = microToOpenRouterLimitUsd(limitMicro);

      if (
        wallet.openrouterKeyId &&
        wallet.openrouterKeyCiphertext &&
        !isStaleManagedKeyId(wallet.openrouterKeyId)
      ) {
        try {
          await this.client.updateKey({
            disabled: balanceMicro <= 0,
            hash: wallet.openrouterKeyId,
            limitReset: null,
            limitUsd: Math.max(limitUsd, 0),
          });
          return { created: false, keyId: wallet.openrouterKeyId };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/OpenRouter Management API (?:403|404)/.test(message)) throw error;
          console.warn('[aico] user OpenRouter key update failed; recreating', message);
          await this.retireManagedKey(wallet.openrouterKeyId);
        }
      }

      if (balanceMicro <= 0) {
        return { created: false, keyId: null };
      }

      return this.createAndPersistUserKey({
        limitUsd,
        name: `aico-user-${userId}`,
        userId,
      });
    });
  };

  ensureTrialKey = async (userId: string, budgetMicroUsd: number) => {
    const budgetMicro =
      Number.isFinite(budgetMicroUsd) && budgetMicroUsd > 0 ? Math.trunc(budgetMicroUsd) : 0;
    if (budgetMicro <= 0) {
      return { created: false, keyId: null };
    }

    return runExclusive(`user-key:${userId}`, async () => {
      const wallet = await this.billingModel.getOrCreateUserWallet(userId);

      if (wallet.openrouterKeyId && wallet.openrouterKeyCiphertext) {
        return { created: false, keyId: wallet.openrouterKeyId };
      }

      // AICO-180: the trial budget is a billed figure like a wallet balance, so
      // a $1 trial buys $1/M of raw spend.
      const bp = await this.billingModel.getUsageMultiplierBp();
      const limitMicro = keyLimitFromBilled({
        balance: budgetMicro,
        baselineRaw: 0,
        billedBefore: 0,
        bp,
      });

      return this.createAndPersistUserKey({
        limitUsd: microToOpenRouterLimitUsd(limitMicro),
        name: `aico-trial-${userId}`,
        userId,
      });
    });
  };

  /**
   * Ensure member OpenRouter key matches funded period amount + limit_reset.
   * Never creates a key when reserved/period amount ≤ 0.
   */
  ensureMemberKey = async (orgMemberId: string) => {
    return runExclusive(`member-key:${orgMemberId}`, async () => {
      const budget = await this.orgModel.getMemberBudget(orgMemberId);
      if (!budget) throw new Error('BUDGET_NOT_FOUND');

      const period = (budget.period || 'total') as BudgetPeriod;
      const limitReset: OpenRouterKeyLimitReset = periodToOpenRouterLimitReset(period);
      // FIN-001: never use reservedMicroUsd here — it may include pending next-period funds.
      const cycleCapMicro = currentCycleLimitMicroUsd(budget);
      // AICO-180: the funded cap is billed; the key limit is the raw spend it buys.
      const bp = await this.billingModel.getUsageMultiplierBp();
      const limitMicro = keyLimitFromBilled({
        balance: cycleCapMicro,
        baselineRaw: Number(budget.usageBaselineMicroUsd ?? 0),
        billedBefore: Number(budget.billedUsageBeforeBaselineMicroUsd ?? 0),
        bp,
      });
      const limitUsd = microToOpenRouterLimitUsd(limitMicro);
      const shouldDisable =
        !budget.isActive ||
        cycleCapMicro <= 0 ||
        budget.renewalStatus === 'renewal_pending' ||
        budget.renewalStatus === 'renewal_failed';

      if (
        budget.openrouterKeyId &&
        budget.openrouterKeyCiphertext &&
        !isStaleManagedKeyId(budget.openrouterKeyId)
      ) {
        try {
          await this.client.updateKey({
            disabled: shouldDisable,
            hash: budget.openrouterKeyId,
            limitReset,
            limitUsd: Math.max(limitUsd, 0),
          });
          return { created: false, keyId: budget.openrouterKeyId };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/OpenRouter Management API (?:403|404)/.test(message)) throw error;
          console.warn('[aico] member OpenRouter key update failed; recreating', message);
          await this.retireManagedKey(budget.openrouterKeyId);
        }
      }

      if (cycleCapMicro <= 0 || shouldDisable) {
        return { created: false, keyId: null };
      }

      const created = await this.client.createKey({
        limitReset,
        limitUsd,
        name: `aico-member-${orgMemberId}`,
      });
      try {
        const encrypted = await this.encryptKey(created.key);
        await this.orgModel.updateMemberOpenRouterKey({
          ciphertext: encrypted,
          keyId: created.hash,
          orgMemberId,
        });
      } catch (error) {
        // OR-002: OR create succeeded but DB persist failed — retire orphan spendable key.
        console.error('[aico] member OpenRouter key persist failed; retiring orphan key', error);
        await this.retireManagedKey(created.hash);
        throw error;
      }
      return { created: true, keyId: created.hash };
    });
  };

  /**
   * OR-002: create on OpenRouter then persist ciphertext. If DB write fails after
   * createKey, immediately retire the orphan so it cannot spend against the master account.
   */
  private async createAndPersistUserKey(params: {
    limitUsd: number;
    name: string;
    userId: string;
  }): Promise<{ created: true; keyId: string }> {
    const created = await this.client.createKey({
      limitReset: null,
      limitUsd: params.limitUsd,
      name: params.name,
    });
    try {
      const encrypted = await this.encryptKey(created.key);
      await this.billingModel.updateUserOpenRouterKey({
        ciphertext: encrypted,
        keyId: created.hash,
        userId: params.userId,
      });
    } catch (error) {
      console.error('[aico] user OpenRouter key persist failed; retiring orphan key', error);
      await this.retireManagedKey(created.hash);
      throw error;
    }
    return { created: true, keyId: created.hash };
  }

  disableMemberKey = async (orgMemberId: string) => {
    const budget = await this.orgModel.getMemberBudget(orgMemberId);
    if (!budget?.openrouterKeyId) return null;
    return this.client.updateKey({ disabled: true, hash: budget.openrouterKeyId });
  };

  disableUserKey = async (userId: string) => {
    const wallet = await this.billingModel.getUserWallet(userId);
    if (!wallet?.openrouterKeyId) return null;
    return this.client.updateKey({ disabled: true, hash: wallet.openrouterKeyId });
  };

  disableAllOrgMemberKeys = async (orgId: string) => {
    const members = await this.orgModel.listMembers(orgId);
    return Promise.allSettled(members.map((m) => this.disableMemberKey(m.id)));
  };

  /**
   * Authoritative settlement helpers for removal / period close.
   * Returns micro-USD usage/remaining from OpenRouter (floored).
   * Requires orgId so a foreign orgMemberId cannot disable another tenant's key.
   */
  reclaimMemberKey = async (params: {
    orgId: string;
    orgMemberId: string;
  }): Promise<{ remainingMicroUsd: number; usageMicroUsd: number } | null> => {
    const budget = await this.orgModel.getMemberBudgetForOrg(params);
    if (!budget?.openrouterKeyId) return null;

    const info = await this.client.getKey(budget.openrouterKeyId);
    // AICO-180: OpenRouter reports raw spend; the org wallet this refunds into
    // is denominated in billed micro-USD, so convert before returning. Read the
    // same counter the key limit is enforced against, since the checkpoint
    // baseline is expressed in those units.
    const bp = await this.billingModel.getUsageMultiplierBp();
    const usageMicro = billedUsageFromRaw({
      baselineRaw: Number(budget.usageBaselineMicroUsd ?? 0),
      billedBefore: Number(budget.billedUsageBeforeBaselineMicroUsd ?? 0),
      bp: Number(budget.checkpointMultiplierBp ?? bp),
      rawUsage: this.rawMeteredUsageMicro(budget, info),
    });
    const currentCycle = currentCycleLimitMicroUsd(budget);
    const pendingHeld = Math.max(0, Number(budget.pendingPeriodAmountMicroUsd ?? 0));
    const remainingFromOr =
      info.limitRemaining == null
        ? Math.max(0, currentCycle - usageMicro)
        : applyMultiplierMicroUsd(
            Number(openRouterUsdToMicroFloor(info.limitRemaining)),
            Number(budget.checkpointMultiplierBp ?? bp),
          );

    await this.client.updateKey({ disabled: true, hash: budget.openrouterKeyId });

    // Pending next-period reservation was never spendable on the OR key (FIN-001) —
    // reclaim it from the wallet reservation in full.
    return {
      remainingMicroUsd: Math.max(0, remainingFromOr) + pendingHeld,
      usageMicroUsd: usageMicro,
    };
  };

  /**
   * Period-aware usage read for dashboards / billing sources.
   * Never writes lifetime `info.usage` into `settledUsageMicroUsd`.
   */
  private computeCycleUsageFromKeyInfo = (
    budget: UsageMultiplierCheckpoint & {
      period?: string | null;
      settledUsageMicroUsd?: number | null;
    },
    info: {
      limit?: number | null;
      limitRemaining?: number | null;
      usage?: number | null;
      usageDaily?: number | null;
      usageMonthly?: number | null;
      usageWeekly?: number | null;
    },
    /** AICO-180 multiplier in force; defaults to the budget's own checkpoint rate. */
    multiplierBp?: number,
  ): { remainingMicroUsd: number; usageMicroUsd: number } => {
    const currentCycle = currentCycleLimitMicroUsd(budget);
    const priorSettled = Math.max(0, Number(budget.settledUsageMicroUsd ?? 0));

    // AICO-180: everything OpenRouter reports is RAW spend, while `currentCycle`
    // and `priorSettled` are BILLED. Convert before any comparison or clamp —
    // the `looksReset` heuristic below compares the two directly, so converting
    // late would silently misfire the cycle-boundary over-refund guard.
    const bp = multiplierBp ?? Number(budget.checkpointMultiplierBp ?? DEFAULT_USAGE_MULTIPLIER_BP);
    const baselineRaw = Number(budget.usageBaselineMicroUsd ?? 0);
    const billedBefore = Number(budget.billedUsageBeforeBaselineMicroUsd ?? 0);
    const toBilledUsage = (rawUsage: number) =>
      billedUsageFromRaw({ baselineRaw, billedBefore, bp, rawUsage });

    const periodUsageUsd =
      budget.period === 'daily'
        ? info.usageDaily
        : budget.period === 'weekly'
          ? info.usageWeekly
          : budget.period === 'monthly'
            ? info.usageMonthly
            : null;

    const periodUsageMicro =
      periodUsageUsd == null
        ? null
        : toBilledUsage(Number(openRouterUsdToMicroFloor(periodUsageUsd)));

    const limitMicro =
      info.limit == null
        ? currentCycle
        : toBilledUsage(Number(openRouterUsdToMicroFloor(info.limit)));
    // Remaining is a pure delta (limit − usage), so it scales by M directly
    // rather than through the baseline-offset usage formula.
    const remainingFromOr =
      info.limitRemaining == null
        ? null
        : applyMultiplierMicroUsd(Number(openRouterUsdToMicroFloor(info.limitRemaining)), bp);

    const looksReset =
      priorSettled > 0 &&
      ((periodUsageMicro != null && periodUsageMicro < priorSettled / 2) ||
        (remainingFromOr != null &&
          limitMicro > 0 &&
          remainingFromOr >= Math.floor(limitMicro * 0.95) &&
          priorSettled > Math.floor(currentCycle * 0.05)));

    let usageMicro: number;
    let remainingMicro: number;

    if (looksReset) {
      usageMicro = Math.min(priorSettled, currentCycle);
      remainingMicro = Math.max(0, currentCycle - usageMicro);
    } else if (remainingFromOr != null) {
      remainingMicro = Math.max(0, remainingFromOr);
      usageMicro = Math.max(0, currentCycle - remainingMicro);
      if (periodUsageMicro != null) {
        usageMicro = Math.min(currentCycle, Math.max(usageMicro, periodUsageMicro));
        remainingMicro = Math.max(0, currentCycle - usageMicro);
      }
    } else if (periodUsageMicro != null) {
      usageMicro = Math.min(currentCycle, Math.max(0, periodUsageMicro));
      remainingMicro = Math.max(0, currentCycle - usageMicro);
    } else {
      usageMicro = toBilledUsage(Number(openRouterUsdToMicroFloor(info.usage ?? 0)));
      usageMicro = Math.min(currentCycle, Math.max(0, usageMicro));
      remainingMicro = Math.max(0, currentCycle - usageMicro);
    }

    return { remainingMicroUsd: remainingMicro, usageMicroUsd: usageMicro };
  };

  /**
   * Authoritative period settlement read for renewal.
   * Does not itself enable/disable the OpenRouter key — renewal already
   * disables keys at the start of `renewal_pending` and re-enables only after
   * the next period is funded.
   *
   * Boundary safety (AICO-140): prefer `limit_remaining` and period usage
   * counters. If OpenRouter has already reset for the new cycle (period usage
   * near 0 / remaining ≈ full limit while Aico still has closing-cycle
   * settledUsage), use Aico's last settled usage so we do not over-refund.
   */
  settleMemberPeriod = async (
    orgMemberId: string,
  ): Promise<{ remainingMicroUsd: number; usageMicroUsd: number } | null> => {
    const budget = await this.orgModel.getMemberBudget(orgMemberId);
    if (!budget?.openrouterKeyId) return null;

    const info = await this.client.getKey(budget.openrouterKeyId);
    const { bp, checkpoint } = await this.syncMemberCheckpoint({
      checkpoint: budget,
      orgMemberId,
      rawUsage: this.rawMeteredUsageMicro(budget, info),
    });
    const { remainingMicroUsd, usageMicroUsd } = this.computeCycleUsageFromKeyInfo(
      { ...budget, ...checkpoint },
      info,
      bp,
    );

    await this.orgModel.syncMemberBudgetUsage({
      orgMemberId,
      settledUsageMicroUsd: usageMicroUsd,
    });

    return { remainingMicroUsd, usageMicroUsd };
  };

  /**
   * @deprecated Prefer explicit billing context via AicoManagedPolicy.
   * Kept only for transitional non-managed diagnostics — returns null always
   * so silent first-match billing cannot occur.
   */
  resolveUserApiKey = async (_userId: string): Promise<string | null> => null;

  /**
   * Spendable remaining for a personal wallet. Prefers OpenRouter
   * `limit_remaining` (enforced spend left on the managed key); falls back to
   * deposited `balanceMicroUsd` when no key exists or OR is unreachable.
   */
  getUserRemaining = async (
    userId: string,
  ): Promise<{ remainingMicroUsd: number; usageMicroUsd: number | null }> => {
    const wallet = await this.billingModel.getOrCreateUserWallet(userId);
    const balanceMicroUsd = Number(wallet.balanceMicroUsd ?? 0);

    if (!wallet.openrouterKeyId || isStaleManagedKeyId(wallet.openrouterKeyId)) {
      return { remainingMicroUsd: Math.max(0, balanceMicroUsd), usageMicroUsd: null };
    }

    try {
      const info = await this.client.getKey(wallet.openrouterKeyId);
      const rawUsageMicro = Number(openRouterUsdToMicroFloor(info.usage));

      // AICO-184: bill raw usage at the blend of the rates this wallet's
      // top-ups actually bought at, not at whatever the platform rate is now.
      const rawCapacityMicro = Number(wallet.rawCapacityMicroUsd ?? 0);
      const usageMicro = billedUsageFromCapacity({
        balanceMicroUsd,
        fallbackBp: await this.billingModel.getUsageMultiplierBp(),
        rawCapacityMicroUsd: rawCapacityMicro,
        rawUsageMicroUsd: rawUsageMicro,
      });
      // `balance − usage` is exact here: both sides are cumulative and usage
      // reaches the balance precisely when raw usage reaches capacity.
      return {
        remainingMicroUsd: Math.max(0, balanceMicroUsd - usageMicro),
        usageMicroUsd: usageMicro,
      };
    } catch {
      return { remainingMicroUsd: Math.max(0, balanceMicroUsd), usageMicroUsd: null };
    }
  };

  /**
   * Period-aware sync for billing dashboards — prefers cycle counters over
   * lifetime OpenRouter usage so remaining balance stays accurate.
   */
  syncMemberCycleUsage = async (orgMemberId: string) => {
    const budget = await this.orgModel.getMemberBudget(orgMemberId);
    if (!budget?.openrouterKeyId || isStaleManagedKeyId(budget.openrouterKeyId)) return null;

    const info = await this.client.getKey(budget.openrouterKeyId);
    const { bp, checkpoint } = await this.syncMemberCheckpoint({
      checkpoint: budget,
      orgMemberId,
      rawUsage: this.rawMeteredUsageMicro(budget, info),
    });
    const { usageMicroUsd } = this.computeCycleUsageFromKeyInfo(
      { ...budget, ...checkpoint },
      info,
      bp,
    );
    return this.orgModel.syncMemberBudgetUsage({
      orgMemberId,
      settledUsageMicroUsd: usageMicroUsd,
    });
  };

  /** @deprecated Prefer `syncMemberCycleUsage`. */
  syncMemberUsage = async (orgMemberId: string) => this.syncMemberCycleUsage(orgMemberId);
}
