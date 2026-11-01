// @vitest-environment node
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * 0160 creates the five foreign keys `aicoOrganization.ts` declared but no
 * migration ever created. Existing databases may hold references to rows that
 * are gone; the migration must clear exactly those (keeping the old id on the
 * row), leave valid references and money columns alone, and be re-runnable.
 */
const TAG = '0160_aico_billing_foreign_keys';
// Both journals in production order: upstream-shaped `migrations/`, then `migrations-aico/`.
const migrations = ['migrations', 'migrations-aico'].flatMap((folder) =>
  readMigrationFiles({ migrationsFolder: path.join(__dirname, '../../..', folder) }),
);
const target = migrations.find((m) => m.folderMillis === 1_793_469_018_920);
if (!target) throw new Error(`${TAG} not found in the journal`);
const before = migrations.filter((m) => m.folderMillis !== target.folderMillis);

const usesPgSearch = (statements: string[]) => statements.some((s) => /pg_search|bm25/i.test(s));

const apply = async (db: PGlite, statements: string[]) => {
  for (const statement of statements) await db.exec(statement);
};

const FOREIGN_KEYS = [
  'aico_key_outbox_org_id_organizations_id_fk',
  'aico_key_outbox_org_member_id_organization_members_id_fk',
  'aico_key_outbox_user_id_users_id_fk',
  'user_wallets_preferred_organization_id_organizations_id_fk',
  'wallet_transactions_org_member_id_organization_members_id_fk',
];

let db: PGlite;
const notices: string[] = [];

const rowOf = async <T>(sql: string) => (await db.query<T>(sql)).rows[0];

beforeAll(async () => {
  db = new PGlite({ extensions: { vector } });
  for (const migration of before) {
    if (!usesPgSearch(migration.sql)) await apply(db, migration.sql);
  }

  // Today's databases have no FKs on these columns, so dangling ids can exist.
  await db.exec(`
    INSERT INTO users (id) VALUES ('u1'), ('u2');
    INSERT INTO organizations (id, name, slug, public_code, owner_user_id) VALUES ('o1', 'Org', 'org', 'ORG-1', 'u1');
    INSERT INTO organization_members (id, org_id, user_id, role) VALUES ('m1', 'o1', 'u1', 'member');

    INSERT INTO aico_key_outbox (id, action, org_id, org_member_id, user_id, next_attempt_at, payload) VALUES
      ('ob-valid', 'disable_member_key', 'o1', 'm1', 'u1', now(), '{"keep": 1}'),
      ('ob-orphan', 'disable_member_key', 'gone-org', 'gone-member', 'gone-user', now(), '{"keep": 2}'),
      ('ob-null-payload', 'disable_user_key', NULL, NULL, 'gone-user', now(), NULL);

    INSERT INTO user_wallets (id, user_id, preferred_organization_id) VALUES
      ('w-valid', 'u1', 'o1'),
      ('w-orphan', 'u2', 'gone-org');

    INSERT INTO wallet_transactions (id, org_id, org_member_id, type, amount_toman, amount_micro_usd, metadata) VALUES
      ('t-valid', 'o1', 'm1', 'allocate', 100, 2000, '{"note": "a"}'),
      ('t-orphan', 'o1', 'gone-member', 'allocate', 300, 4000, '{"note": "b"}');
  `);

  for (const statement of target.sql) {
    await db.query(statement, [], { onNotice: (notice) => notices.push(notice.message ?? '') });
  }
});

