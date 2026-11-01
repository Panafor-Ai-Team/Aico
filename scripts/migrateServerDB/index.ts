import { join } from 'node:path';

import * as dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';

import { isPgSearchUnavailableError, migrationUsesPgSearchOrBm25 } from './bm25Compatibility';
import {
  AICO_EQUIVALENCES,
  createPgExecutor,
  formatReport,
  readTracks,
  runDualJournal,
} from './dualJournal/runner';
// @ts-ignore tsgo handle esm import cjs and compatibility issues
import { DUPLICATE_EMAIL_HINT, PGVECTOR_HINT } from './errorHint';

// Load environment variables in priority order:
// 1. .env (lowest priority)
// 2. .env.[env] (medium priority, overrides .env)
// 3. .env.[env].local (highest priority, overrides previous)
// Use dotenv-expand to support ${var} variable expansion
const env = process.env.NODE_ENV || 'development';
dotenvExpand.expand(dotenv.config()); // Load .env
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}` })); // Load .env.[env] and override
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}.local` })); // Load .env.[env].local and override

/** Directory holding both journals: `migrations/` (upstream-shaped) and `migrations-aico/`. */
const migrationsRoot = join(__dirname, '../../packages/database');

/**
 * Both journals through the dual-journal runner (docs/aico/MIGRATION_LEDGER_SPIKE.md), with
 * any `DATABASE_DRIVER`: migrations go over a plain `pg` connection. Use a direct (session)
 * URL, not a transaction-pooling one, so the advisory lock holds for the whole run.
 *
 * When pg_search is unavailable (common on Neon) it re-runs while recording BM25 migrations
 * as skipped: safe, because the runner identifies applied entries by `when`, keeps every
 * migration that already committed, and never re-executes one.
 */
const runDualJournalMigrations = async () => {
  if (process.env.AICO_MIGRATION_RUNNER === 'stock') {
    throw new Error(
      "AICO_MIGRATION_RUNNER=stock is no longer supported: Drizzle's migrator runs one journal " +
        'and would skip migrations-aico.',
    );
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const connection = await pool.connect();
  const executor = createPgExecutor(connection);
  const tracks = readTracks(migrationsRoot);

  try {
    const report = await runDualJournal({
      equivalences: AICO_EQUIVALENCES,
      executor,
      tracks,
    }).catch(async (error) => {
      if (!isPgSearchUnavailableError(error?.cause ?? error)) throw error;
      console.warn(
        '⚠️ pg_search is not available; recording BM25/pg_search migrations as skipped…',
      );
      return runDualJournal({
        equivalences: AICO_EQUIVALENCES,
        executor,
        skip: (entry) => migrationUsesPgSearchOrBm25(entry.statements),
        tracks,
      });
    });
    console.log('[Database] dual-journal runner: %s', formatReport(report));
    if (report.skipped.length > 0) {
      console.warn(
        `⚠️ Skipped ${report.skipped.length} ParadeDB BM25 migration(s). Full-text BM25 search will be unavailable until pg_search is supported.`,
      );
    }
  } finally {
    connection.release();
    await pool.end();
  }
};

const runMigrations = async () => {
  const time = Date.now();

  await runDualJournalMigrations();

  console.log('✅ database migration pass. use: %s ms', Date.now() - time);

  process.exit(0);
};

const connectionString = process.env.DATABASE_URL;

// only migrate database if the connection string is available
if (connectionString) {
  runMigrations().catch((err) => {
    console.error('❌ Database migrate failed:', err);

    // The dual-journal runner wraps the database error as `cause`.
    const errMsg = `${err.message} ${err.cause?.message ?? ''}`;

    const constraint =
      (err as { constraint?: string })?.constraint ??
      (err.cause as { constraint?: string } | undefined)?.constraint;

    if (errMsg.includes('extension "vector" is not available')) {
      console.info(PGVECTOR_HINT);
    } else if (constraint === 'users_email_unique' || errMsg.includes('users_email_unique')) {
      console.info(DUPLICATE_EMAIL_HINT);
    }

    process.exit(1);
  });
} else {
  console.log('🟢 not find database env or in desktop mode, migration skipped');
}
