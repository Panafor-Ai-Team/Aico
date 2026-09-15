import { AicoBillingModel } from '@/database/models/aicoBilling';
import { OrganizationModel } from '@/database/models/organization';
import { aicoKeyOutbox } from '@/database/schemas/aicoOrganization';
import type { LobeChatDatabase } from '@/database/type';
import {
  applyMultiplierMicroUsd,
  billedUsageFromCapacity,
  billedUsageFromRaw,
  blendedMultiplierBp,
  type BudgetPeriod,
  currentCycleLimitMicroUsd,
  DEFAULT_USAGE_MULTIPLIER_BP,
  hasValidManagedKeyId,
  isPeriodScopedBudget,
  isStaleManagedKeyId,
  keyLimitFromBilled,
  microUsdToDecimalString,
  openRouterUsdToMicroFloor,
  periodToOpenRouterLimitReset,
  rawUsageFromRemaining,
  rebaseCheckpoint,
  removeMultiplierMicroUsd,
  rotateCheckpointToNewKey,
  type UsageMultiplierCheckpoint,
} from '@/database/utils/aicoMoney';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import {
  createManagedProviderClient,
  type ManagedKeyCredential,
  type ManagedKeyInfo,
  type ManagedProviderClient,
  OpenRouterManagedProviderClient,
} from '@/server/services/managedProvider';

import type { OpenRouterKeyLimitReset, OpenRouterManagementClient } from './management';

const MISSING_PERIOD_COUNTER =
  'OpenRouter reported no period usage counter for this budget; usage held at the last settled value';

/**
 * Thrown into `getUserRemaining`'s degraded path when a provider that reports
 * only a key's *remaining* allowance has no recorded mint-time limit to measure
 * it against. Holding the last settled figure is right; reporting zero spend
 * would hand the wallet its whole balance back.
 */
const MANAGED_KEY_LIMIT_UNKNOWN =
  'Managed key has no recorded mint-time limit; spend cannot be derived from the remaining allowance';