describe(TAG, () => {
  it('creates every declared foreign key, validated, with ON DELETE SET NULL', async () => {
    const { rows } = await db.query<{ conname: string; convalidated: boolean; def: string }>(
      `SELECT conname, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = ANY($1::text[]) ORDER BY conname`,
      [FOREIGN_KEYS],
    );

    expect(rows.map((row) => row.conname)).toEqual(FOREIGN_KEYS);
    for (const row of rows) {
      expect(row.convalidated).toBe(true);
      expect(row.def).toContain('ON DELETE SET NULL');
    }
  });

  it('clears dangling references and keeps the old ids on the row', async () => {
    expect(
      await rowOf(
        `SELECT org_id, org_member_id, user_id, payload FROM aico_key_outbox WHERE id = 'ob-orphan'`,
      ),
    ).toEqual({
      org_id: null,
      org_member_id: null,
      payload: {
        aicoOrphanedRefs: { orgId: 'gone-org', orgMemberId: 'gone-member', userId: 'gone-user' },
        keep: 2,
      },
      user_id: null,
    });
    expect(
      await rowOf(`SELECT user_id, payload FROM aico_key_outbox WHERE id = 'ob-null-payload'`),
    ).toEqual({
      payload: { aicoOrphanedRefs: { userId: 'gone-user' } },
      user_id: null,
    });
    expect(
      await rowOf(`SELECT preferred_organization_id FROM user_wallets WHERE id = 'w-orphan'`),
    ).toEqual({ preferred_organization_id: null });
    expect(
      await rowOf(
        `SELECT org_member_id, amount_toman, amount_micro_usd, metadata FROM wallet_transactions WHERE id = 't-orphan'`,
      ),
    ).toEqual({
      amount_micro_usd: 4000,
      amount_toman: 300,
      metadata: { aicoOrphanedRefs: { orgMemberId: 'gone-member' }, note: 'b' },
      org_member_id: null,
    });
  });

  it('leaves valid references untouched', async () => {
    expect(
      await rowOf(
        `SELECT org_id, org_member_id, user_id, payload FROM aico_key_outbox WHERE id = 'ob-valid'`,
      ),
    ).toEqual({ org_id: 'o1', org_member_id: 'm1', payload: { keep: 1 }, user_id: 'u1' });
    expect(
      await rowOf(`SELECT preferred_organization_id FROM user_wallets WHERE id = 'w-valid'`),
    ).toEqual({ preferred_organization_id: 'o1' });
    expect(
      await rowOf(`SELECT org_member_id, metadata FROM wallet_transactions WHERE id = 't-valid'`),
    ).toEqual({ metadata: { note: 'a' }, org_member_id: 'm1' });
  });

  it('reports what it cleared', () => {
    expect(notices.filter((message) => /^\w+\.\w+: \d+ orphaned/.test(message)).toSorted()).toEqual(
      [
        'aico_key_outbox.org_id: 1 orphaned reference(s) set to NULL',
        'aico_key_outbox.org_member_id: 1 orphaned reference(s) set to NULL',
        'aico_key_outbox.user_id: 2 orphaned reference(s) set to NULL',
        'user_wallets.preferred_organization_id: 1 orphaned reference(s) set to NULL',
        'wallet_transactions.org_member_id: 1 orphaned reference(s) set to NULL',
      ],
    );
  });

  it('renames the reconciliation-runs FK to the name the schema generates', async () => {
    const { rows } = await db.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'aico_reconciliation_runs'::regclass AND contype = 'f'`,
    );

    expect(rows.map((row) => row.conname)).toEqual([
      'aico_reconciliation_runs_triggered_by_admin_id_platform_admin_u',
    ]);
  });

  it('is a no-op when run again', async () => {
    const snapshot = async () =>
      (
        await db.query(
          `SELECT 'outbox' AS t, to_jsonb(o) AS row FROM aico_key_outbox o
           UNION ALL SELECT 'wallet', to_jsonb(w) FROM user_wallets w
           UNION ALL SELECT 'tx', to_jsonb(x) FROM wallet_transactions x
           UNION ALL SELECT 'con', to_jsonb(c.conname) FROM pg_constraint c WHERE c.contype = 'f'
           ORDER BY 1, 2`,
        )
      ).rows;
    const first = await snapshot();

    await apply(db, target.sql);

    expect(await snapshot()).toEqual(first);
  });

  it('enforces the new keys: deleting a member clears its references', async () => {
    await db.exec(`DELETE FROM organization_members WHERE id = 'm1'`);

    expect(
      await rowOf(`SELECT org_member_id FROM wallet_transactions WHERE id = 't-valid'`),
    ).toEqual({ org_member_id: null });
    expect(await rowOf(`SELECT org_member_id FROM aico_key_outbox WHERE id = 'ob-valid'`)).toEqual({
      org_member_id: null,
    });
    await expect(
      db.exec(`UPDATE user_wallets SET preferred_organization_id = 'nope' WHERE id = 'w-valid'`),
    ).rejects.toThrow(/foreign key/);
  });
});
