/**
 * Migration 0156 — usage ledger columns, `usage_holds` and `aico_ledger_state`.
 *
 * The migration must be purely additive: every new column defaults to a value
 * that leaves today's behaviour unchanged, and the control row exists unpaused.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { aicoLedgerState, usageLogs, userWallets } from '../../schemas/aicoOrganization';
import type { LobeChatDatabase } from '../../type';
import { cleanupAicoTables, seedUsers } from './aico.phase2.helpers';

const serverDB: LobeChatDatabase = await getTestDB();
const userId = 'ledger-mig-user';

beforeEach(async () => {
  await cleanupAicoTables(serverDB);
  await seedUsers(serverDB, [{ email: 'ledger-mig@example.com', id: userId }]);
});

afterEach(async () => {
  await cleanupAicoTables(serverDB);
});

describe('migration 0156 usage ledger', () => {
  it('seeds an unpaused default ledger state row', async () => {
    const rows = await serverDB.select().from(aicoLedgerState);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      enforceStartedAt: null,
      id: 'default',
      paused: false,
      snapshotCompletedAt: null,
    });
  });

  it('defaults the new wallet ledger columns to zero', async () => {
    await serverDB.insert(userWallets).values({ userId });
    const wallet = await serverDB.query.userWallets.findFirst({
      where: eq(userWallets.userId, userId),
    });
    expect(wallet).toMatchObject({ openHolds: 0, rawHeldMicroUsd: 0, rawUsedMicroUsd: 0 });
  });

  it('allows one usage_logs row per hold id and any number without one', async () => {
    const base = { modelId: 'glm-5.3-flash', userId };
    await serverDB.insert(usageLogs).values([base, base]);
    await serverDB.insert(usageLogs).values({ ...base, holdId: 'uhld_1' });
    await expect(
      serverDB.insert(usageLogs).values({ ...base, holdId: 'uhld_1' }),
    ).rejects.toThrow();

    const rows = await serverDB.select().from(usageLogs);
    expect(rows).toHaveLength(3);
  });
});
