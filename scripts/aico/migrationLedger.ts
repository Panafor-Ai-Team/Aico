import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Pure analysis of a Drizzle migration ledger (`drizzle.__drizzle_migrations`)
 * against a migrations journal. Used by `auditMigrationLedger.ts`; kept free of
 * database access so the matching rules are unit-testable.
 *
 * Drizzle records each applied migration as `(hash, created_at)` where
 * `created_at` is the journal entry's `when` (folderMillis). Its migrator then
 * only applies entries whose `when` is greater than the newest `created_at`, so
 * a ledger can silently miss entries whose `when` is older than one already
 * applied. This module surfaces exactly those situations.
 */

export interface JournalEntry {
  /** SQL statements' CREATE TABLE targets, used to probe whether a missing entry ran anyway. */
  createdTables: string[];
  /** sha256 of the .sql file, computed exactly like drizzle-orm's readMigrationFiles. */
  hash: string;
  idx: number;
  tag: string;
  when: number;
}

export interface LedgerRow {
  createdAt: number;
  hash: string;
  id: number;
}

export interface LedgerReport {
  /** Entries the stock drizzle migrator would apply right now (when > newest created_at). */
  drizzlePending: Array<Pick<JournalEntry, 'tag' | 'when'>>;
  /** Rows sharing a created_at with another row (double-applied or concurrent runs). */
  duplicateRows: LedgerRow[];
  /** Matched by created_at, but the file content changed since it was applied. */
  hashDrift: Array<{ appliedHash: string; currentHash: string; tag: string }>;
  matched: number;
  maxCreatedAt: number | null;
  /** Entries with no ledger row. Ones older than maxCreatedAt are never applied by drizzle. */
  missing: Array<
    Pick<JournalEntry, 'createdTables' | 'tag' | 'when'> & { skippedByDrizzle: boolean }
  >;
  /** Rows that match no journal entry by created_at. */
  unknownRows: LedgerRow[];
}

const CREATE_TABLE_RE = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"(?:\w+"\.")?(\w+)"/gi;

export const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

export const extractCreatedTables = (sql: string): string[] => [
  ...new Set([...sql.matchAll(CREATE_TABLE_RE)].map((match) => match[1])),
];

/** Reads `meta/_journal.json` plus each entry's .sql file from a migrations folder. */
export const readJournal = (migrationsFolder: string): JournalEntry[] => {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number; tag: string; when: number }> };

  return journal.entries.map((entry) => {
    const sql = readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), 'utf8');

    return {
      createdTables: extractCreatedTables(sql),
      hash: sha256(sql),
      idx: entry.idx,
      tag: entry.tag,
      when: entry.when,
    };
  });
};

export const analyzeLedger = (journal: JournalEntry[], rows: LedgerRow[]): LedgerReport => {
  const rowsByCreatedAt = new Map<number, LedgerRow[]>();
  for (const row of rows) {
    const bucket = rowsByCreatedAt.get(row.createdAt) ?? [];
    bucket.push(row);
    rowsByCreatedAt.set(row.createdAt, bucket);
  }

  const maxCreatedAt = rows.length > 0 ? Math.max(...rows.map((row) => row.createdAt)) : null;
  const journalWhens = new Set(journal.map((entry) => entry.when));

  const report: LedgerReport = {
    drizzlePending: [],
    duplicateRows: [],
    hashDrift: [],
    matched: 0,
    maxCreatedAt,
    missing: [],
    unknownRows: rows.filter((row) => !journalWhens.has(row.createdAt)),
  };

  for (const bucket of rowsByCreatedAt.values()) {
    if (bucket.length > 1) report.duplicateRows.push(...bucket);
  }

  for (const entry of journal) {
    const applied = rowsByCreatedAt.get(entry.when);

    if (!applied) {
      report.missing.push({
        createdTables: entry.createdTables,
        skippedByDrizzle: maxCreatedAt !== null && entry.when <= maxCreatedAt,
        tag: entry.tag,
        when: entry.when,
      });
    } else {
      report.matched += 1;
      const drift = applied.find((row) => row.hash !== entry.hash);
      if (drift && !applied.some((row) => row.hash === entry.hash)) {
        report.hashDrift.push({
          appliedHash: drift.hash,
          currentHash: entry.hash,
          tag: entry.tag,
        });
      }
    }

    if (maxCreatedAt === null || entry.when > maxCreatedAt) {
      report.drizzlePending.push({ tag: entry.tag, when: entry.when });
    }
  }

  return report;
};
