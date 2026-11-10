/**
 * Aico Phase 2 — Multi-org billing context + migration / schema probes
 * Maps: AICO-P1-008, AICO-P1-012, AICO-P1-013 (constraint), AICO-P1-015
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import type { LobeChatDatabase } from '../../type';
import { AicoBillingModel } from '../aicoBilling';
import { OrganizationModel } from '../organization';
import { cleanupAicoTables, seedUsers } from './aico.phase2.helpers';

const serverDB: LobeChatDatabase = await getTestDB();
const orgModel = new OrganizationModel(serverDB);
const billing = new AicoBillingModel(serverDB);

const userId = 'p2-multi-user';
const ownerA = 'p2-multi-owner-a';
const ownerB = 'p2-multi-owner-b';

beforeEach(async () => {
  await cleanupAicoTables(serverDB);
  await seedUsers(serverDB, [
    { email: 'multi@example.com', id: userId },
    { email: 'ownera@example.com', id: ownerA },
    { email: 'ownerb@example.com', id: ownerB },
  ]);
});

afterEach(async () => {
  await cleanupAicoTables(serverDB);
});

describe('Aico multi-organization billing context (Phase 2)', () => {
  it('AICO-P1-008: a user holds one active org membership, so no first-match org is ever picked', async () => {
    // The finding: with two active memberships, key resolution silently used whichever
    // org listForUser returned first. Fixed structurally: a user may be active in at
    // most one organization (organization_members_unique_active_user_idx), and managed
    // calls name their org in an explicit billing context (AicoManagedPolicy.authorize).
    const orgA = await orgModel.createOrganization({ name: 'OrgA', ownerUserId: ownerA });
    const orgB = await orgModel.createOrganization({ name: 'OrgB', ownerUserId: ownerB });
    const invite = (org: typeof orgA) =>
      orgModel.createInvite({
        identifierType: 'email',
        identifierValue: 'multi@example.com',
        invitedByUserId: org.ownerUserId,
        orgId: org.id,
        role: 'member',
      });

    const inviteA = await invite(orgA);
    const inviteB = await invite(orgB);
    await orgModel.acceptInvite({ email: 'multi@example.com', token: inviteA.token, userId });

    await expect(
      orgModel.acceptInvite({ email: 'multi@example.com', token: inviteB.token, userId }),
    ).rejects.toThrow('USER_ALREADY_IN_ORGANIZATION');

    const listed = await orgModel.listForUser(userId);
    expect(listed.map((org) => org.id)).toEqual([orgA.id]);
    expect(await orgModel.getMemberByUser({ orgId: orgB.id, userId })).toBeFalsy();
  });

  it('AICO-P1-008: the database refuses a second active membership even if the check is bypassed', async () => {
    const orgA = await orgModel.createOrganization({ name: 'OrgA', ownerUserId: ownerA });
    const orgB = await orgModel.createOrganization({ name: 'OrgB', ownerUserId: ownerB });
    await serverDB.execute(
      sql`INSERT INTO organization_members (id, org_id, user_id, role, status) VALUES ('p2-m-a', ${orgA.id}, ${userId}, 'member', 'active')`,
    );

    await expect(
      serverDB.execute(
        sql`INSERT INTO organization_members (id, org_id, user_id, role, status) VALUES ('p2-m-b', ${orgB.id}, ${userId}, 'member', 'active')`,
      ),
    ).rejects.toThrow();
  });
});

describe('Aico migration & schema safety (Phase 2)', () => {
  it('AICO-P1-012: migration 0132 adds usage_logs.user_id nullable, then guards NOT NULL', () => {
    const sqlPath = join(__dirname, '../../../migrations-aico/0132_shocking_blizzard.sql');
    const body = readFileSync(sqlPath, 'utf8');
    // The unsafe one-step form (fails on any table with rows) must not be used.
    expect(body).not.toMatch(/ADD COLUMN (IF NOT EXISTS )?"user_id" text NOT NULL(?! DEFAULT)/);
    // Added nullable, and NOT NULL only once no row is NULL; otherwise stop loudly.
    expect(body).toContain('ALTER TABLE "usage_logs" ADD COLUMN IF NOT EXISTS "user_id" text;');
    expect(body).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM "usage_logs" WHERE "user_id" IS NULL\) THEN\s+ALTER TABLE "usage_logs" ALTER COLUMN "user_id" SET NOT NULL;\s+ELSE\s+RAISE EXCEPTION/,
    );
  });

  it('AICO-P1-012: adding NOT NULL column without default fails when usage_logs has rows', async () => {
    // Simulate the hazard on a scratch table (do not mutate live usage_logs schema permanently).
    await serverDB.execute(sql`
      CREATE TABLE IF NOT EXISTS aico_p2_usage_scratch (
        id text PRIMARY KEY,
        org_id text
      )
    `);
    await serverDB.execute(sql`DELETE FROM aico_p2_usage_scratch`);
    await serverDB.execute(sql`INSERT INTO aico_p2_usage_scratch (id, org_id) VALUES ('u1', 'o1')`);

    let failed = false;
    try {
      await serverDB.execute(
        sql`ALTER TABLE aico_p2_usage_scratch ADD COLUMN user_id text NOT NULL`,
      );
    } catch {
      failed = true;
    }

    await serverDB.execute(sql`DROP TABLE IF EXISTS aico_p2_usage_scratch`);
    // PostgreSQL/PGlite must reject NOT NULL add without default when rows exist.
    expect(failed).toBe(true);
  });

  it('AICO-P1-013: user_trials phone_fingerprint index is not UNIQUE in migration SQL', () => {
    const sqlPath = join(__dirname, '../../../migrations-aico/0132_shocking_blizzard.sql');
    const body = readFileSync(sqlPath, 'utf8');
    expect(body).toContain('user_trials_phone_fingerprint_idx');
    expect(body).not.toMatch(/CREATE UNIQUE INDEX "user_trials_phone_fingerprint/);
  });

  it('AICO-P1-015: recordUsage can write rows but chat path does not call it (probe after manual record)', async () => {
    await billing.recordUsage({
      billingSource: 'personal',
      completionTokens: 10,
      // recordUsage takes micro-USD, not USD: 0.01 USD = 10_000 micro-USD.
      costMicroUsd: 10_000,
      modelId: 'openai/gpt-4o-mini',
      promptTokens: 5,
      totalTokens: 15,
      userId,
    });
    const logs = await billing.listUserUsage(userId, 10);
    expect(logs.length).toBeGreaterThan(0);
    // Chat wiring absence is asserted in apps/server chat-bypass suite.
  });
});
