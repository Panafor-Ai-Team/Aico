/**
 * Phase 2 — the managed-provider paths that only exist because CheapVibeCode's
 * keys are immutable, non-resetting and unrevokable.
 *
 * Every assertion here is about money that cannot be taken back: a key minted
 * on a guess can never be revoked, a forgotten carry-over re-grants spend that
 * was already used, and a baseline zeroed at a period boundary re-meters a
 * cycle that was already settled.
 */
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import { OrganizationModel } from '@/database/models/organization';
import { users } from '@/database/schemas';
import {
  aicoKeyOutbox,
  memberBudgets,
  organizationMembers,
  organizations,
  organizationTeamMembers,
  organizationTeams,
  userWallets,
  walletTransactions,
} from '@/database/schemas/aicoOrganization';
import { processKeyOutbox } from '@/server/services/aico/renewalScheduler';
import type { ManagedProviderClient } from '@/server/services/managedProvider';
import { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

// Read at call time by `KeyVaultsGateKeeper`, but the modules below are hoisted
// above ordinary statements — so the stub has to be hoisted with them.
vi.hoisted(() => {
  process.env.KEY_VAULTS_SECRET ||= 'LA7n9k3JdEcbSgml2sxfw+4TV1AzaaFU5+R176aQz4s=';
});

const usd = (n: number) => Math.round(n * 1_000_000);

/**
 * A CheapVibeCode-shaped provider: one lifetime counter per key, no reset, no
 * update, no delete, and state readable only by authenticating as the key.
 */
class ImmutableProvider implements ManagedProviderClient {
  readonly capabilities = {
    nativePeriodicLimits: false,
    readKeyBySecret: true,
    revoke: false,
    updateLimit: false,
  };

  readonly providerId = 'cheapvibecode' as const;

  /** hash → mint-time limit in USD and spend against it. */
  keys = new Map<string, { limitUsd: number; name: string; usedUsd: number }>();
  /** Secrets handed to `getKey`, to prove the ciphertext is actually decrypted. */
  seenApiKeys: (string | undefined)[] = [];
  readFails = false;
  createFails = false;

  private seq = 0;

  createKey: ManagedProviderClient['createKey'] = async (params) => {
    if (this.createFails) throw new Error('CheapVibeCode API 409: Conflict');
    const hash = `cvc_${++this.seq}`;
    this.keys.set(hash, { limitUsd: params.limitUsd, name: params.name, usedUsd: 0 });
    return {
      disabled: false,
      hash,
      key: `sk-cvc-fake-${hash}`,
      limit: params.limitUsd,
      limitRemaining: params.limitUsd,
      name: params.name,
      usage: 0,
      usageDaily: null,
      usageMonthly: null,
      usageWeekly: null,
    };
  };

  getKey: ManagedProviderClient['getKey'] = async (credential) => {
    this.seenApiKeys.push(credential.apiKey);
    if (this.readFails) throw new Error('CheapVibeCode API 429');
    const row = this.keys.get(credential.hash);
    if (!row) throw new Error(`unknown key ${credential.hash}`);
    return {
      disabled: false,
      hash: credential.hash,
      // The real provider reports only what is left; `limit` comes from the
      // caller's own record of the mint, which is the whole point of the column.
      limit: credential.limitUsd ?? null,
      limitRemaining: Math.max(0, row.limitUsd - row.usedUsd),
      name: row.name,
      usage: 0,
      usageDaily: null,
      usageMonthly: null,
      usageWeekly: null,
    };
  };

  getAccountBalanceUsd: ManagedProviderClient['getAccountBalanceUsd'] = async () => 1000;

  /** Simulate upstream spend against a key, in USD. */
  spend(hash: string, amountUsd: number) {
    const row = this.keys.get(hash);
    if (!row) throw new Error(`unknown key ${hash}`);
    row.usedUsd += amountUsd;
  }
}

/**
 * CheapVibeCode since its 2026-09 reseller API: limits still fixed at mint, but
 * a key can be frozen and deleted — addressed by its secret, never its id.
 */
class RevocableImmutableProvider extends ImmutableProvider {
  override readonly capabilities = {
    nativePeriodicLimits: false,
    readKeyBySecret: true,
    revoke: true,
    updateLimit: false,
  };

  frozen = new Set<string>();

  private hashOf = (apiKey: string | undefined) => {
    const hash = apiKey?.replace('sk-cvc-fake-', '');
    if (!hash || !this.keys.has(hash)) throw new Error('CheapVibeCode API 404: Not Found');
    return hash;
  };

  deleteKey: NonNullable<ManagedProviderClient['deleteKey']> = async (credential) => {
    this.keys.delete(this.hashOf(credential.apiKey));
  };

  updateKey: NonNullable<ManagedProviderClient['updateKey']> = async (params) => {
    const hash = this.hashOf(params.apiKey);
    if (params.disabled) this.frozen.add(hash);
    else this.frozen.delete(hash);
    return { ...(await this.getKey({ hash })), disabled: Boolean(params.disabled) };
  };
}

let db: LobeChatDatabase;
const userId = 'imm-user';
const memberUserId = 'imm-member';

const cleanup = async () => {
  await db.delete(aicoKeyOutbox);
  await db.delete(walletTransactions);
  await db.delete(memberBudgets);
  await db.delete(organizationTeamMembers);
  await db.delete(organizationTeams);
  await db.delete(organizationMembers);
  await db.delete(organizations);
  await db.delete(userWallets);
  await db.delete(users);
};

beforeEach(async () => {
  db = await getTestDB();
  await cleanup();
  await db.insert(users).values([
    { id: userId, username: 'imm-user' },
    { id: memberUserId, username: 'imm-member' },
  ]);
});

afterEach(cleanup);

const readWallet = async () =>
  db.query.userWallets.findFirst({ where: eq(userWallets.userId, userId) });

const creditUser = async (amountUsd: number) => {
  const billing = new AicoBillingModel(db);
  await billing.manualCreditUser({
    amountMicroUsd: usd(amountUsd),
    amountToman: amountUsd * 50_000,
    createdByUserId: userId,
    fxRateTomanPerUsd: 50_000,
    userId,
  });
};

describe('immutable-limit provider — personal wallet', () => {
  it('records what the key was minted with, because spend is only knowable as limit − remaining', async () => {
    const provider = new ImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);

    const result = await keys.ensureUserKey(userId);
    expect(result.created).toBe(true);

    const wallet = await readWallet();
    expect(wallet?.managedKeyLimitMicroUsd).toBe(Number(wallet?.rawCapacityMicroUsd));
    expect(wallet?.rawUsageBeforeKeyMicroUsd).toBe(0);
    expect(provider.keys.size).toBe(1);
  });

  it('keeps the key while its own headroom still covers the wallet', async () => {
    const provider = new ImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);

    const again = await keys.ensureUserKey(userId);

    expect(again).toEqual({ created: false, keyId: first.keyId });
    // Minting a second spendable key that can never be revoked, for a wallet
    // that could already spend everything it had, would be pure leakage.
    expect(provider.keys.size).toBe(1);
  });

  it('reads key state by authenticating as the key, not by id', async () => {
    const provider = new ImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);

    await keys.getUserRemaining(userId);

    expect(provider.seenApiKeys.at(-1)).toBe(`sk-cvc-fake-${first.keyId}`);
  });

  it('a top-up mints a replacement sized to the unspent capacity and carries spend forward', async () => {
    const provider = new ImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);
    const firstCapacity = Number((await readWallet())?.rawCapacityMicroUsd);

    provider.spend(first.keyId!, 4);
    await creditUser(10);
    const second = await keys.ensureUserKey(userId);

    expect(second.created).toBe(true);
    expect(second.keyId).not.toBe(first.keyId);

    const wallet = await readWallet();
    const totalCapacity = Number(wallet?.rawCapacityMicroUsd);
    expect(wallet?.rawUsageBeforeKeyMicroUsd).toBe(usd(4));
    expect(wallet?.managedKeyLimitMicroUsd).toBe(totalCapacity - usd(4));
    // The retired key's own allowance is exactly what was left on it.
    expect(provider.keys.get(first.keyId!)!.limitUsd).toBe(firstCapacity / 1_000_000);
  });

  it('counts spend on retired keys — the wallet must not re-grant what it already sold', async () => {
    const provider = new ImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);
    provider.spend(first.keyId!, 4);
    await creditUser(10);
    const second = await keys.ensureUserKey(userId);
    provider.spend(second.keyId!, 1);

    const remaining = await keys.getUserRemaining(userId);

    expect(remaining.usageKnown).toBe(true);
    // $5 of raw spend across two keys, billed at the 1.2x the top-ups bought at.
    expect(remaining.usageMicroUsd).toBe(usd(6));
    expect(remaining.remainingMicroUsd).toBe(usd(20) - usd(6));
  });

  it('never rotates on an unreadable key — an unrevokable key minted on a guess cannot be taken back', async () => {
    const provider = new ImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);

    await creditUser(10);
    provider.readFails = true;
    const again = await keys.ensureUserKey(userId);

    expect(again).toEqual({ created: false, keyId: first.keyId });
    expect(provider.keys.size).toBe(1);
  });

  it('reports usage as unknown rather than zero when the mint-time limit was never recorded', async () => {
    const provider = new ImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);
    provider.spend(first.keyId!, 3);

    // A key from before migration 0153: the id is live, the limit is not known.
    await db
      .update(userWallets)
      .set({ managedKeyLimitMicroUsd: null })
      .where(eq(userWallets.userId, userId));

    const remaining = await keys.getUserRemaining(userId);

    expect(remaining.usageKnown).toBe(false);
    expect(remaining.remainingMicroUsd).toBe(usd(10));
  });
});

