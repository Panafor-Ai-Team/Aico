/**
 * Phase 4 — flipping `AICO_MANAGED_PROVIDER` from one gateway to another.
 *
 * A cutover is the one moment when a row can hold a live key that authenticates
 * against nothing: the credential is real, the gateway it belongs to is no
 * longer the one we call. Every assertion here is about that key being treated
 * as absent rather than as usable, and about the replacement being sized from
 * what the subject has already spent — a fresh full-size key would re-grant
 * money that was sold once already.
 *
 * The retired key is deliberately left alive upstream. Rolling back has to be
 * an env change, not a restore.
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
import { AicoManagedPolicy, AicoManagedPolicyError } from '@/server/services/aico/managedPolicy';
import type { ManagedProviderClient } from '@/server/services/managedProvider';
import { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

vi.hoisted(() => {
  process.env.KEY_VAULTS_SECRET ||= 'LA7n9k3JdEcbSgml2sxfw+4TV1AzaaFU5+R176aQz4s=';
});

const usd = (n: number) => Math.round(n * 1_000_000);

/** OpenRouter-shaped: reports cumulative usage, and can revoke and update. */
class OutgoingProvider implements ManagedProviderClient {
  readonly capabilities = {
    nativePeriodicLimits: true,
    readKeyBySecret: false,
    revoke: true,
    updateLimit: true,
  };

  readonly providerId = 'openrouter' as const;

  keys = new Map<string, { limitUsd: number; usedUsd: number }>();
  deleted: string[] = [];
  disabled: string[] = [];

  private seq = 0;

  createKey: ManagedProviderClient['createKey'] = async (params) => {
    const hash = `or_${++this.seq}`;
    this.keys.set(hash, { limitUsd: params.limitUsd, usedUsd: 0 });
    return {
      disabled: false,
      hash,
      key: `sk-or-fake-${hash}`,
      limit: params.limitUsd,
      limitRemaining: params.limitUsd,
      name: params.name,
      usage: 0,
      usageDaily: 0,
      usageMonthly: 0,
      usageWeekly: 0,
    };
  };

  getKey: ManagedProviderClient['getKey'] = async (credential) => {
    const row = this.keys.get(credential.hash);
    if (!row) throw new Error(`unknown key ${credential.hash}`);
    return {
      disabled: false,
      hash: credential.hash,
      limit: row.limitUsd,
      limitRemaining: Math.max(0, row.limitUsd - row.usedUsd),
      name: null,
      usage: row.usedUsd,
      usageDaily: row.usedUsd,
      usageMonthly: row.usedUsd,
      usageWeekly: row.usedUsd,
    };
  };

  updateKey: NonNullable<ManagedProviderClient['updateKey']> = async (params) => {
    if (params.disabled) this.disabled.push(params.hash);
    const row = this.keys.get(params.hash);
    if (row && params.limitUsd != null) row.limitUsd = params.limitUsd;
    return this.getKey({ hash: params.hash });
  };

  deleteKey: NonNullable<ManagedProviderClient['deleteKey']> = async (credential) => {
    this.deleted.push(credential.hash);
    this.keys.delete(credential.hash);
  };

  getAccountBalanceUsd: ManagedProviderClient['getAccountBalanceUsd'] = async () => 1000;

  spend(hash: string, amountUsd: number) {
    const row = this.keys.get(hash);
    if (!row) throw new Error(`unknown key ${hash}`);
    row.usedUsd += amountUsd;
  }
}

/** CheapVibeCode-shaped: reports only what is left, and cannot revoke. */
class IncomingProvider implements ManagedProviderClient {
  readonly capabilities = {
    nativePeriodicLimits: false,
    readKeyBySecret: true,
    revoke: false,
    updateLimit: false,
  };

  readonly providerId = 'cheapvibecode' as const;

  keys = new Map<string, { limitUsd: number; usedUsd: number }>();

  private seq = 0;

  createKey: ManagedProviderClient['createKey'] = async (params) => {
    const hash = `cvc_${++this.seq}`;
    this.keys.set(hash, { limitUsd: params.limitUsd, usedUsd: 0 });
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
    const row = this.keys.get(credential.hash);
    // A key from the other gateway means nothing here — this is the auth failure
    // the cutover guards exist to avoid provoking.
    if (!row) throw new Error('CheapVibeCode API 401');
    return {
      disabled: false,
      hash: credential.hash,
      limit: credential.limitUsd ?? null,
      limitRemaining: Math.max(0, row.limitUsd - row.usedUsd),
      name: null,
      usage: 0,
      usageDaily: null,
      usageMonthly: null,
      usageWeekly: null,
    };
  };

  getAccountBalanceUsd: ManagedProviderClient['getAccountBalanceUsd'] = async () => 1000;
}

let db: LobeChatDatabase;
const userId = 'cut-user';
const memberUserId = 'cut-member';

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
    { id: userId, username: 'cut-user' },
    { id: memberUserId, username: 'cut-member' },
  ]);
});

afterEach(cleanup);

