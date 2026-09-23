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
  aicoRenewalBatches,
  memberBudgets,
  organizationMembers,
  organizations,
  organizationTeamMembers,
  organizationTeams,
  userWallets,
  walletTransactions,
} from '@/database/schemas/aicoOrganization';
import { aicoEnv } from '@/envs/aico';
import { processDueRenewals, processKeyOutbox } from '@/server/services/aico/renewalScheduler';
import {
  CheapVibeCodeAmbiguousEditError,
  type ManagedProviderClient,
} from '@/server/services/managedProvider';
import { CheapVibeCodeApiError } from '@/server/services/managedProvider/cheapvibecode';
import { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

// Read at call time by `KeyVaultsGateKeeper`, but the modules below are hoisted
// above ordinary statements — so the stub has to be hoisted with them.
vi.hoisted(() => {
  process.env.KEY_VAULTS_SECRET ||= 'LA7n9k3JdEcbSgml2sxfw+4TV1AzaaFU5+R176aQz4s=';
});

// A mutable copy, so one describe block can turn `AICO_CVC_RESIZE_IN_PLACE` on.
vi.mock('@/envs/aico', async (importOriginal) => {
  const actual = await importOriginal<{ aicoEnv: Record<string, unknown> }>();
  return { ...actual, aicoEnv: { ...actual.aicoEnv } };
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
    return this.state(credential.hash, credential.limitUsd);
  };

  /** A key's state as the gateway holds it, bypassing what `getKey` refuses. */
  protected state(hash: string, limitUsd?: number) {
    const row = this.keys.get(hash);
    if (!row) throw new Error(`unknown key ${hash}`);
    return {
      disabled: false,
      hash,
      // The real provider reports only what is left; `limit` comes from the
      // caller's own record of the mint, which is the whole point of the column.
      limit: limitUsd ?? null,
      limitRemaining: Math.max(0, row.limitUsd - row.usedUsd),
      name: row.name,
      usage: 0,
      usageDaily: null,
      usageMonthly: null,
      usageWeekly: null,
    };
  }

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

  /** As on the live API: a frozen key cannot read its own balance. */
  override getKey: ManagedProviderClient['getKey'] = async (credential) => {
    if (this.frozen.has(credential.hash)) {
      throw new CheapVibeCodeApiError(401, 'Unauthorized', null);
    }
    this.seenApiKeys.push(credential.apiKey);
    if (this.readFails) throw new Error('CheapVibeCode API 429');
    return this.state(credential.hash, credential.limitUsd);
  };

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
    // Every edit but delete answers with the key's meta, frozen or not.
    return {
      ...this.state(hash, this.keys.get(hash)!.limitUsd),
      disabled: Boolean(params.disabled),
    };
  };
}

/**
 * CVC with `POST /v1/keys/edit` resizing: the limit moves on the same key and
 * its counter carries on. `resizeMode` stands in for CVC timing out mid-raise
 * (`ambiguous`, which still applies the edit) or refusing it.
 */
class ResizableProvider extends RevocableImmutableProvider {
  resizeMode: 'ambiguous' | 'ok' | 'refuse' = 'ok';
  resizes: { active: boolean; limitUsd: number }[] = [];

  resizeKey: NonNullable<ManagedProviderClient['resizeKey']> = async (params) => {
    const hash = params.apiKey.replace('sk-cvc-fake-', '');
    const row = this.keys.get(hash);
    if (!row) throw new Error('CheapVibeCode API 404: Not Found');
    if (this.resizeMode === 'refuse') throw new Error('CheapVibeCode API 400: Bad Request');
    this.resizes.push({ active: params.active, limitUsd: params.limitUsd });
    if (params.active) this.frozen.delete(hash);
    else this.frozen.add(hash);
    row.limitUsd = Math.max(params.limitUsd, row.usedUsd);
    if (this.resizeMode === 'ambiguous') throw new CheapVibeCodeAmbiguousEditError(502);
    return { ...this.state(hash, row.limitUsd), limit: row.limitUsd };
  };

  override updateKey: NonNullable<ManagedProviderClient['updateKey']> = async (params) => {
    const hash = params.apiKey!.replace('sk-cvc-fake-', '');
    const row = this.keys.get(hash);
    if (!row) throw new Error('CheapVibeCode API 404: Not Found');
    if (params.disabled) this.frozen.add(hash);
    else this.frozen.delete(hash);
    return {
      ...this.state(hash, row.limitUsd),
      disabled: Boolean(params.disabled),
      limit: row.limitUsd,
    };
  };
}

