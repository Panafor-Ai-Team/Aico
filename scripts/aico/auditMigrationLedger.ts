import path from 'node:path';

import pg from 'pg';

import { analyzeLedger, type LedgerReport, readJournal } from './migrationLedger';

const { Pool } = pg;

/**
 * Read-only audit of the Drizzle migration ledger.
 *
 * Point DATABASE_URL at a **disposable database restored from a backup** — never
 * at production. The script never writes: it runs inside a READ ONLY
 * transaction and only issues SELECTs.
 *
 * It maps every `drizzle.__drizzle_migrations` row to a journal entry by
 * `created_at` (== the entry's `when`) and reports:
 * - entries with no row, and whether the stock drizzle migrator will ever apply
 *   them (it skips any entry older than the newest applied row);
 * - whether the tables those missing entries create exist anyway;
 * - rows matching no entry, duplicate rows, and hash drift;
 * - what the stock migrator would apply right now.
 *
 * Usage:
 *   DATABASE_URL=postgres://… tsx scripts/aico/auditMigrationLedger.ts
 *   … --journal-dir=/path/to/a --journal-dir=/path/to/b   # simulate other journals
 *
 * By default it reads both journals, `migrations/` then `migrations-aico/`, which record into
 * the one ledger table.
 *   … --json
 */

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const journalDirArgs = args
  .filter((arg) => arg.startsWith('--journal-dir='))
  .map((arg) => arg.slice('--journal-dir='.length));
const migrationsFolders =
  journalDirArgs.length > 0
    ? journalDirArgs
    : ['migrations', 'migrations-aico'].map((folder) =>
        path.join(__dirname, '../../packages/database', folder),
      );

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const formatWhen = (when: number | null) => (when === null ? 'n/a' : new Date(when).toISOString());

const printReport = (report: LedgerReport, tablePresence: Record<string, boolean>) => {
  console.log(`Journals: ${migrationsFolders.join(', ')}`);
  console.log(`Matched entries: ${report.matched}`);
  console.log(`Newest applied created_at: ${formatWhen(report.maxCreatedAt)}`);

  console.log(`\nMissing entries (${report.missing.length}):`);
  for (const entry of report.missing) {
    const tables = entry.createdTables
      .map((table) => `${table}=${tablePresence[table] ? 'present' : 'absent'}`)
      .join(', ');
    console.log(
      `  ${entry.tag} (${formatWhen(entry.when)})` +
        (entry.skippedByDrizzle ? ' — SKIPPED by drizzle (older than newest row)' : ' — pending') +
        (tables ? ` [${tables}]` : ''),
    );
  }

  console.log(`\nRows matching no journal entry (${report.unknownRows.length}):`);
  for (const row of report.unknownRows) {
    console.log(
      `  id=${row.id} created_at=${formatWhen(row.createdAt)} hash=${row.hash.slice(0, 12)}`,
    );
  }

  console.log(`\nDuplicate rows (${report.duplicateRows.length}):`);
  for (const row of report.duplicateRows) {
    console.log(`  id=${row.id} created_at=${formatWhen(row.createdAt)}`);
  }

  console.log(`\nHash drift (${report.hashDrift.length}):`);
  for (const drift of report.hashDrift) {
    console.log(
      `  ${drift.tag}: applied ${drift.appliedHash.slice(0, 12)} → file ${drift.currentHash.slice(0, 12)}`,
    );
  }

  console.log(`\nStock drizzle migrator would apply now (${report.drizzlePending.length}):`);
  for (const entry of report.drizzlePending) console.log(`  ${entry.tag}`);
};

const main = async () => {
  const journal = migrationsFolders.flatMap((folder) => readJournal(folder));
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    await client.query('BEGIN READ ONLY');

    const ledger = await client.query<{ created_at: string; hash: string; id: number }>(
      `SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
    );
    const rows = ledger.rows.map((row) => ({
      createdAt: Number(row.created_at),
      hash: row.hash,
      id: row.id,
    }));

    const report = analyzeLedger(journal, rows);

    const probeTables = [...new Set(report.missing.flatMap((entry) => entry.createdTables))];
    const tablePresence: Record<string, boolean> = {};
    for (const table of probeTables) {
      const result = await client.query<{ present: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [table],
      );
      tablePresence[table] = result.rows[0]?.present ?? false;
    }

    await client.query('ROLLBACK');

    if (asJson) {
      console.log(JSON.stringify({ migrationsFolders, report, tablePresence }, null, 2));
    } else {
      printReport(report, tablePresence);
    }

    const hasFindings =
      report.missing.some((entry) => entry.skippedByDrizzle) ||
      report.unknownRows.length > 0 ||
      report.duplicateRows.length > 0;
    process.exitCode = hasFindings ? 2 : 0;
  } finally {
    client.release();
    await pool.end();
  }
};

main().catch((error) => {
  console.error('❌ Ledger audit failed:', error);
  process.exit(1);
});