const readWallet = async () =>
  db.query.userWallets.findFirst({ where: eq(userWallets.userId, userId) });

const creditUser = async (amountUsd: number) => {
  await new AicoBillingModel(db).manualCreditUser({
    amountMicroUsd: usd(amountUsd),
    amountToman: amountUsd * 50_000,
    createdByUserId: userId,
    fxRateTomanPerUsd: 50_000,
    userId,
  });
};

describe('provider cutover — personal wallet', () => {
  it('stamps every mint with the gateway that made it', async () => {
    const outgoing = new OutgoingProvider();
    await creditUser(10);
    await new AicoOpenRouterKeyService(db, outgoing).ensureUserKey(userId);

    expect((await readWallet())?.managedKeyProviderId).toBe('openrouter');
  });

  it('mints a replacement sized to what the wallet has left, not to its whole balance', async () => {
    const outgoing = new OutgoingProvider();
    await creditUser(10);
    const before = new AicoOpenRouterKeyService(db, outgoing);
    const first = await before.ensureUserKey(userId);
    outgoing.spend(first.keyId!, 4);
    // Settle what the old gateway knows, the way the dashboard cron does.
    await before.getUserRemaining(userId, { persist: true });

    const incoming = new IncomingProvider();
    const after = await new AicoOpenRouterKeyService(db, incoming).ensureUserKey(userId);

    expect(after.created).toBe(true);
    expect(after.keyId).not.toBe(first.keyId);
    const wallet = await readWallet();
    expect(wallet?.managedKeyProviderId).toBe('cheapvibecode');
    // $10 billed bought $10/1.2 of raw capacity; $4 raw of it is gone.
    expect(Number(wallet?.rawUsageBeforeKeyMicroUsd)).toBe(usd(4));
    expect(Number(wallet?.managedKeyLimitMicroUsd)).toBe(
      Number(wallet?.rawCapacityMicroUsd) - usd(4),
    );
  });

  it('leaves the old key alive upstream, so a rollback is an env change', async () => {
    const outgoing = new OutgoingProvider();
    await creditUser(10);
    const first = await new AicoOpenRouterKeyService(db, outgoing).ensureUserKey(userId);

    await new AicoOpenRouterKeyService(db, new IncomingProvider()).ensureUserKey(userId);

    expect(outgoing.deleted).toEqual([]);
    expect(outgoing.disabled).toEqual([]);
    expect(outgoing.keys.has(first.keyId!)).toBe(true);
  });

  it('holds usage at the last settled figure rather than reading the wrong gateway', async () => {
    const outgoing = new OutgoingProvider();
    await creditUser(10);
    const before = new AicoOpenRouterKeyService(db, outgoing);
    const first = await before.ensureUserKey(userId);
    outgoing.spend(first.keyId!, 5);
    await before.getUserRemaining(userId, { persist: true });

    const remaining = await new AicoOpenRouterKeyService(
      db,
      new IncomingProvider(),
    ).getUserRemaining(userId);

    expect(remaining.usageKnown).toBe(false);
    expect(remaining.usageMicroUsd).toBe(usd(6));
    expect(remaining.remainingMicroUsd).toBe(usd(4));
  });

  it('does not re-grant a trial that has already been partly spent', async () => {
    const outgoing = new OutgoingProvider();
    const before = new AicoOpenRouterKeyService(db, outgoing);
    const first = await before.ensureTrialKey(userId, usd(6));
    expect(first.created).toBe(true);
    outgoing.spend(first.keyId!, 2);
    await before.getUserRemaining(userId, { persist: true });

    const incoming = new IncomingProvider();
    const after = await new AicoOpenRouterKeyService(db, incoming).ensureTrialKey(userId, usd(6));

    expect(after.created).toBe(true);
    // $6 of billed trial buys $5 raw; $2 raw is spent, so $3 raw is left.
    expect(incoming.keys.get(after.keyId!)!.limitUsd).toBe(3);
  });
});