const resizeFlag = aicoEnv as { AICO_CVC_RESIZE_IN_PLACE: boolean };

let db: LobeChatDatabase;
const userId = 'imm-user';
const memberUserId = 'imm-member';

const cleanup = async () => {
  await db.delete(aicoKeyOutbox);
  await db.delete(aicoRenewalBatches);
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

describe('resize in place (AICO_CVC_RESIZE_IN_PLACE) — personal wallet', () => {
  beforeEach(() => {
    resizeFlag.AICO_CVC_RESIZE_IN_PLACE = true;
  });
  afterEach(() => {
    resizeFlag.AICO_CVC_RESIZE_IN_PLACE = false;
  });

  it('a top-up raises the same key instead of minting a replacement', async () => {
    const provider = new ResizableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);
    provider.spend(first.keyId!, 4);
    await creditUser(10);

    const again = await keys.ensureUserKey(userId);

    expect(again).toEqual({ created: false, keyId: first.keyId });
    expect(provider.keys.size).toBe(1);
    const wallet = await readWallet();
    // Same key, same counter: the whole capacity is its limit, nothing carried.
    expect(wallet?.managedKeyLimitMicroUsd).toBe(Number(wallet?.rawCapacityMicroUsd));
    expect(wallet?.rawUsageBeforeKeyMicroUsd).toBe(0);
    expect(provider.keys.get(first.keyId!)!.limitUsd * 1_000_000).toBe(
      Number(wallet?.rawCapacityMicroUsd),
    );

    // Spend reads the same as it would across two keys: $4 raw at 1.2x.
    const remaining = await keys.getUserRemaining(userId);
    expect(remaining.usageMicroUsd).toBe(usd(4.8));
  });

  it('does not touch the key when the wallet is not being topped up', async () => {
    const provider = new ResizableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    await keys.ensureUserKey(userId);

    await keys.ensureUserKey(userId);

    expect(provider.resizes).toHaveLength(0);
  });

  it('an ambiguous raise is not retried, keeps the key, and heals the stored limit from a live read', async () => {
    const provider = new ResizableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);
    await creditUser(10);
    provider.resizeMode = 'ambiguous';

    const again = await keys.ensureUserKey(userId);

    expect(again).toEqual({ created: false, keyId: first.keyId });
    expect(provider.resizes).toHaveLength(1);
    expect(provider.keys.size).toBe(1);
    // The raise did land upstream; the stored limit now says so.
    const wallet = await readWallet();
    expect(wallet?.managedKeyLimitMicroUsd).toBe(
      Math.round(provider.keys.get(first.keyId!)!.limitUsd * 1_000_000),
    );
  });

  it('a refused resize falls back to mint-then-delete with the stored limit restored', async () => {
    const provider = new ResizableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);
    provider.spend(first.keyId!, 4);
    await creditUser(10);
    provider.resizeMode = 'refuse';

    const second = await keys.ensureUserKey(userId);

    expect(second.created).toBe(true);
    expect([...provider.keys.keys()]).toEqual([second.keyId]);
    // The rotation read the old key against its real limit, so the carry is exact.
    expect((await readWallet())?.rawUsageBeforeKeyMicroUsd).toBe(usd(4));
  });

  it('stays on rotation while the flag is off', async () => {
    resizeFlag.AICO_CVC_RESIZE_IN_PLACE = false;
    const provider = new ResizableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(10);
    const first = await keys.ensureUserKey(userId);
    provider.spend(first.keyId!, 4);
    await creditUser(10);

    const second = await keys.ensureUserKey(userId);

    expect(second.keyId).not.toBe(first.keyId);
    expect(provider.resizes).toHaveLength(0);
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

  it('settles a member key that renewal froze, although a frozen key cannot read its balance', async () => {
    const provider = new RevocableImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    const { member } = await setupMember();
    const created = await keys.ensureMemberKey(member.id);
    provider.spend(created.keyId!, 3);
    // What renewal does before settling, so the reading is final.
    await keys.disableMemberKey(member.id);

    const settled = await keys.settleMemberPeriod(member.id);

    expect(settled?.nextCycleBaselineMicroUsd).toBe(usd(3));
    expect(settled?.usageMicroUsd).toBe(usd(3.6));
    expect(provider.frozen.has(created.keyId!)).toBe(true);
  });

  it('renews a CVC member budget end to end instead of failing settlement on the frozen key', async () => {
    const provider = new RevocableImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    const { member, orgModel } = await setupMember();
    const created = await keys.ensureMemberKey(member.id);
    provider.spend(created.keyId!, 3);
    await db
      .update(memberBudgets)
      .set({ nextRenewalAt: new Date(Date.now() - 60_000) })
      .where(eq(memberBudgets.orgMemberId, member.id));

    const [result] = await processDueRenewals(db, { keyService: keys });

    expect(result?.status).toBe('funded');
    const budget = await orgModel.getMemberBudget(member.id);
    expect(budget?.renewalStatus).toBe('active');
    expect(budget?.isActive).toBe(true);
    // The member leaves the boundary on a spendable key.
    expect(provider.frozen.has(budget!.openrouterKeyId!)).toBe(false);
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

  describe('resize in place (AICO_CVC_RESIZE_IN_PLACE)', () => {
    beforeEach(() => {
      resizeFlag.AICO_CVC_RESIZE_IN_PLACE = true;
    });
    afterEach(() => {
      resizeFlag.AICO_CVC_RESIZE_IN_PLACE = false;
    });

    it('a raised cap resizes the same key and keeps the checkpoint on its counter', async () => {
      const provider = new ResizableProvider();
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

      const again = await keys.ensureMemberKey(member.id);

      expect(again).toEqual({ created: false, keyId: first.keyId });
      expect(provider.keys.size).toBe(1);
      const budget = await orgModel.getMemberBudget(member.id);
      // No rotation: nothing frozen into the checkpoint, the counter carries on.
      expect(Number(budget?.usageBaselineMicroUsd ?? 0)).toBe(0);
      expect(Number(budget?.billedUsageBeforeBaselineMicroUsd ?? 0)).toBe(0);
      // $24 at 1.2x buys $20 raw on the same counter — the $4 already used included.
      expect(Number(budget?.managedKeyLimitMicroUsd)).toBe(usd(20));
      expect(provider.keys.get(first.keyId!)!.limitUsd).toBe(20);
    });

    it('a cut cap reduces the same key, never below what it already used', async () => {
      const provider = new ResizableProvider();
      const keys = new AicoOpenRouterKeyService(db, provider);
      const { member, org, orgModel } = await setupMember();
      const first = await keys.ensureMemberKey(member.id);
      provider.spend(first.keyId!, 4);
      await orgModel.allocateMemberCredit({
        createdByUserId: userId,
        orgId: org.id,
        orgMemberId: member.id,
        period: 'daily',
        periodAmountMicroUsd: usd(6),
      });

      await keys.ensureMemberKey(member.id);

      expect(provider.keys.size).toBe(1);
      // $6 at 1.2x is $5 raw; the key keeps the $4 it spent and $1 of headroom.
      expect(provider.keys.get(first.keyId!)!.limitUsd).toBe(5);
      expect(Number((await orgModel.getMemberBudget(member.id))?.managedKeyLimitMicroUsd)).toBe(
        usd(5),
      );
    });

    it('a daily renewal resizes the key on the re-based counter without re-metering the closed cycle', async () => {
      const provider = new ResizableProvider();
      const keys = new AicoOpenRouterKeyService(db, provider);
      const { member } = await setupMember();
      const first = await keys.ensureMemberKey(member.id);
      provider.spend(first.keyId!, 3);

      const settled = await keys.settleMemberPeriod(member.id);
      // What the renewal writes for the new cycle (see renewalScheduler).
      await db
        .update(memberBudgets)
        .set({
          billedUsageBeforeBaselineMicroUsd: 0,
          settledUsageMicroUsd: 0,
          usageBaselineMicroUsd: settled!.nextCycleBaselineMicroUsd,
        })
        .where(eq(memberBudgets.orgMemberId, member.id));

      const again = await keys.ensureMemberKey(member.id);

      expect(again.keyId).toBe(first.keyId);
      // The new cycle's $10 raw sits on top of the $3 the old one used.
      expect(provider.keys.get(first.keyId!)!.limitUsd).toBe(13);
      // Nothing spent yet this cycle, even though the key's counter reads $3.
      const synced = await keys.syncMemberCycleUsage(member.id);
      expect(Number(synced?.settledUsageMicroUsd)).toBe(0);
    });
  });

  describe('reissue (changed secret prefix)', () => {
    it('mints a replacement with the cycle headroom and deletes the old key', async () => {
      const provider = new RevocableImmutableProvider();
      const keys = new AicoOpenRouterKeyService(db, provider);
      const { member, orgModel } = await setupMember();
      const first = await keys.ensureMemberKey(member.id);
      provider.spend(first.keyId!, 4);

      const outcome = await keys.reissueMemberKey(member.id);

      expect(outcome.status).toBe('reissued');
      expect(outcome.keyId).not.toBe(first.keyId);
      expect([...provider.keys.keys()]).toEqual([outcome.keyId]);
      // $12 at 1.2x is $10 raw, $4 of it spent: the new key gets the $6 left.
      expect(provider.keys.get(outcome.keyId!)!.limitUsd).toBe(6);
      const budget = await orgModel.getMemberBudget(member.id);
      expect(budget?.openrouterKeyId).toBe(outcome.keyId);
      // The spend on the retired key is billed into the checkpoint, not forgotten.
      expect(Number(budget?.billedUsageBeforeBaselineMicroUsd)).toBe(usd(4.8));
    });

    it('leaves a budget that must not spend on its frozen key', async () => {
      const provider = new RevocableImmutableProvider();
      const keys = new AicoOpenRouterKeyService(db, provider);
      const { member } = await setupMember();
      const first = await keys.ensureMemberKey(member.id);
      await db
        .update(memberBudgets)
        .set({ renewalStatus: 'renewal_failed' })
        .where(eq(memberBudgets.orgMemberId, member.id));

      expect(await keys.reissueMemberKey(member.id)).toEqual({
        keyId: first.keyId,
        status: 'kept',
      });
      expect([...provider.keys.keys()]).toEqual([first.keyId]);
    });
  });
});

describe('admin key operations — personal wallet', () => {
  it('reissue mints a replacement with the unspent capacity and carries spend forward', async () => {
    const provider = new RevocableImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(12);
    const first = await keys.ensureUserKey(userId);
    provider.spend(first.keyId!, 4);

    const outcome = await keys.reissueUserKey(userId);

    expect(outcome.status).toBe('reissued');
    expect([...provider.keys.keys()]).toEqual([outcome.keyId]);
    // $12 at 1.2x bought $10 raw; $4 spent leaves $6 on the new key.
    expect(provider.keys.get(outcome.keyId!)!.limitUsd).toBe(6);
    const wallet = await readWallet();
    expect(wallet?.openrouterKeyId).toBe(outcome.keyId);
    expect(wallet?.rawUsageBeforeKeyMicroUsd).toBe(usd(4));
  });

  it('reissue keeps a spent-out key and keeps the old key when the mint fails', async () => {
    const provider = new RevocableImmutableProvider();
    const keys = new AicoOpenRouterKeyService(db, provider);
    await creditUser(12);
    const first = await keys.ensureUserKey(userId);

    provider.createFails = true;
    await expect(keys.reissueUserKey(userId)).rejects.toThrow(/409/);
    expect((await readWallet())?.openrouterKeyId).toBe(first.keyId);

    provider.createFails = false;
    provider.spend(first.keyId!, 10);
    expect(await keys.reissueUserKey(userId)).toEqual({ keyId: first.keyId, status: 'kept' });
  });

  describe('shrink after an admin debit', () => {
    const debit = (amountUsd: number) =>
      new AicoBillingModel(db).manualDebitUser({
        amountMicroUsd: usd(amountUsd),
        description: 'take back grant',
        idempotencyKey: `debit-${amountUsd}-${Math.random()}`,
        userId,
      });

    afterEach(() => {
      resizeFlag.AICO_CVC_RESIZE_IN_PLACE = false;
    });

    it('reduces the same key in place', async () => {
      resizeFlag.AICO_CVC_RESIZE_IN_PLACE = true;
      const provider = new ResizableProvider();
      const keys = new AicoOpenRouterKeyService(db, provider);
      await creditUser(12);
      const first = await keys.ensureUserKey(userId);
      provider.spend(first.keyId!, 2);
      await debit(6);

      expect(await keys.shrinkUserKey(userId)).toEqual({
        keyId: first.keyId,
        status: 'resized',
      });
      // Half the grant gone: $10 raw of capacity becomes $5.
      expect(provider.keys.get(first.keyId!)!.limitUsd).toBe(5);
      expect((await readWallet())?.managedKeyLimitMicroUsd).toBe(usd(5));
    });

    it('reissues a smaller key where the limit cannot move', async () => {
      const provider = new RevocableImmutableProvider();
      const keys = new AicoOpenRouterKeyService(db, provider);
      await creditUser(12);
      const first = await keys.ensureUserKey(userId);
      provider.spend(first.keyId!, 2);
      await debit(6);

      const outcome = await keys.shrinkUserKey(userId);

      expect(outcome.status).toBe('reissued');
      expect([...provider.keys.keys()]).toEqual([outcome.keyId]);
      // $5 raw left, $2 already spent on the retired key.
      expect(provider.keys.get(outcome.keyId!)!.limitUsd).toBe(3);
    });
  });
});
