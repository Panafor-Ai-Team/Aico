// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupAicoTables, seedUsers } from '@/database/models/__tests__/aico.phase2.helpers';
import { OrganizationModel } from '@/database/models/organization';
import {
  aicoKeyOutbox,
  aicoRenewalBatches,
  memberBudgets,
} from '@/database/schemas/aicoOrganization';
import type { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

import { executeOrgBudgetSweep, previewOrgBudgetSweep } from './orgBudgetSweep';

const ledger = vi.hoisted(() => ({ authoritative: false }));

vi.mock('@/server/services/aico/ledger/state', () => ({
  isLedgerAuthoritative: async () => ledger.authoritative,
  isLedgerPaused: async () => false,
}));

const usd = (n: number) => Math.round(n * 1_000_000);
const ownerId = 'ledger-sweep-owner';

let db: LobeChatDatabase;
let orgModel: OrganizationModel;

beforeEach(async () => {
  ledger.authoritative = false;
  db = await getTestDB();
  await db.delete(aicoKeyOutbox);
  await db.delete(aicoRenewalBatches);
  await cleanupAicoTables(db);
  await seedUsers(db, [{ email: 'ledger-sweep@example.com', id: ownerId }]);
  orgModel = new OrganizationModel(db);
});

/** Org funded with $20; the owner holds a $5 daily budget with $1 settled and $1 held. */
const setupOrg = async (keyId: string | null) => {
  const org = await orgModel.createOrganization({ name: 'Ledger Sweep', ownerUserId: ownerId });
  await orgModel.addManualCredit({
    amountMicroUsd: usd(20),
    amountToman: 100_000,
    createdByUserId: ownerId,
    fxRateTomanPerUsd: 5000,
    orgId: org.id,
  });
  const me = (await orgModel.listMembers(org.id)).find((m) => m.userId === ownerId)!;
  await orgModel.allocateMemberCredit({
    createdByUserId: ownerId,
    orgId: org.id,
    orgMemberId: me.id,
    period: 'daily',
    periodAmountMicroUsd: usd(5),
  });
  await db
    .update(memberBudgets)
    .set({
      heldMicroUsd: usd(1),
      openHolds: 1,
      openrouterKeyCiphertext: keyId ? 'cipher' : null,
      openrouterKeyId: keyId,
      settledUsageMicroUsd: usd(1),
    })
    .where(eq(memberBudgets.orgMemberId, me.id));
  return { member: me, org };
};

describe('org budget sweep under the usage ledger', () => {
  it('previews a keyless budget net of held spend', async () => {
    const { member, org } = await setupOrg(null);
    const keyService = { peekMemberRemaining: vi.fn() } as unknown as AicoOpenRouterKeyService;

    const preview = await previewOrgBudgetSweep({ db, keyService, orgId: org.id });

    const row = preview.rows.find((r) => r.memberId === member.id)!;
    expect(row.estimateSource).toBe('wallet-only');
    // $5 cap − $1 settled − $1 held.
    expect(row.reclaimMicroUsd).toBe(usd(3));
  });

  it('credits the figure computed under the row lock, not the key estimate', async () => {
    ledger.authoritative = true;
    const { member, org } = await setupOrg('cvc-key');
    const keyService = {
      reclaimMemberKey: vi.fn(async () => ({ remainingMicroUsd: usd(5), usageMicroUsd: 0 })),
    } as unknown as AicoOpenRouterKeyService;
    const before = Number((await orgModel.getById(org.id))!.walletBalanceMicroUsd);

    const result = await executeOrgBudgetSweep({
      actorUserId: ownerId,
      batchId: 'ledger-sweep-1',
      db,
      keyService,
      orgId: org.id,
    });

    expect(result.rows.find((r) => r.memberId === member.id)!.reclaimedMicroUsd).toBe(usd(3));
    expect(Number((await orgModel.getById(org.id))!.walletBalanceMicroUsd)).toBe(before + usd(3));
  });

  it('subtracts held from a keyless budget on execute without the ledger flag', async () => {
    const { member, org } = await setupOrg(null);
    const keyService = { reclaimMemberKey: vi.fn() } as unknown as AicoOpenRouterKeyService;

    const result = await executeOrgBudgetSweep({
      actorUserId: ownerId,
      batchId: 'ledger-sweep-2',
      db,
      keyService,
      orgId: org.id,
    });

    expect(keyService.reclaimMemberKey).not.toHaveBeenCalled();
    expect(result.rows.find((r) => r.memberId === member.id)!.reclaimedMicroUsd).toBe(usd(3));
  });
});