describe('immutable-limit provider — retired keys', () => {
  it('files an unrevokable key in the outbox, where it waits instead of failing', async () => {
    const provider = new ImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);
    provider.spend(first.keyId!, 4);
    await creditUser(10);
    await keys.ensureUserKey(userId);

    const rows = await db.query.aicoKeyOutbox.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('revoke_managed_key');
    expect(rows[0].openrouterKeyId).toBe(first.keyId);

    const run = await processKeyOutbox(db, { keyService: keys });
    expect(run).toMatchObject({ deferred: 1, failed: 0, succeeded: 0 });

    // Still pending, still owed, and no retries burned towards an alert.
    const [after] = await db.select().from(aicoKeyOutbox);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0);
    expect(after.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('revocable fixed-limit provider (CVC reseller API)', () => {
  it('a top-up deletes the retired key by its secret instead of abandoning it', async () => {
    const provider = new RevocableImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);
    provider.spend(first.keyId!, 4);
    await creditUser(10);

    const second = await keys.ensureUserKey(userId);

    expect(second.created).toBe(true);
    // The account holds one key per wallet, so the key-count limit stops growing.
    expect([...provider.keys.keys()]).toEqual([second.keyId]);
    expect(await db.query.aicoKeyOutbox.findMany()).toHaveLength(0);
    // Spend carried forward exactly as before; only the retirement changed.
    const wallet = await readWallet();
    expect(wallet?.openrouterKeyId).toBe(second.keyId);
    expect(wallet?.rawUsageBeforeKeyMicroUsd).toBe(usd(4));
  });

  it('keeps the old key working when its replacement cannot be minted', async () => {
    const provider = new RevocableImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);
    provider.spend(first.keyId!, 4);
    await creditUser(10);
    provider.createFails = true;

    await expect(keys.ensureUserKey(userId)).rejects.toThrow(/409/);

    // Deleting first would have left the wallet pointing at a dead key.
    expect(provider.keys.has(first.keyId!)).toBe(true);
    expect((await readWallet())?.openrouterKeyId).toBe(first.keyId);
  });

  it('unfreezes a funded wallet key frozen while it was disabled', async () => {
    const provider = new RevocableImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);

    await keys.disableUserKey(userId);
    expect(provider.frozen.has(first.keyId!)).toBe(true);

    await keys.ensureUserKey(userId);
    expect(provider.frozen.has(first.keyId!)).toBe(false);
  });

  it('ends an id-only revoke job as unsupported: CVC deletes by secret', async () => {
    const provider = new RevocableImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await db.insert(aicoKeyOutbox).values({
      action: 'revoke_managed_key',
      nextAttemptAt: new Date(Date.now() - 1000),
      openrouterKeyId: 'cvc_legacy',
      payload: { providerId: 'cheapvibecode', reason: 'PROVIDER_HAS_NO_REVOKE' },
      status: 'pending',
    });

    const run = await processKeyOutbox(db, { keyService: keys });

    expect(run).toMatchObject({ deferred: 0, failed: 0, succeeded: 0 });
    const [after] = await db.select().from(aicoKeyOutbox);
    expect(after.status).toBe('unsupported');
  });
});