const STALE_MANAGED_KEY =
  'Wallet carries a placeholder OpenRouter key id; usage cannot be read and is held at the last settled value';

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
  private _managed: ManagedProviderClient | null = null;
  private readonly decryptOnly: boolean;
  private readonly orgModel: OrganizationModel;
  private readonly billingModel: AicoBillingModel;

  /**
   * @param client Injected management client (tests). Pass `null` for decrypt-only
   *   usage so the OpenRouter management client is never constructed. A
   *   `ManagedProviderClient` may be passed instead to drive a provider other
   *   than OpenRouter — the only way to exercise the immutable-limit paths,
   *   since which provider is live is otherwise an env-level decision.
   */
  constructor(
    private readonly db: LobeChatDatabase,
    client?: OpenRouterManagementClient | ManagedProviderClient | null,
  ) {
    this.decryptOnly = client === null;
    if (client && 'capabilities' in client) {
      this._client = undefined;
      this._managed = client;
    } else {
      this._client = client;
    }
    this.orgModel = new OrganizationModel(db);
    this.billingModel = new AicoBillingModel(db);
  }

  /**
   * The managed provider behind this deployment.
   *
   * An injected OpenRouter client is *wrapped* in the adapter rather than used
   * directly, so the existing OpenRouter suites drive the same code path
   * production takes. If the adapter is faithful, those suites are the proof
   * that this migration left the OpenRouter path unchanged.
   */
  private get managed(): ManagedProviderClient {
    if (this.decryptOnly) {
      throw new Error('AicoOpenRouterKeyService is decrypt-only — management client unavailable');
    }
    if (this._managed) return this._managed;
    const created = this._client
      ? new OpenRouterManagedProviderClient(this._client)
      : createManagedProviderClient();
    this._managed = created;
    return created;
  }

  /**
   * How this provider addresses one of our keys.
   *
   * OpenRouter needs only the hash. CheapVibeCode authenticates *as* the key, so
   * the stored ciphertext is decrypted — but only when the provider actually
   * needs it, because `getUserRemaining` runs on the chat hot path and a decrypt
   * per request for a provider that ignores it is pure cost.
   */
  private managedCredential = async (row: {
    managedKeyLimitMicroUsd?: number | null;
    openrouterKeyCiphertext?: string | null;
    openrouterKeyId: string;
  }): Promise<ManagedKeyCredential> => {
    const apiKey =
      this.managed.capabilities.readKeyBySecret && row.openrouterKeyCiphertext
        ? ((await this.decryptKey(row.openrouterKeyCiphertext)) ?? undefined)
        : undefined;

    return {
      apiKey,
      hash: row.openrouterKeyId,
      limitUsd:
        row.managedKeyLimitMicroUsd == null
          ? undefined
          : microToOpenRouterLimitUsd(row.managedKeyLimitMicroUsd),
    };
  };

  /**
   * Raw spend recorded on the key itself, in micro-USD, or `null` when it cannot
   * be known. Never 0 on an unknown — that reads as "nothing spent".
   */
  private rawUsageOnKeyMicro = (
    row: { managedKeyLimitMicroUsd?: number | null },
    info: { limitRemaining?: number | null; usage?: number | null },
  ): number | null => {
    if (!this.managed.capabilities.readKeyBySecret) {
      // OpenRouter reports cumulative spend directly. A null counter is the
      // "this key could not be read" marker (`unreadableKeyInfo`) and must stay
      // unknown — zero would read as "nothing spent".
      if (info.usage == null) return null;
      return Number(openRouterUsdToMicroFloor(info.usage));
    }

    return rawUsageFromRemaining({
      limitMicroUsd: row.managedKeyLimitMicroUsd,
      remainingMicroUsd:
        info.limitRemaining == null ? null : Number(openRouterUsdToMicroFloor(info.limitRemaining)),
    });
  };

  private async encryptKey(plaintext: string): Promise<string> {
    const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
    return gateKeeper.encrypt(plaintext);
  }

  async decryptKey(encrypted: string): Promise<string | null> {
    const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
    const { plaintext, wasAuthentic } = await gateKeeper.decrypt(encrypted);
    return wasAuthentic ? plaintext : null;
  }

  /**
   * Best-effort retire a managed key before recreating (FIN-004).
   *
   * A provider with neither revoke nor update — CheapVibeCode has no `PATCH` or
   * `DELETE` on `/v1/keys` at all — cannot retire anything upstream. Retiring
   * then means ceasing to hand the key to a runtime, which is only safe because
   * managed keys never reach the browser (`disableBrowserRequest: true`) and
   * every request passes `AicoManagedPolicy.authorize()` first. The key is
   * recorded rather than silently forgotten so it can be revoked for real if the
   * provider ever ships the route.
   */
  private async retireManagedKey(hash: string): Promise<void> {
    const { revoke, updateLimit } = this.managed.capabilities;

    if (!revoke && !updateLimit) {
      console.warn('[aico] managed provider cannot retire keys upstream; key abandoned in place', {
        hash,
        providerId: this.managed.providerId,
      });
      await this.recordAbandonedKey(hash);
      return;
    }

    if (updateLimit && this.managed.updateKey) {
      try {
        await this.managed.updateKey({ disabled: true, hash });
      } catch (error) {
        console.warn('[aico] failed to disable stale managed key before recreate', error);
      }
    }

    if (revoke && this.managed.deleteKey) {
      try {
        await this.managed.deleteKey({ hash });
      } catch (error) {
        console.warn('[aico] failed to delete stale managed key before recreate', error);
      }
    }
  }

  /**
   * Record a key we stopped using but could not revoke.
   *
   * The row is the inventory: without it an abandoned key exists only in a log
   * line, and there would be nothing to drain if the provider ever ships a
   * delete route. Best-effort by design — failing to file the record must not
   * fail the operation that was retiring the key.
   */
  private recordAbandonedKey = async (hash: string): Promise<void> => {
    try {
      await this.db.insert(aicoKeyOutbox).values({
        action: 'revoke_managed_key',
        nextAttemptAt: new Date(),
        openrouterKeyId: hash,
        payload: { providerId: this.managed.providerId, reason: 'PROVIDER_HAS_NO_REVOKE' },
        status: 'pending',
      });
    } catch (error) {
      console.error('[aico] failed to record abandoned managed key', hash, error);
    }
  };

  /**
   * Delete a key upstream by id. Returns `false` when the provider has no route
   * for it, which the outbox reads as "still owed" rather than "done".
   */
  revokeManagedKeyById = async (hash: string): Promise<boolean> => {
    if (!this.managed.capabilities.revoke || !this.managed.deleteKey) return false;
    await this.managed.deleteKey({ hash });
    return true;
  };

  /**
   * Disable a key upstream, or report that the provider has no such operation.
   * Callers treat `null` as "nothing to do upstream" — the pre-flight gate is
   * what actually stops spend in that case.
   */
  private disableManagedKey = async (hash: string, keyProviderId?: string | null) => {
    // A key minted by the previous gateway is not ours to disable through this
    // one: the hash means nothing to it. It is also deliberately left alive so a
    // rollback is an env change rather than a restore, and it is unreachable
    // meanwhile — `AicoManagedPolicy.authorize()` refuses a foreign stamp.
    if (keyProviderId !== undefined && !this.isCurrentProviderKey(keyProviderId)) {
      console.warn('[aico] managed key belongs to another gateway; left untouched', {
        activeProvider: this.managed.providerId,
        hash,
        keyProvider: keyProviderId ?? 'openrouter',
      });
      return null;
    }
    if (!this.managed.capabilities.updateLimit || !this.managed.updateKey) {
      console.warn('[aico] managed provider cannot disable keys upstream; relying on the gate', {
        hash,
        providerId: this.managed.providerId,
      });
      return null;
    }
    return this.managed.updateKey({ disabled: true, hash });
  };

  /**
   * The raw OpenRouter counter that the member key's limit is enforced against.
   * Keys with a `limit_reset` are metered on the period counter, so the
   * multiplier checkpoint baseline must be period-scoped too — using lifetime
   * `info.usage` here would leave the baseline and the metered value in
   * different units and corrupt every subsequent conversion.
   *
   * Returns `null` when a period-scoped budget has no period counter to read.
   * OpenRouter genuinely omits `usage_daily`/`usage_weekly`/`usage_monthly` for
   * some key shapes, and substituting lifetime usage there is what corrupted
   * the checkpoint and pushed key limits far above the funded cap. Callers must
   * degrade rather than guess.
   */
  private rawMeteredUsageMicro = (
    budget: { managedKeyLimitMicroUsd?: number | null; period?: string | null },
    info: {
      limitRemaining?: number | null;
      usage?: number | null;
      usageDaily?: number | null;
      usageMonthly?: number | null;
      usageWeekly?: number | null;
    },
  ): number | null => {
    // A provider without native periodic limits has exactly one counter and it
    // never resets, so there is no period counter to choose between. The
    // checkpoint baseline is what makes the reading period-scoped — renewal
    // moves the baseline at each boundary — which makes the lifetime counter the
    // correct source whatever the budget's period.
    if (!this.managed.capabilities.nativePeriodicLimits) {
      return this.rawUsageOnKeyMicro(budget, info);
    }

    // A `total` budget has no `limit_reset`, so OpenRouter meters it on the
    // lifetime counter and that counter is the correct source.
    if (!isPeriodScopedBudget(budget.period)) {
      if (info.usage == null) return null;
      return Number(openRouterUsdToMicroFloor(info.usage));
    }

    const periodUsageUsd =
      budget.period === 'daily'
        ? info.usageDaily
        : budget.period === 'weekly'
          ? info.usageWeekly
          : info.usageMonthly;

    if (periodUsageUsd == null) return null;
    return Number(openRouterUsdToMicroFloor(periodUsageUsd));
  };

  /**
   * AICO-180 lazy rebase for member budgets. A budget is an allowance rather
   * than a payment, so it has no purchased capacity to fall back on: freeze
   * usage-to-date at the old rate and restart the meter at the new one.
   */
  private syncMemberCheckpoint = async (params: {
    checkpoint: UsageMultiplierCheckpoint;
    orgMemberId: string;
    rawUsage: number | null;
  }): Promise<{ bp: number; checkpoint: UsageMultiplierCheckpoint; degraded: boolean }> => {
    const bp = await this.billingModel.getUsageMultiplierBp();
    const currentBp = Number(params.checkpoint.checkpointMultiplierBp ?? bp);
    if (currentBp === bp) {
      return { bp, checkpoint: params.checkpoint, degraded: params.rawUsage === null };
    }

    // The rebase stamps the baseline with the raw counter, and the key limit is
    // derived from that baseline. Rebasing against an unknown counter is what
    // let a lifetime figure become the baseline of a daily budget and push a
    // limit orders of magnitude above the funded cap — hold the old checkpoint
    // (and its rate, since usage is still expressed in it) until a real counter
    // arrives.
    if (params.rawUsage === null) {
      return { bp: currentBp, checkpoint: params.checkpoint, degraded: true };
    }

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

    return { bp, checkpoint: { ...rebased, checkpointMultiplierBp: bp }, degraded: false };
  };

  /**
   * What a key that cannot be read reports: nothing, in every field.
   *
   * Every counter is `null` rather than `0`, which is the difference between
   * "we do not know what this key spent" and "this key spent nothing". The
   * callers' degraded branches hold the last settled figure on the former; the
   * latter would refund a member money they have already spent.
   */
  private unreadableKeyInfo = (hash: string): ManagedKeyInfo => ({
    disabled: false,
    hash,
    limit: null,
    limitRemaining: null,
    name: null,
    // Deliberately outside `ManagedKeyInfo`'s contract, which promises a number:
    // no provider returns this, only we do, and only here.
    usage: null as unknown as number,
    usageDaily: null,
    usageMonthly: null,
    usageWeekly: null,
  });

  /**
   * A member key's state, degraded to {@link unreadableKeyInfo} when the key was
   * minted by a gateway that is no longer active.
   *
   * Asking the live gateway about another gateway's key is not an informative
   * failure — it is an auth error, which on the settlement path would surface as
   * a failed renewal. Degrading here keeps a cutover from blocking every period
   * boundary until each member has been re-keyed.
   */
  private readMemberKeyInfo = async (budget: {
    managedKeyLimitMicroUsd?: number | null;
    managedKeyProviderId?: string | null;
    openrouterKeyCiphertext?: string | null;
    openrouterKeyId: string;
  }): Promise<ManagedKeyInfo> => {
    if (!this.isCurrentProviderKey(budget.managedKeyProviderId)) {
      console.warn('[aico] member key belongs to another gateway; usage held at the last value', {
        activeProvider: this.managed.providerId,
        keyId: budget.openrouterKeyId,
        keyProvider: budget.managedKeyProviderId ?? 'openrouter',
      });
      return this.unreadableKeyInfo(budget.openrouterKeyId);
    }

    return this.managed.getKey(
      await this.managedCredential({
        managedKeyLimitMicroUsd: budget.managedKeyLimitMicroUsd,
        openrouterKeyCiphertext: budget.openrouterKeyCiphertext,
        openrouterKeyId: budget.openrouterKeyId,
      }),
    );
  };

  /**
   * Read a managed key's state, or `null` when the provider would not answer.
   *
   * A failed read is not an empty key. Rotation is the one path that mints a
   * second spendable, unrevokable key, so it must never be taken on a guess.
   */
  private readManagedKey = async (row: {
    managedKeyLimitMicroUsd?: number | null;
    openrouterKeyCiphertext?: string | null;
    openrouterKeyId: string;
  }): Promise<{ rawUsedMicro: number; remainingMicro: number } | null> => {
    let info;
    try {
      info = await this.managed.getKey(await this.managedCredential(row));
    } catch (error) {
      console.warn('[aico] managed key read failed; keeping the existing key', {
        hash: row.openrouterKeyId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    const rawUsedMicro = this.rawUsageOnKeyMicro(row, info);
    if (rawUsedMicro === null || info.limitRemaining == null) {
      console.warn('[aico] managed key reports no usable limit; keeping the existing key', {
        hash: row.openrouterKeyId,
      });
      return null;
    }

    return {
      rawUsedMicro,
      remainingMicro: Number(openRouterUsdToMicroFloor(info.limitRemaining)),
    };
  };

  /**
   * The wallet path for a provider whose key limits are fixed at mint.
   *
   * A top-up cannot raise the existing key, so it is served by minting a
   * replacement sized to the capacity that is still unspent, and carrying the
   * retired key's spend forward in `rawUsageBeforeKeyMicroUsd` — without it the
   * wallet would forget what it had already spent and hand the money out twice.
   *
   * The key is kept whenever its own headroom still covers the unspent capacity.
   * That bounds two opposite risks at once: allowance stranded on a key that can
   * never be revoked, and a key minted larger than the wallet can actually spend.
   */
  private rotateUserKeyIfUnderfunded = async (params: {
    rawCapacityMicro: number;
    userId: string;
    wallet: {
      managedKeyLimitMicroUsd?: number | null;
      openrouterKeyCiphertext?: string | null;
      openrouterKeyId: string;
      rawUsageBeforeKeyMicroUsd?: number | null;
    };
  }) => {
    const keep = { created: false, keyId: params.wallet.openrouterKeyId };
    const read = await this.readManagedKey(params.wallet);
    if (!read) return keep;

    const usedBeforeMicro = Math.max(0, Number(params.wallet.rawUsageBeforeKeyMicroUsd ?? 0));
    const unspentMicro = Math.max(
      0,
      params.rawCapacityMicro - (usedBeforeMicro + read.rawUsedMicro),
    );

    // Still able to spend everything the wallet has left — nothing to mint. This
    // also covers an exhausted wallet, where `unspentMicro` is 0.
    if (read.remainingMicro >= unspentMicro) return keep;

    await this.retireManagedKey(params.wallet.openrouterKeyId);

    return this.createAndPersistUserKey({
      limitUsd: microToOpenRouterLimitUsd(unspentMicro),
      managedKeyLimitMicroUsd: unspentMicro,
      name: `aico-user-${params.userId}`,
      rawUsageBeforeKeyMicroUsd: usedBeforeMicro + read.rawUsedMicro,
      userId: params.userId,
    });
  };

  /**
   * The member-budget counterpart of {@link rotateUserKeyIfUnderfunded}.
   *
   * The replacement key's counter restarts at zero, so the checkpoint baseline
   * moves to zero with it and the usage it had already metered is frozen into
   * `billedUsageBeforeBaselineMicroUsd` at the rate it was billed at. That is
   * the same arithmetic a multiplier change performs, and it is why a member
   * budget needs no carried raw figure of its own.
   */
  /**
   * The member-budget counterpart of {@link migrateUserKeyToActiveProvider}.
   *
   * Identical in shape to {@link rotateMemberKeyIfUnderfunded}, except the final
   * raw counter of the retired key cannot be read — it lives on a gateway that
   * is no longer active. The checkpoint's own baseline is used instead, which is
   * the last raw figure a sync did manage to record, so usage already billed is
   * carried forward and only the unsynced tail is forgiven.
   *
   * The old key is left alive upstream so a rollback stays an env change.
   */
  private migrateMemberKeyToActiveProvider = async (params: {
    bp: number;
    budget: UsageMultiplierCheckpoint & {
      managedKeyProviderId?: string | null;
      openrouterKeyId?: string | null;
    };
    cycleCapMicro: number;
    orgMemberId: string;
    /** Last synced billed usage for this cycle, from `member_budgets`. */
    settledUsageMicroUsd?: number | null;
  }): Promise<{ created: boolean; keyId: string | null }> => {
    console.warn('[aico] member managed key belongs to another gateway; minting a replacement', {
      activeProvider: this.managed.providerId,
      keyProvider: params.budget.managedKeyProviderId ?? 'openrouter',
      orgMemberId: params.orgMemberId,
    });

    const rotated = rotateCheckpointToNewKey({
      checkpoint: params.budget,
      finalRawUsage: Math.max(0, Number(params.budget.usageBaselineMicroUsd ?? 0)),
    });

    // The checkpoint's baseline only moves when the multiplier changes, so on a
    // steady rate it lags the key's real counter. The last synced cycle usage
    // does not, and it is already billed — take whichever is larger, because the
    // one thing this must not do is bill less than what was settled.
    const billedBeforeMicro = Math.max(
      rotated.billedUsageBeforeBaselineMicroUsd,
      Math.max(0, Number(params.settledUsageMicroUsd ?? 0)),
    );

    const nextLimitMicro = keyLimitFromBilled({
      balance: params.cycleCapMicro,
      baselineRaw: rotated.usageBaselineMicroUsd,
      billedBefore: billedBeforeMicro,
      bp: params.bp,
    });
    // The cycle is already spent out. Minting would buy nothing, and the
    // pre-flight gate refuses the request anyway.
    if (nextLimitMicro <= 0) return { created: false, keyId: null };

    const created = await this.managed.createKey({
      // The gateway we are moving to may have no native periodic reset, and the
      // checkpoint this rotation just wrote is what accounts the period either
      // way. Asking for a reset here would double-count the boundary.
      limitReset: null,
      limitUsd: microToOpenRouterLimitUsd(nextLimitMicro),
      name: `aico-member-${params.orgMemberId}`,
    });

    try {
      const encrypted = await this.encryptKey(created.key);
      await this.orgModel.updateMemberOpenRouterKey({
        billedUsageBeforeBaselineMicroUsd: billedBeforeMicro,
        ciphertext: encrypted,
        keyId: created.hash,
        managedKeyLimitMicroUsd: this.managed.capabilities.readKeyBySecret ? nextLimitMicro : null,
        managedKeyProviderId: this.managed.providerId,
        orgMemberId: params.orgMemberId,
        usageBaselineMicroUsd: rotated.usageBaselineMicroUsd,
      });
    } catch (error) {
      // OR-002: the key exists upstream and can spend; it must not outlive a
      // failed persist.
      console.error('[aico] member managed key persist failed; retiring orphan key', error);
      await this.retireManagedKey(created.hash);
      throw error;
    }

    return { created: true, keyId: created.hash };
  };

  private rotateMemberKeyIfUnderfunded = async (params: {
    bp: number;
    budget: UsageMultiplierCheckpoint & {
      managedKeyLimitMicroUsd?: number | null;
      openrouterKeyCiphertext?: string | null;
      openrouterKeyId: string;
    };
    cycleCapMicro: number;
    orgMemberId: string;
  }) => {
    const keep = { created: false, keyId: params.budget.openrouterKeyId };
    const read = await this.readManagedKey(params.budget);
    if (!read) return keep;

    const rotated = rotateCheckpointToNewKey({
      checkpoint: params.budget,
      finalRawUsage: read.rawUsedMicro,
    });

    // What a replacement would be minted with: the raw headroom left in this
    // cycle once everything already billed is taken off the funded cap.
    const nextLimitMicro = keyLimitFromBilled({
      balance: params.cycleCapMicro,
      baselineRaw: rotated.usageBaselineMicroUsd,
      billedBefore: rotated.billedUsageBeforeBaselineMicroUsd,
      bp: params.bp,
    });

    // The key still covers the rest of the cycle — including an exhausted cycle,
    // where the headroom is zero and a new key would buy nothing.
    if (read.remainingMicro >= nextLimitMicro) return keep;

    await this.retireManagedKey(params.budget.openrouterKeyId);

    const created = await this.managed.createKey({
      // A provider reaching this branch has no native periodic reset; asking for
      // one would be a lie the checkpoint then has to work around.
      limitReset: null,
      limitUsd: microToOpenRouterLimitUsd(nextLimitMicro),
      name: `aico-member-${params.orgMemberId}`,
    });

    try {
      const encrypted = await this.encryptKey(created.key);
      await this.orgModel.updateMemberOpenRouterKey({
        billedUsageBeforeBaselineMicroUsd: rotated.billedUsageBeforeBaselineMicroUsd,
        ciphertext: encrypted,
        keyId: created.hash,
        managedKeyLimitMicroUsd: nextLimitMicro,
        managedKeyProviderId: this.managed.providerId,
        orgMemberId: params.orgMemberId,
        usageBaselineMicroUsd: rotated.usageBaselineMicroUsd,
      });
    } catch (error) {
      // OR-002: the key exists upstream and can spend; it must not outlive a
      // failed persist.
      console.error('[aico] member managed key persist failed; retiring orphan key', error);
      await this.retireManagedKey(created.hash);
      throw error;
    }

    return { created: true, keyId: created.hash };
  };

  /**
   * Whether a stored key belongs to the gateway that is currently active.
   *
   * A key minted by the previous provider is not a usable key: its secret means
   * nothing to the new gateway, so reusing it would fail every request in a way
   * that looks like an outage. Treating it as absent instead mints a replacement
   * sized from the subject's *billed* balance — no money revalued — and leaves
   * the old key alive upstream so flipping `AICO_MANAGED_PROVIDER` back is a
   * working rollback rather than a restore.
   *
   * A null stamp is a row written before migration 0154 backfilled it, which can
   * only be OpenRouter — it was the sole managed provider until then.
   */
  private isCurrentProviderKey = (stamp: string | null | undefined): boolean =>
    (stamp ?? 'openrouter') === this.managed.providerId;

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

      const hasLiveKey =
        wallet.openrouterKeyId &&
        wallet.openrouterKeyCiphertext &&
        !isStaleManagedKeyId(wallet.openrouterKeyId) &&
        this.isCurrentProviderKey(wallet.managedKeyProviderId);

      // A key from the previous gateway must not fall through to the mint path
      // below: that one sizes the key at the wallet's *whole* capacity, which
      // after a cutover would hand back everything already spent.
      if (
        !hasLiveKey &&
        hasValidManagedKeyId(wallet.openrouterKeyId) &&
        !this.isCurrentProviderKey(wallet.managedKeyProviderId)
      ) {
        const trial = await this.billingModel.isTrialActive(userId).catch(() => false);
        const trialBudgetMicroUsd = trial
          ? Number((await this.billingModel.getTrialConfig()).trialBudgetMicroUsd)
          : 0;
        return this.migrateUserKeyToActiveProvider({ trialBudgetMicroUsd, userId, wallet });
      }

      if (hasLiveKey && !this.managed.capabilities.updateLimit) {
        // The key's limit is fixed at mint, so a top-up is served by minting a
        // replacement rather than raising this one.
        return this.rotateUserKeyIfUnderfunded({
          rawCapacityMicro: limitMicro,
          userId,
          wallet: {
            managedKeyLimitMicroUsd: wallet.managedKeyLimitMicroUsd,
            openrouterKeyCiphertext: wallet.openrouterKeyCiphertext,
            openrouterKeyId: wallet.openrouterKeyId as string,
            rawUsageBeforeKeyMicroUsd: wallet.rawUsageBeforeKeyMicroUsd,
          },
        });
      }

      if (hasLiveKey && this.managed.updateKey) {
        try {
          await this.managed.updateKey({
            disabled: balanceMicro <= 0,
            hash: wallet.openrouterKeyId as string,
            limitReset: null,
            limitUsd: Math.max(limitUsd, 0),
          });
          return { created: false, keyId: wallet.openrouterKeyId };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/OpenRouter Management API (?:403|404)/.test(message)) throw error;
          console.warn('[aico] user OpenRouter key update failed; recreating', message);
          await this.retireManagedKey(wallet.openrouterKeyId as string);
        }
      }

      if (balanceMicro <= 0) {
        return { created: false, keyId: null };
      }

      return this.createAndPersistUserKey({
        limitUsd,
        // Only meaningful to a provider that reports remaining rather than
        // usage; the OpenRouter path leaves the column alone.
        managedKeyLimitMicroUsd: this.managed.capabilities.readKeyBySecret ? limitMicro : undefined,
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
        if (this.isCurrentProviderKey(wallet.managedKeyProviderId)) {
          return { created: false, keyId: wallet.openrouterKeyId };
        }
        // Re-activating a trial after a provider cutover: the grant is what is
        // left of it, not a fresh one.
        return this.migrateUserKeyToActiveProvider({
          trialBudgetMicroUsd: budgetMicro,
          userId,
          wallet,
        });
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
        managedKeyLimitMicroUsd: this.managed.capabilities.readKeyBySecret ? limitMicro : undefined,
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

      const hasLiveKey =
        budget.openrouterKeyId &&
        budget.openrouterKeyCiphertext &&
        !isStaleManagedKeyId(budget.openrouterKeyId) &&
        this.isCurrentProviderKey(budget.managedKeyProviderId);

      // Same reason as the personal path: the mint at the bottom of this method
      // adds `usageBaselineMicroUsd` back into the limit, which is only correct
      // for a key whose counter already carries that baseline. A replacement on
      // a different gateway starts at zero, so it needs the rotation treatment.
      if (
        !hasLiveKey &&
        hasValidManagedKeyId(budget.openrouterKeyId) &&
        !this.isCurrentProviderKey(budget.managedKeyProviderId)
      ) {
        if (shouldDisable) return { created: false, keyId: null };
        return this.migrateMemberKeyToActiveProvider({
          bp,
          budget,
          cycleCapMicro,
          orgMemberId,
          settledUsageMicroUsd: budget.settledUsageMicroUsd,
        });
      }

      if (hasLiveKey && !this.managed.capabilities.updateLimit) {
        // No upstream lever exists: the limit cannot be raised, and the key
        // cannot be disabled. `shouldDisable` is honoured by the pre-flight gate
        // in `AicoManagedPolicy.authorize()`, which refuses an inactive or
        // unfunded budget before the key is ever handed to a runtime.
        if (shouldDisable) return { created: false, keyId: budget.openrouterKeyId };

        return this.rotateMemberKeyIfUnderfunded({
          bp,
          budget: {
            billedUsageBeforeBaselineMicroUsd: budget.billedUsageBeforeBaselineMicroUsd,
            checkpointMultiplierBp: budget.checkpointMultiplierBp,
            managedKeyLimitMicroUsd: budget.managedKeyLimitMicroUsd,
            openrouterKeyCiphertext: budget.openrouterKeyCiphertext,
            openrouterKeyId: budget.openrouterKeyId as string,
            usageBaselineMicroUsd: budget.usageBaselineMicroUsd,
          },
          cycleCapMicro,
          orgMemberId,
        });
      }

      if (hasLiveKey && this.managed.updateKey) {
        try {
          await this.managed.updateKey({
            disabled: shouldDisable,
            hash: budget.openrouterKeyId as string,
            limitReset,
            limitUsd: Math.max(limitUsd, 0),
          });
          return { created: false, keyId: budget.openrouterKeyId };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/OpenRouter Management API (?:403|404)/.test(message)) throw error;
          console.warn('[aico] member OpenRouter key update failed; recreating', message);
          await this.retireManagedKey(budget.openrouterKeyId as string);
        }
      }

      if (cycleCapMicro <= 0 || shouldDisable) {
        return { created: false, keyId: null };
      }

      const created = await this.managed.createKey({
        limitReset,
        limitUsd,
        name: `aico-member-${orgMemberId}`,
      });
      try {
        const encrypted = await this.encryptKey(created.key);
        await this.orgModel.updateMemberOpenRouterKey({
          ciphertext: encrypted,
          keyId: created.hash,
          managedKeyLimitMicroUsd: this.managed.capabilities.readKeyBySecret
            ? limitMicro
            : undefined,
          managedKeyProviderId: this.managed.providerId,
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
   * Replace a personal key that belongs to the gateway we have switched away
   * from (`AICO_MANAGED_PROVIDER` flipped).
   *
   * The old key cannot be read: `GET /v1/balance` and `GET /keys/{hash}` each
   * only answer for their own gateway, so whatever was spent after the last
   * successful sync is unmeasurable. The wallet's last settled usage is
   * therefore the figure the replacement is sized against — it under-bills by at
   * most one sync interval, which is the right direction to err when the
   * alternative is charging a user for spend we cannot evidence.
   *
   * The old key is deliberately left alive upstream. Rolling the env var back
   * has to be an env change, not a restore, and the key is unreachable while the
   * other gateway is inactive: managed keys never leave the server, and every
   * request passes `AicoManagedPolicy.authorize()`, which refuses a key whose
   * provider stamp is not the active one.
   */
  private migrateUserKeyToActiveProvider = async (params: {
    /** Billed allowance of an active trial, when the wallet itself is unfunded. */
    trialBudgetMicroUsd?: number;
    userId: string;
    wallet: {
      balanceMicroUsd?: number | string | null;
      managedKeyProviderId?: string | null;
      openrouterKeyId?: string | null;
      rawCapacityMicroUsd?: number | string | null;
      settledUsageMicroUsd?: number | string | null;
    };
  }): Promise<{ created: boolean; keyId: string | null }> => {
    console.warn('[aico] personal managed key belongs to another gateway; minting a replacement', {
      activeProvider: this.managed.providerId,
      keyProvider: params.wallet.managedKeyProviderId ?? 'openrouter',
      userId: params.userId,
    });

    const balanceMicro = Math.max(0, Math.trunc(Number(params.wallet.balanceMicroUsd ?? 0)));
    const settledMicro = Math.max(0, Math.trunc(Number(params.wallet.settledUsageMicroUsd ?? 0)));
    const bp = await this.billingModel.getUsageMultiplierBp();

    // A funded wallet is sized from the capacity its own top-ups bought; a trial
    // wallet has no capacity at all (the trial budget is a billed grant, never a
    // deposit), so it is sized from the grant at the current rate.
    const isTrialOnly = balanceMicro <= 0;
    const billedEntitlement = isTrialOnly
      ? Math.max(0, Math.trunc(Number(params.trialBudgetMicroUsd ?? 0)))
      : balanceMicro;
    if (billedEntitlement <= 0) return { created: false, keyId: null };

    const rawCapacityMicro = isTrialOnly
      ? removeMultiplierMicroUsd(billedEntitlement, bp)
      : Math.max(0, Math.trunc(Number(params.wallet.rawCapacityMicroUsd ?? 0)));

    // Raw spend the old key is known to have made, expressed in the units of the
    // capacity this wallet bought. `billedUsageFromCapacity` is the forward map
    // `getUserRemaining` uses; this is its inverse, through the same blend, so
    // the two agree on what is left.
    const rawUsedMicro = Math.min(
      rawCapacityMicro,
      removeMultiplierMicroUsd(
        Math.min(settledMicro, billedEntitlement),
        blendedMultiplierBp({
          balanceMicroUsd: billedEntitlement,
          fallbackBp: bp,
          rawCapacityMicroUsd: rawCapacityMicro,
        }),
      ),
    );
    const nextLimitMicro = Math.max(0, rawCapacityMicro - rawUsedMicro);
    if (nextLimitMicro <= 0) return { created: false, keyId: null };

    return this.createAndPersistUserKey({
      limitUsd: microToOpenRouterLimitUsd(nextLimitMicro),
      managedKeyLimitMicroUsd: this.managed.capabilities.readKeyBySecret
        ? nextLimitMicro
        : undefined,
      name: isTrialOnly ? `aico-trial-${params.userId}` : `aico-user-${params.userId}`,
      rawUsageBeforeKeyMicroUsd: rawUsedMicro,
      userId: params.userId,
    });
  };

  /**
   * OR-002: create on OpenRouter then persist ciphertext. If DB write fails after
   * createKey, immediately retire the orphan so it cannot spend against the master account.
   */
  private async createAndPersistUserKey(params: {
    limitUsd: number;
    /** Mint-time raw limit, for providers that report only what is left. */
    managedKeyLimitMicroUsd?: number;
    name: string;
    /** Raw spend carried over from the key this one replaces. */
    rawUsageBeforeKeyMicroUsd?: number;
    userId: string;
  }): Promise<{ created: true; keyId: string }> {
    const created = await this.managed.createKey({
      limitReset: null,
      limitUsd: params.limitUsd,
      name: params.name,
    });
    try {
      const encrypted = await this.encryptKey(created.key);
      await this.billingModel.updateUserOpenRouterKey({
        ciphertext: encrypted,
        keyId: created.hash,
        // One statement on `user_wallets`: the new key id, the limit it was
        // minted with and the spend carried over from its predecessor all land
        // together or not at all. The limit is always written — a fresh key
        // must not inherit the recorded limit of the one it replaces.
        managedKeyLimitMicroUsd: params.managedKeyLimitMicroUsd ?? null,
        managedKeyProviderId: this.managed.providerId,
        ...(params.rawUsageBeforeKeyMicroUsd == null
          ? {}
          : { rawUsageBeforeKeyMicroUsd: params.rawUsageBeforeKeyMicroUsd }),
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
    return this.disableManagedKey(budget.openrouterKeyId, budget.managedKeyProviderId);
  };

  disableUserKey = async (userId: string) => {
    const wallet = await this.billingModel.getUserWallet(userId);
    if (!wallet?.openrouterKeyId) return null;
    return this.disableManagedKey(wallet.openrouterKeyId, wallet.managedKeyProviderId);
  };

  disableAllOrgMemberKeys = async (orgId: string) => {
    const members = await this.orgModel.listMembers(orgId);
    return Promise.allSettled(members.map((m) => this.disableMemberKey(m.id)));
  };

  /**
   * Read-only half of {@link reclaimMemberKey}: what a reclaim *would* return,
   * without disabling the key. Used by the org budget sweep preview, which must
   * never leave a key disabled for a sweep the manager then cancels.
   * Requires orgId so a foreign orgMemberId cannot read another tenant's key.
   */
  peekMemberRemaining = async (params: {
    orgId: string;
    orgMemberId: string;
  }): Promise<{
    keyId: string;
    /** Gateway that minted the key, so a caller does not disable a foreign one. */
    keyProviderId: string | null;
    remainingMicroUsd: number;
    usageMicroUsd: number;
  } | null> => {
    const budget = await this.orgModel.getMemberBudgetForOrg(params);
    if (!budget?.openrouterKeyId) return null;

    const info = await this.readMemberKeyInfo({
      managedKeyLimitMicroUsd: budget.managedKeyLimitMicroUsd,
      managedKeyProviderId: budget.managedKeyProviderId,
      openrouterKeyCiphertext: budget.openrouterKeyCiphertext,
      openrouterKeyId: budget.openrouterKeyId,
    });
    // AICO-180: OpenRouter reports raw spend; the org wallet this refunds into
    // is denominated in billed micro-USD, so convert before returning. Read the
    // same counter the key limit is enforced against, since the checkpoint
    // baseline is expressed in those units.
    const bp = await this.billingModel.getUsageMultiplierBp();
    const rawUsage = this.rawMeteredUsageMicro(budget, info);
    // With no period counter the last settled figure is the most we can honestly
    // claim was spent; lifetime usage would over-state it and under-refund the org.
    const usageMicro =
      rawUsage === null
        ? Math.max(0, Number(budget.settledUsageMicroUsd ?? 0))
        : billedUsageFromRaw({
            baselineRaw: Number(budget.usageBaselineMicroUsd ?? 0),
            billedBefore: Number(budget.billedUsageBeforeBaselineMicroUsd ?? 0),
            bp: Number(budget.checkpointMultiplierBp ?? bp),
            rawUsage,
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

    // Pending next-period reservation was never spendable on the OR key (FIN-001) —
    // reclaim it from the wallet reservation in full.
    return {
      keyId: budget.openrouterKeyId,
      keyProviderId: budget.managedKeyProviderId ?? null,
      remainingMicroUsd: Math.max(0, remainingFromOr) + pendingHeld,
      usageMicroUsd: usageMicro,
    };
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
    const peeked = await this.peekMemberRemaining(params);
    if (!peeked) return null;

    await this.disableManagedKey(peeked.keyId, peeked.keyProviderId);

    return { remainingMicroUsd: peeked.remainingMicroUsd, usageMicroUsd: peeked.usageMicroUsd };
  };

  /**
   * Period-aware usage read for dashboards / billing sources.
   * Never writes lifetime `info.usage` into `settledUsageMicroUsd`.
   */
  private computeCycleUsageFromKeyInfo = (
    budget: UsageMultiplierCheckpoint & {
      managedKeyLimitMicroUsd?: number | null;
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

    // A counter that never resets cannot look "reset", and a key's remaining
    // allowance spans the whole funded life of that key rather than this cycle —
    // so neither the `looksReset` guard nor the `limitRemaining` branch below
    // applies. The baseline-offset reading is the whole story here, and renewal
    // is what moves the baseline on to the next cycle.
    if (!this.managed.capabilities.nativePeriodicLimits) {
      const rawUsage = this.rawUsageOnKeyMicro(budget, info);

      // No usable counter: hold the last settled figure rather than claim the
      // cycle is untouched.
      const usage =
        rawUsage === null
          ? Math.min(currentCycle, priorSettled)
          : Math.min(currentCycle, Math.max(0, toBilledUsage(rawUsage)));

      return { remainingMicroUsd: Math.max(0, currentCycle - usage), usageMicroUsd: usage };
    }

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
    } else if (isPeriodScopedBudget(budget.period)) {
      // Neither `limit_remaining` nor the period counter is available. Lifetime
      // `info.usage` spans earlier cycles, so converting it here saturates
      // usage at the cap and strands the member for the rest of the period —
      // which is also what the docstring above promises never to do. Hold the
      // last settled figure until a real counter arrives.
      usageMicro = Math.min(currentCycle, priorSettled);
      remainingMicro = Math.max(0, currentCycle - usageMicro);
    } else if (info.usage == null) {
      // Nothing was readable at all — an unreadable key, not an unused one.
      usageMicro = Math.min(currentCycle, priorSettled);
      remainingMicro = Math.max(0, currentCycle - usageMicro);
    } else {
      // A `total` budget is metered on the lifetime counter, so it is correct here.
      usageMicro = toBilledUsage(Number(openRouterUsdToMicroFloor(info.usage)));
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
  /**
   * Where the next cycle's checkpoint baseline has to start.
   *
   * A provider with native periodic limits resets the key's counter at the
   * boundary, so the new cycle meters from zero. A provider without one carries
   * the same counter across the boundary, and zeroing the baseline there would
   * re-meter every request the closing cycle already settled — the member would
   * open the new cycle already over cap.
   */
  private nextCycleBaselineMicro = (
    budget: { managedKeyLimitMicroUsd?: number | null; usageBaselineMicroUsd?: number | null },
    rawUsage: number | null,
  ): number => {
    if (this.managed.capabilities.nativePeriodicLimits) return 0;
    if (rawUsage !== null) return Math.max(0, rawUsage);

    // The counter could not be read. Assuming the key is spent gives the member
    // a free cycle bounded by whatever that key can still spend upstream, and
    // the next successful read rotates onto a fresh key with an exact baseline.
    // Assuming the opposite would bill the closing cycle's usage a second time.
    if (budget.managedKeyLimitMicroUsd != null) return Number(budget.managedKeyLimitMicroUsd);
    return Math.max(0, Number(budget.usageBaselineMicroUsd ?? 0));
  };

  settleMemberPeriod = async (
    orgMemberId: string,
  ): Promise<{
    /** What `usageBaselineMicroUsd` must become when the period rolls over. */
    nextCycleBaselineMicroUsd: number;
    remainingMicroUsd: number;
    usageMicroUsd: number;
  } | null> => {
    const budget = await this.orgModel.getMemberBudget(orgMemberId);
    if (!budget?.openrouterKeyId) return null;

    const info = await this.readMemberKeyInfo({
      managedKeyLimitMicroUsd: budget.managedKeyLimitMicroUsd,
      managedKeyProviderId: budget.managedKeyProviderId,
      openrouterKeyCiphertext: budget.openrouterKeyCiphertext,
      openrouterKeyId: budget.openrouterKeyId,
    });
    const rawUsage = this.rawMeteredUsageMicro(budget, info);
    const { bp, checkpoint, degraded } = await this.syncMemberCheckpoint({
      checkpoint: budget,
      orgMemberId,
      rawUsage,
    });
    const { remainingMicroUsd, usageMicroUsd } = this.computeCycleUsageFromKeyInfo(
      { ...budget, ...checkpoint },
      info,
      bp,
    );

    await this.orgModel.syncMemberBudgetUsage({
      orgMemberId,
      settledUsageMicroUsd: usageMicroUsd,
      syncError: degraded ? MISSING_PERIOD_COUNTER : null,
      syncStatus: degraded ? 'degraded' : 'synced',
    });

    return {
      nextCycleBaselineMicroUsd: this.nextCycleBaselineMicro(
        { ...budget, ...checkpoint },
        rawUsage,
      ),
      remainingMicroUsd,
      usageMicroUsd,
    };
  };

  /**
   * @deprecated Prefer explicit billing context via AicoManagedPolicy.
   * Kept only for transitional non-managed diagnostics — returns null always
   * so silent first-match billing cannot occur.
   */
  resolveUserApiKey = async (_userId: string): Promise<string | null> => null;

  /**
   * Spendable remaining for a personal wallet, derived from the managed key's
   * OpenRouter usage.
   *
   * FIN-018: every failure here used to collapse to "you have spent nothing" —
   * the full deposited balance, `usageMicroUsd: null`, and no log. Five distinct
   * paths produced that, and none was distinguishable from a genuinely unspent
   * wallet. Now the reading carries `usageKnown`, a degraded read holds the last
   * persisted usage instead of forgetting it, and the failure is logged.
   *
   * `persist` is opt-in because the chat hot path calls this per request and
   * must not take a write; dashboards pass it so the fallback figure stays
   * fresh and operators can see the sync status.
   */
  getUserRemaining = async (
    userId: string,
    options?: { persist?: boolean },
  ): Promise<{
    remainingMicroUsd: number;
    /** Last known billed usage. `null` only when nothing has ever been metered. */
    usageMicroUsd: number | null;
    /** False when the figure is a fallback, not a live reading. Never present it as current. */
    usageKnown: boolean;
  }> => {
    const wallet = await this.billingModel.getOrCreateUserWallet(userId);
    const balanceMicroUsd = Number(wallet.balanceMicroUsd ?? 0);
    const lastSettledMicroUsd = Math.max(0, Number(wallet.settledUsageMicroUsd ?? 0));

    // No key was ever provisioned, so no spend was ever possible through us.
    // That is a known zero, not an unknown — the wallet is fully spendable.
    if (!wallet.openrouterKeyId) {
      return {
        remainingMicroUsd: Math.max(0, balanceMicroUsd),
        usageKnown: true,
        usageMicroUsd: 0,
      };
    }

    // A `mock_` hash cannot authenticate upstream, so usage is unreadable —
    // and the wallet may well have spent against a real key before the hash
    // was replaced. Unknown, not zero. A key belonging to a gateway that is no
    // longer active is unreadable for the same reason: its secret means nothing
    // to the current one, and whatever was spent on it still happened.
    if (
      isStaleManagedKeyId(wallet.openrouterKeyId) ||
      !this.isCurrentProviderKey(wallet.managedKeyProviderId)
    ) {
      console.warn('[aico] personal remaining is degraded: key is stale or from another provider', {
        keyId: wallet.openrouterKeyId,
        keyProvider: wallet.managedKeyProviderId ?? 'openrouter',
        userId,
      });
      if (options?.persist) {
        await this.billingModel
          .syncUserWalletUsage({ syncError: STALE_MANAGED_KEY, syncStatus: 'degraded', userId })
          .catch(() => null);
      }
      return {
        remainingMicroUsd: Math.max(0, balanceMicroUsd - lastSettledMicroUsd),
        usageKnown: false,
        usageMicroUsd: lastSettledMicroUsd,
      };
    }

    try {
      const info = await this.managed.getKey(
        await this.managedCredential({
          managedKeyLimitMicroUsd: wallet.managedKeyLimitMicroUsd,
          openrouterKeyCiphertext: wallet.openrouterKeyCiphertext,
          openrouterKeyId: wallet.openrouterKeyId,
        }),
      );

      // Spend on keys this wallet has already retired. Always 0 unless a
      // rotation happened, which only an immutable-limit provider forces.
      const usedBeforeMicro = Math.max(0, Number(wallet.rawUsageBeforeKeyMicroUsd ?? 0));
      const usedOnKeyMicro = this.rawUsageOnKeyMicro(wallet, info);
      // Unknown spend is not zero spend. Fall into the degraded path below,
      // which holds the last settled figure and says plainly that it is stale.
      if (usedOnKeyMicro === null) throw new Error(MANAGED_KEY_LIMIT_UNKNOWN);
      const rawUsageMicro = usedBeforeMicro + usedOnKeyMicro;

      // AICO-184: bill raw usage at the blend of the rates this wallet's
      // top-ups actually bought at, not at whatever the platform rate is now.
      const rawCapacityMicro = Number(wallet.rawCapacityMicroUsd ?? 0);
      const usageMicro = billedUsageFromCapacity({
        balanceMicroUsd,
        fallbackBp: await this.billingModel.getUsageMultiplierBp(),
        rawCapacityMicroUsd: rawCapacityMicro,
        rawUsageMicroUsd: rawUsageMicro,
      });
      if (options?.persist) {
        await this.billingModel
          .syncUserWalletUsage({
            settledUsageMicroUsd: usageMicro,
            syncStatus: 'synced',
            userId,
          })
          .catch(() => null);
      }

      // `balance − usage` is exact here: both sides are cumulative and usage
      // reaches the balance precisely when raw usage reaches capacity.
      return {
        remainingMicroUsd: Math.max(0, balanceMicroUsd - usageMicro),
        usageKnown: true,
        usageMicroUsd: usageMicro,
      };
    } catch (error) {
      // Do not report the full balance as spendable. Hold the last figure we
      // could trust and say plainly that it is stale.
      console.warn('[aico] personal remaining is degraded: OpenRouter key read failed', {
        error,
        keyId: wallet.openrouterKeyId,
        userId,
      });
      if (options?.persist) {
        await this.billingModel
          .syncUserWalletUsage({
            syncError: error instanceof Error ? error.message : String(error),
            syncStatus: 'degraded',
            userId,
          })
          .catch(() => null);
      }
      return {
        remainingMicroUsd: Math.max(0, balanceMicroUsd - lastSettledMicroUsd),
        usageKnown: false,
        usageMicroUsd: lastSettledMicroUsd,
      };
    }
  };

  /**
   * Period-aware sync for billing dashboards — prefers cycle counters over
   * lifetime OpenRouter usage so remaining balance stays accurate.
   */
  syncMemberCycleUsage = async (orgMemberId: string) => {
    const budget = await this.orgModel.getMemberBudget(orgMemberId);
    if (
      !budget?.openrouterKeyId ||
      isStaleManagedKeyId(budget.openrouterKeyId) ||
      // Reading a key minted by the previous gateway would authenticate against
      // the wrong API; `ensureMemberKey` replaces it on the next pass.
      !this.isCurrentProviderKey(budget.managedKeyProviderId)
    ) {
      return null;
    }

    const info = await this.readMemberKeyInfo({
      managedKeyLimitMicroUsd: budget.managedKeyLimitMicroUsd,
      managedKeyProviderId: budget.managedKeyProviderId,
      openrouterKeyCiphertext: budget.openrouterKeyCiphertext,
      openrouterKeyId: budget.openrouterKeyId,
    });
    const { bp, checkpoint, degraded } = await this.syncMemberCheckpoint({
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
      syncError: degraded ? MISSING_PERIOD_COUNTER : null,
      syncStatus: degraded ? 'degraded' : 'synced',
    });
  };

  /** @deprecated Prefer `syncMemberCycleUsage`. */
  syncMemberUsage = async (orgMemberId: string) => this.syncMemberCycleUsage(orgMemberId);
}
