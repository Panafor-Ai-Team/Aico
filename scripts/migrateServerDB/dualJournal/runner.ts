import { readMigrationFiles } from 'drizzle-orm/migrator';

import { readJournal } from '../../aico/migrationLedger';

/**
 * SPIKE — prototype of the "dual journal, single ledger" migration runner (design D2 in the
 * upstream-modernization plan). Not wired into `docker.cjs`, `index.ts` or `getTestDB`.
 *
 * Upstream migrations stay verbatim in one journal and Aico's own migrations live in a
 * second journal; both record into the existing `drizzle.__drizzle_migrations` table. A
 * journal entry counts as applied when a ledger row's `created_at` equals the entry's
 * `when` (journal `when` values are unique and never rewritten, which the ledger audit
 * tests pin). Unlike drizzle's migrator it does not gate on the newest `created_at`, so an
 * entry stamped older than one already applied is still picked up, and it never re-runs an
 * entry whose file changed after it was applied.
 */

export interface MigrationEntry {
  hash: string;
  statements: string[];
  tag: string;
  when: number;
}

export interface MigrationTrack {
  entries: MigrationEntry[];
  name: string;
}

/** Single-connection executor; transactions are issued as plain BEGIN / COMMIT. */
export interface MigrationExecutor {
  exec: (sql: string) => Promise<void>;
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
}

export interface LedgerRowSnapshot {
  createdAt: number;
  hash: string;
  id: number;
}

export interface DualJournalReport {
  applied: string[];
  /** Applied earlier (matched by `when`) but the file changed since; never re-run. */
  drift: Array<{ appliedHash: string; currentHash: string; tag: string }>;
  /** Satisfied by an equivalent entry already applied from the other track. */
  equivalent: string[];
  /** Recorded as applied without executing (test environments only). */
  skipped: string[];
  /** Ledger rows matching no entry of any track. */
  unknownRows: LedgerRowSnapshot[];
}

export class DualJournalMigrationError extends Error {
  constructor(
    readonly tag: string,
    readonly report: DualJournalReport,
    options: { cause: unknown },
  ) {
    super(`Migration ${tag} failed; earlier migrations stay committed`, options);
    this.name = 'DualJournalMigrationError';
  }
}

export interface RunDualJournalOptions {
  /** Tag → `when` of an entry (in any track) whose ledger row also satisfies this tag. */
  equivalences?: Record<string, number>;
  executor: MigrationExecutor;
  lockKey?: number;
  /** Record without executing, e.g. pg_search/BM25 statements on PGlite. Tests only. */
  skip?: (entry: MigrationEntry) => boolean;
  tracks: MigrationTrack[];
}

const DEFAULT_LOCK_KEY = 726_000_001;

/** Reads a migrations folder (journal + .sql files) into a track. */
export const readTrack = (name: string, migrationsFolder: string): MigrationTrack => {
  const journal = readJournal(migrationsFolder);
  const files = readMigrationFiles({ migrationsFolder });

  return {
    entries: journal.map((entry, index) => {
      if (files[index].hash !== entry.hash) {
        throw new Error(`Journal and drizzle disagree on ${entry.tag} in ${migrationsFolder}`);
      }
      return { hash: entry.hash, statements: files[index].sql, tag: entry.tag, when: entry.when };
    }),
    name,
  };
};

export const readLedger = async (executor: MigrationExecutor): Promise<LedgerRowSnapshot[]> => {
  const rows = await executor.query<{ created_at: string | number; hash: string; id: number }>(
    'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
  );
  return rows.map((row) => ({ createdAt: Number(row.created_at), hash: row.hash, id: row.id }));
};

export const runDualJournal = async ({
  equivalences = {},
  executor,
  lockKey = DEFAULT_LOCK_KEY,
  skip,
  tracks,
}: RunDualJournalOptions): Promise<DualJournalReport> => {
  await executor.exec('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await executor.exec(
    'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
  );
  await executor.query('SELECT pg_advisory_lock($1)', [lockKey]);

  const report: DualJournalReport = {
    applied: [],
    drift: [],
    equivalent: [],
    skipped: [],
    unknownRows: [],
  };

  try {
    const rows = await readLedger(executor);
    const rowsByWhen = new Map<number, LedgerRowSnapshot[]>();
    for (const row of rows)
      rowsByWhen.set(row.createdAt, [...(rowsByWhen.get(row.createdAt) ?? []), row]);

    const knownWhens = new Set([
      ...tracks.flatMap((track) => track.entries.map((entry) => entry.when)),
      ...Object.values(equivalences),
    ]);
    report.unknownRows = rows.filter((row) => !knownWhens.has(row.createdAt));

    for (const track of tracks) {
      for (const entry of track.entries) {
        const applied = rowsByWhen.get(entry.when);
        if (applied) {
          if (!applied.some((row) => row.hash === entry.hash)) {
            report.drift.push({
              appliedHash: applied[0].hash,
              currentHash: entry.hash,
              tag: entry.tag,
            });
          }
          continue;
        }

        const equivalentWhen = equivalences[entry.tag];
        if (equivalentWhen !== undefined && rowsByWhen.has(equivalentWhen)) {
          report.equivalent.push(entry.tag);
          continue;
        }

        const skipped = skip?.(entry) ?? false;
        await executor.exec('BEGIN');
        try {
          if (!skipped) {
            for (const statement of entry.statements) await executor.exec(statement);
          }
          await executor.query(
            'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
            [entry.hash, entry.when],
          );
          await executor.exec('COMMIT');
        } catch (error) {
          await executor.exec('ROLLBACK');
          throw new DualJournalMigrationError(entry.tag, report, { cause: error });
        }

        rowsByWhen.set(entry.when, [{ createdAt: entry.when, hash: entry.hash, id: -1 }]);
        (skipped ? report.skipped : report.applied).push(entry.tag);
      }
    }

    return report;
  } finally {
    await executor.query('SELECT pg_advisory_unlock($1)', [lockKey]);
  }
};

/** What drizzle's own migrator would apply: entries newer than the newest `created_at`. */
export const stockDrizzlePending = (track: MigrationTrack, rows: LedgerRowSnapshot[]): string[] => {
  if (rows.length === 0) return track.entries.map((entry) => entry.tag);
  const newest = Math.max(...rows.map((row) => row.createdAt));
  return track.entries.filter((entry) => entry.when > newest).map((entry) => entry.tag);
};
