const { Pool } = require('pg');
const {
  AICO_EQUIVALENCES,
  createPgExecutor,
  formatReport,
  readTracks,
  runDualJournal,
} = require('./dualJournalRunner.cjs');
const { PGVECTOR_HINT } = require('./errorHint');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set, please set it in your environment variables.');
}

/**
 * Migrations ship as two journals beside this file: `migrations/` (upstream-shaped) and
 * `migrations-aico/` (Aico's own). The dual-journal runner (docs/aico/MIGRATION_LEDGER_SPIKE.md)
 * applies them in that order: an entry runs once, identified by its `when`, each migration
 * commits on its own, concurrent runners serialize on an advisory lock, and a file changed
 * after it was applied is reported, never re-run.
 */
const runMigrations = async () => {
  console.log('[Database] Start to migration...');

  if (process.env.AICO_MIGRATION_RUNNER === 'stock') {
    throw new Error(
      "AICO_MIGRATION_RUNNER=stock is no longer supported: Drizzle's migrator runs one journal " +
        'and would skip migrations-aico. Unset it; to go back, deploy the previous image instead.',
    );
  }

  const client = new Pool({ connectionString: process.env.DATABASE_URL });
  const connection = await client.connect();
  try {
    const report = await runDualJournal({
      equivalences: AICO_EQUIVALENCES,
      executor: createPgExecutor(connection),
      tracks: readTracks(__dirname),
    });
    console.log(`[Database] dual-journal runner: ${formatReport(report)}`);
    if (report.unknownRows.length > 0) {
      console.warn(
        '[Database] ledger rows matching no journal entry (created_at):',
        report.unknownRows.map((row) => row.createdAt).join(', '),
      );
    }
  } finally {
    connection.release();
  }

  console.log('✅ database migration pass.');
  console.log('-------------------------------------');
  process.exit(0);
};

runMigrations().catch((err) => {
  console.error(
    '❌ Database migrate failed. Please check your database is valid and DATABASE_URL is set correctly. The error detail is below:',
  );
  console.error(err);

  // The dual-journal runner wraps the database error as `cause`.
  const message = `${err.message} ${err.cause?.message ?? ''}`;
  if (message.includes('extension "vector" is not available')) {
    console.info(PGVECTOR_HINT);
  }

  process.exit(1);
});