describe('provider cutover — member budgets', () => {
  const setupMember = async () => {
    const orgModel = new OrganizationModel(db);
    const org = await orgModel.createOrganization({ name: 'Cut Org', ownerUserId: userId });
    await orgModel.addManualCredit({
      amountMicroUsd: usd(100),
      amountToman: 5_000_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 50_000,
      orgId: org.id,
    });
    const invite = await orgModel.createInvite({
      identifierType: 'email',
      identifierValue: 'cut-member@example.com',
      invitedByUserId: userId,
      orgId: org.id,
      role: 'member',
    });
    const { member } = await orgModel.acceptInvite({
      email: 'cut-member@example.com',
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

  it('freezes the checkpoint and sizes the replacement to the rest of the cycle', async () => {
    const outgoing = new OutgoingProvider();
    const { member, orgModel } = await setupMember();
    const before = new AicoOpenRouterKeyService(db, outgoing);
    const first = await before.ensureMemberKey(member.id);
    outgoing.spend(first.keyId!, 3);
    await before.syncMemberCycleUsage(member.id);

    const incoming = new IncomingProvider();
    const after = await new AicoOpenRouterKeyService(db, incoming).ensureMemberKey(member.id);

    expect(after.created).toBe(true);
    const budget = await orgModel.getMemberBudget(member.id);
    expect(budget?.managedKeyProviderId).toBe('cheapvibecode');
    // The new key's counter starts at zero, so the baseline must too, with the
    // $3 raw already spent frozen as $3.60 billed.
    expect(Number(budget?.usageBaselineMicroUsd)).toBe(0);
    expect(Number(budget?.billedUsageBeforeBaselineMicroUsd)).toBe(usd(3.6));
    // ($12 − $3.60) of billed cap left buys $7 of raw spend.
    expect(incoming.keys.get(after.keyId!)!.limitUsd).toBe(7);
    // And the old key is still there to roll back to.
    expect(outgoing.deleted).toEqual([]);
  });

  it('settles a period on the last known figure instead of failing the renewal', async () => {
    const outgoing = new OutgoingProvider();
    const { member } = await setupMember();
    const before = new AicoOpenRouterKeyService(db, outgoing);
    const first = await before.ensureMemberKey(member.id);
    outgoing.spend(first.keyId!, 3);
    await before.syncMemberCycleUsage(member.id);

    const settled = await new AicoOpenRouterKeyService(
      db,
      new IncomingProvider(),
    ).settleMemberPeriod(member.id);

    // Not a throw, and not $0 — either would refund the org money already spent.
    expect(settled?.usageMicroUsd).toBe(usd(3.6));
    expect(settled?.remainingMicroUsd).toBe(usd(12) - usd(3.6));
  });

  it('reclaims without disabling a key the live gateway does not own', async () => {
    const outgoing = new OutgoingProvider();
    const { member, org } = await setupMember();
    const before = new AicoOpenRouterKeyService(db, outgoing);
    const first = await before.ensureMemberKey(member.id);
    outgoing.spend(first.keyId!, 3);
    await before.syncMemberCycleUsage(member.id);

    const reclaimed = await new AicoOpenRouterKeyService(
      db,
      new IncomingProvider(),
    ).reclaimMemberKey({ orgId: org.id, orgMemberId: member.id });

    expect(reclaimed?.usageMicroUsd).toBe(usd(3.6));
    expect(outgoing.disabled).toEqual([]);
    expect(outgoing.keys.has(first.keyId!)).toBe(true);
  });
});

describe('provider cutover — the authorization boundary', () => {
  const authorize = async (keyRepair?: {
    ensureMemberKey: (id: string) => Promise<unknown>;
    ensureUserKey?: (id: string) => Promise<unknown>;
  }) => {
    const policy = new AicoManagedPolicy(db, async () => 'sk-decrypted', keyRepair);
    return policy.authorize({
      billing: { source: 'personal' },
      modelId: 'openrouter/auto',
      userId,
    });
  };

  it('refuses a key minted by the gateway that is no longer active', async () => {
    const outgoing = new OutgoingProvider();
    await creditUser(10);
    await new AicoOpenRouterKeyService(db, outgoing).ensureUserKey(userId);
    await db
      .update(userWallets)
      .set({ managedKeyProviderId: 'cheapvibecode' })
      .where(eq(userWallets.userId, userId));

    // Handing this key to the runtime is the one silent failure a cutover can
    // produce: a real credential that authenticates against nothing.
    await expect(authorize()).rejects.toThrow(AicoManagedPolicyError);
    await expect(authorize()).rejects.toThrow(/MANAGED_KEY_UNAVAILABLE/);
  });

  it('accepts a key with no stamp at all, which can only be the original gateway', async () => {
    const outgoing = new OutgoingProvider();
    await creditUser(10);
    await new AicoOpenRouterKeyService(db, outgoing).ensureUserKey(userId);
    // A row written before migration 0154 backfilled the column.
    await db
      .update(userWallets)
      .set({ managedKeyProviderId: null })
      .where(eq(userWallets.userId, userId));

    const authorized = await authorize();

    expect(authorized.apiKey).toBe('sk-decrypted');
  });

  it('repairs a foreign key on the first request instead of failing the user', async () => {
    // The rollback direction, because `MANAGED_PROVIDER_ID` is what the policy
    // compares against and it is `openrouter` unless the env says otherwise:
    // a wallet keyed on CheapVibeCode meeting a deployment back on OpenRouter.
    await creditUser(10);
    await new AicoOpenRouterKeyService(db, new IncomingProvider()).ensureUserKey(userId);
    expect((await readWallet())?.managedKeyProviderId).toBe('cheapvibecode');

    const outgoing = new OutgoingProvider();
    const authorized = await authorize({
      ensureMemberKey: async () => null,
      ensureUserKey: (id) => new AicoOpenRouterKeyService(db, outgoing).ensureUserKey(id),
    });

    expect(authorized.apiKey).toBe('sk-decrypted');
    expect((await readWallet())?.managedKeyProviderId).toBe('openrouter');
    expect(outgoing.keys.size).toBe(1);
  });
});
