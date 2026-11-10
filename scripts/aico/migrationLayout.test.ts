import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readJournal } from './migrationLedger';

/**
 * `packages/database/migrations` is upstream LobeHub's journal, taken verbatim on every
 * sync; Aico's own migrations live in `packages/database/migrations-aico`. A migration in
 * the main journal that touches an Aico table is either an Aico migration in the wrong
 * folder (it would be lost on the next sync) or an upstream migration colliding with an
 * Aico table name (it must be reviewed before it can run).
 */
const repoRoot = path.join(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8');

const aicoTables = [
  ...read('packages/database/src/schemas/aicoOrganization.ts').matchAll(/pgTable\(\s*'([a-z_]+)'/g),
].map((match) => match[1]);

/** Statement targets: CREATE/ALTER/DROP TABLE, INSERT INTO, UPDATE, DELETE FROM, INDEX … ON, REFERENCES. */
const touchesTable = (sql: string, table: string) =>
  new RegExp(
    String.raw`\b(?:TABLE|INTO|UPDATE|FROM|ON|REFERENCES)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?(?:"?public"?\.)?"?${table}"?(?![\w"])`,
    'i',
  ).test(sql);

describe('migration layout', () => {
  it('finds the Aico tables', () => {
    expect(aicoTables.length).toBeGreaterThan(20);
    expect(aicoTables).toEqual(expect.arrayContaining(['wallet_transactions', 'organizations']));
  });

  it('detects statements on a table, not mentions of a longer name', () => {
    expect(touchesTable('ALTER TABLE "organizations" ADD COLUMN x int', 'organizations')).toBe(
      true,
    );
    expect(touchesTable('CREATE INDEX i ON public.organizations (id)', 'organizations')).toBe(true);
    expect(touchesTable('REFERENCES "public"."organizations"("id")', 'organizations')).toBe(true);
    expect(touchesTable('ALTER TABLE "organizations_x" ADD x int', 'organizations')).toBe(false);
  });

  it('keeps every Aico table out of the upstream-shaped main journal', () => {
    const violations = readJournal(path.join(repoRoot, 'packages/database/migrations')).flatMap(
      (entry) => {
        const sql = read(`packages/database/migrations/${entry.tag}.sql`);
        return aicoTables
          .filter((table) => touchesTable(sql, table))
          .map((table) => `${entry.tag} → ${table}`);
      },
    );

    expect(violations).toEqual([]);
  });

  it('keeps Aico-named migrations in the Aico journal', () => {
    const misplaced = readJournal(path.join(repoRoot, 'packages/database/migrations'))
      .map((entry) => entry.tag)
      .filter((tag) => /aico/i.test(tag));

    expect(misplaced).toEqual([]);
  });
});