describe('immutable-limit provider — member budgets', () => {
  const setupMember = async () => {
    const orgModel = new OrganizationModel(db);
    const org = await orgModel.createOrganization({ name: 'Imm Org', ownerUserId: userId });
    await orgModel.addManualCredit({
      amountMicroUsd: usd(100),
      amountToman: 5_000_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 50_000,
      orgId: org.id,
    });
    const invite = await orgModel.createInvite({
      identifierType: 'email',
      identifierValue: 'imm-member@example.com',
      invitedByUserId: userId,
      orgId: org.id,
      role: 'member',
    });
    const { member } = await orgModel.acceptInvite({
      email: 'imm-member@example.com',
      token: invite.token,
      userId: memberUserId,
    });
    await orgModel.allocateMemberCredit({
      createdByUserId: userId,
      orgId: org.id,
      orgMemberId: member.id,
      period: 'daily',
      periodAmountMicroUsd: usd(12),
    });
    return { member, org, orgModel };
  };

  it('mints against the cycle cap and records the limit', async () => {
    const provider = new ImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    const { member, orgModel } = await setupMember();

    const created = await keys.ensureMemberKey(member.id);
    expect(created.created).toBe(true);

    const budget = await orgModel.getMemberBudget(member.id);
    // $12 of billed allowance at 1.2x buys $10 of raw upstream spend.
    expect(budget?.managedKeyLimitMicroUsd).toBe(usd(10));
    // No periodic reset exists upstream, so none is claimed.
    expect(provider.keys.get(created.keyId!)!.limitUsd).toBe(10);
  });

  it('moves the checkpoint baseline to the counter at a period boundary, not to zero', async () => {
    const provider = new ImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    const { member } = await setupMember();
    const created = await keys.ensureMemberKey(member.id);
    provider.spend(created.keyId!, 3);

    const settled = await keys.settleMemberPeriod(member.id);

    // Zeroing here would re-meter the $3 the closing cycle already settled.
    expect(settled?.nextCycleBaselineMicroUsd).toBe(usd(3));
    expect(settled?.usageMicroUsd).toBe(usd(3.6));
  });

  it('carries billed usage into the checkpoint when a budget increase forces a new key', async () => {
    const provider = new ImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    const { member, org, orgModel } = await setupMember();
    const first = await keys.ensureMemberKey(member.id);
    provider.spend(first.keyId!, 4);

    await orgModel.allocateMemberCredit({
      createdByUserId: userId,
      orgId: org.id,
      orgMemberId: member.id,
      period: 'daily',
      periodAmountMicroUsd: usd(24),
    });
    const second = await keys.ensureMemberKey(member.id);

    expect(second.keyId).not.toBe(first.keyId);
    const budget = await orgModel.getMemberBudget(member.id);
    // $4 raw already spent, billed at 1.2x, frozen before the new baseline.
    expect(Number(budget?.billedUsageBeforeBaselineMicroUsd)).toBe(usd(4.8));
    expect(Number(budget?.usageBaselineMicroUsd)).toBe(0);
    // The replacement covers only what the cycle has left: ($24 − $4.8) / 1.2.
    expect(Number(budget?.managedKeyLimitMicroUsd)).toBe(usd(16));
  });

  it('freezes a disabled member key by secret and unfreezes it once the budget is active', async () => {
    const provider = new RevocableImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    const { member } = await setupMember();
    const created = await keys.ensureMemberKey(member.id);

    await keys.disableMemberKey(member.id);
    expect(provider.frozen.has(created.keyId!)).toBe(true);

    const again = await keys.ensureMemberKey(member.id);
    expect(again.keyId).toBe(created.keyId);
    expect(provider.frozen.has(created.keyId!)).toBe(false);
  });

  it('deletes the retired member key once its replacement is persisted', async () => {
    const provider = new RevocableImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    const { member, org, orgModel } = await setupMember();
    const first = await keys.ensureMemberKey(member.id);
    provider.spend(first.keyId!, 4);
    await orgModel.allocateMemberCredit({
      createdByUserId: userId,
      orgId: org.id,
      orgMemberId: member.id,
      period: 'daily',
      periodAmountMicroUsd: usd(24),
    });

    const second = await keys.ensureMemberKey(member.id);

    expect([...provider.keys.keys()]).toEqual([second.keyId]);
    expect(Number((await orgModel.getMemberBudget(member.id))?.managedKeyLimitMicroUsd)).toBe(
      usd(16),
    );
  });
});
