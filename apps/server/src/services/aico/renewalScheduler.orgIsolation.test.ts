/**
 * One org whose renewal throws must not stop the other orgs in the same run.
 */
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  walletTransactions,
} from '@/database/schemas/aicoOrganization';
import { processDueRenewals } from '@/server/services/aico/renewalScheduler';
import type { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

const { multiplierMock } = vi.hoisted(() => ({ multiplierMock: vi.fn() }));
vi.mock('@/database/models/aicoBilling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/database/models/aicoBilling')>();
  class AicoBillingModel extends actual.AicoBillingModel {
    constructor(...args: ConstructorParameters<typeof actual.AicoBillingModel>) {
      super(...args);
      const original = this.getUsageMultiplierBp;
      this.getUsageMultiplierBp = ((...a: Parameters<typeof original>) =>
        multiplierMock(original, ...a)) as typeof original;
    }
  }
  return { ...actual, AicoBillingModel };
});

const usd = (n: number) => Math.round(n * 1_000_000);

describe('processDueRenewals — org isolation', () => {
  let db: LobeChatDatabase;
  let orgModel: OrganizationModel;

  const wipe = async () => {
    await db.delete(aicoKeyOutbox);
    await db.delete(aicoRenewalBatches);
    await db.delete(walletTransactions);
    await db.delete(memberBudgets);
    await db.delete(organizationTeamMembers);
    await db.delete(organizationTeams);
    await db.delete(organizationMembers);
    await db.delete(organizations);
    await db.delete(users);
  };

  beforeEach(async () => {
    multiplierMock.mockReset();
    multiplierMock.mockImplementation((original, ...a) => original(...a));
    db = await getTestDB();
    orgModel = new OrganizationModel(db);
    await wipe();
  });

  afterEach(async () => {
    await wipe();
  });

  const dueOrg = async (n: number) => {
    const ownerId = `iso-owner-${n}`;
    const memberUserId = `iso-member-${n}`;
    await db.insert(users).values([
      { email: `iso-owner-${n}@example.com`, id: ownerId },
      { email: `iso-member-${n}@example.com`, id: memberUserId },
    ]);
    const org = await orgModel.createOrganization({ name: `Iso ${n}`, ownerUserId: ownerId });
    await orgModel.addManualCredit({
      amountMicroUsd: usd(20),
      amountToman: 100_000,
      createdByUserId: ownerId,
      fxRateTomanPerUsd: 5000,
      orgId: org.id,
    });
    const invite = await orgModel.createInvite({
      identifierType: 'email',
      identifierValue: `iso-member-${n}@example.com`,
      invitedByUserId: ownerId,
      orgId: org.id,
      role: 'member',
    });
    const { member } = await orgModel.acceptInvite({
      email: `iso-member-${n}@example.com`,
      token: invite.token,
      userId: memberUserId,
    });
    await orgModel.allocateMemberCredit({
      createdByUserId: ownerId,
      orgId: org.id,
      orgMemberId: member.id,
      period: 'daily',
      periodAmountMicroUsd: usd(5),
    });
    await db
      .update(memberBudgets)
      .set({
        nextRenewalAt: new Date(Date.now() - 60_000),
        openrouterKeyCiphertext: 'cipher',
        openrouterKeyId: `mock-key-${n}`,
        settledUsageMicroUsd: usd(5),
      })
      .where(eq(memberBudgets.orgMemberId, member.id));
    return org;
  };

  it('keeps renewing the other orgs when one org throws', async () => {
    await dueOrg(1);
    await dueOrg(2);
    const keyService = {
      disableMemberKey: vi.fn(async () => null),
      ensureMemberKey: vi.fn(async () => ({ created: false, keyId: 'mock-key' })),
      settleMemberPeriod: vi.fn(async () => ({ remainingMicroUsd: 0, usageMicroUsd: usd(5) })),
    } as unknown as AicoOpenRouterKeyService;
    multiplierMock.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const results = await processDueRenewals(db, { keyService });

    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.status === 'failed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'funded')).toHaveLength(1);
  });
});
