/**
 * "Dual journal, single ledger" migration runner (design D2, see
 * docs/aico/MIGRATION_LEDGER_SPIKE.md). Opt-in via `AICO_MIGRATION_RUNNER=dual`; the stock
 * Drizzle migrator stays the default.
 *
 * Journal entries record into the existing `drizzle.__drizzle_migrations` table. An entry
 * counts as applied when a ledger row's `created_at` equals the entry's `when` (journal
 * `when` values are unique and never rewritten — pinned by the ledger audit tests). Unlike
 * Drizzle's migrator it does not gate on the newest `created_at`, so an entry stamped older
 * than one already applied is still picked up; each migration commits on its own; an
 * advisory lock serializes concurrent runners; an entry whose file changed after it was
 * applied is reported, never re-run.
 *
 * Plain CommonJS because the Docker image runs it beside `docker.cjs` without bundling.
 */

const fs = require('node:fs');
const path = require('node:path');
const { readMigrationFiles } = require('drizzle-orm/migrator');

const DEFAULT_LOCK_KEY = 726_000_001;

/**
 * @typedef {{ hash: string, statements: string[], tag: string, when: number }} MigrationEntry
 * @typedef {{ entries: MigrationEntry[], name: string }} MigrationTrack
 * @typedef {{ createdAt: number, hash: string, id: number }} LedgerRow
 * @typedef {{
 *   exec: (sql: string) => Promise<void>,
 *   query: (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>,
 * }} MigrationExecutor
 * @typedef {{
 *   applied: string[],
 *   drift: Array<{ appliedHash: string, currentHash: string, tag: string }>,
 *   equivalent: string[],
 *   skipped: string[],
 *   unknownRows: LedgerRow[],
 * }} DualJournalReport
 */

class DualJournalMigrationError extends Error {
  /**
   * @param {string} tag
   * @param {DualJournalReport} report
   * @param {{ cause: unknown }} options
   */
  constructor(tag, report, options) {
    super(`Migration ${tag} failed; earlier migrations stay committed`, options);
    this.name = 'DualJournalMigrationError';
    this.tag = tag;
    this.report = report;
  }
}

/**
 * Reads a migrations folder (journal + .sql files) into a track.
 * @param {string} name
 * @param {string} migrationsFolder
 * @returns {MigrationTrack}
 */
const readTrack = (name, migrationsFolder) => {
  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  );
  const files = readMigrationFiles({ migrationsFolder });

  return {
    entries: journal.entries.map((entry, index) => {
      const file = files[index];
      if (!file || file.folderMillis !== entry.when) {
        throw new Error(
          `Journal and migration files disagree at ${entry.tag} in ${migrationsFolder}`,
        );
      }
      return { hash: file.hash, statements: file.sql, tag: entry.tag, when: entry.when };
    }),
    name,
  };
};

/**
 * @param {MigrationExecutor} executor
 * @returns {Promise<LedgerRow[]>}
 */
const readLedger = async (executor) => {
  const rows = await executor.query(
    'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
  );
  return rows.map((row) => ({ createdAt: Number(row.created_at), hash: row.hash, id: row.id }));
};

/**
 * @param {{
 *   equivalences?: Record<string, number>,
 *   executor: MigrationExecutor,
 *   lockKey?: number,
 *   skip?: (entry: MigrationEntry) => boolean,
 *   tracks: MigrationTrack[],
 * }} options
 *   `equivalences`: tag → `when` of an entry (in any track) whose ledger row also satisfies it.
 *   `skip`: record without executing (e.g. pg_search/BM25 statements where unavailable).
 * @returns {Promise<DualJournalReport>}
 */
const runDualJournal = async ({
  equivalences = {},
  executor,
  lockKey = DEFAULT_LOCK_KEY,
  skip,
  tracks,
}) => {
  // Lock before bootstrapping the ledger: `CREATE … IF NOT EXISTS` is not safe under
  // concurrency, so two runners on a fresh database (e.g. blue/green slots booting together)
  // would otherwise race on creating the schema.
  await executor.query('SELECT pg_advisory_lock($1)', [lockKey]);

  /** @type {DualJournalReport} */
  const report = { applied: [], drift: [], equivalent: [], skipped: [], unknownRows: [] };

  try {
    await executor.exec('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await executor.exec(
      'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
    );
    const rows = await readLedger(executor);
    /** @type {Map<number, LedgerRow[]>} */
    const rowsByWhen = new Map();
    for (const row of rows) {
      rowsByWhen.set(row.createdAt, [...(rowsByWhen.get(row.createdAt) ?? []), row]);
    }

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

        const skipped = skip ? skip(entry) : false;
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

/**
 * What Drizzle's own migrator would apply: entries newer than the newest `created_at`.
 * @param {MigrationTrack} track
 * @param {LedgerRow[]} rows
 * @returns {string[]}
 */
const stockDrizzlePending = (track, rows) => {
  if (rows.length === 0) return track.entries.map((entry) => entry.tag);
  const newest = Math.max(...rows.map((row) => row.createdAt));
  return track.entries.filter((entry) => entry.when > newest).map((entry) => entry.tag);
};

/**
 * Executor over one dedicated `pg` client, so BEGIN / COMMIT apply to the same connection.
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} client
 * @returns {MigrationExecutor}
 */
const createPgExecutor = (client) => ({
  exec: async (sql) => {
    await client.query(sql);
  },
  query: async (sql, params) => (await client.query(sql, params)).rows,
});

/**
 * One-line summary for deploy logs.
 * @param {DualJournalReport} report
 */
const formatReport = (report) =>
  [
    `applied=${report.applied.length}`,
    `skipped=${report.skipped.length}`,
    `equivalent=${report.equivalent.length}`,
    `drift=${report.drift.length}${report.drift.length ? ` (${report.drift.map((d) => d.tag).join(', ')})` : ''}`,
    `unknownRows=${report.unknownRows.length}`,
  ].join(' ');

module.exports = {
  createPgExecutor,
  DualJournalMigrationError,
  formatReport,
  readLedger,
  readTrack,
  runDualJournal,
  stockDrizzlePending,
};
