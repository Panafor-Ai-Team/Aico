const path = require('node:path');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const migrator = require('drizzle-orm/node-postgres/migrator');
const { PGVECTOR_HINT } = require('./errorHint');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set, please set it in your environment variables.');
}

const client = new Pool({ connectionString: process.env.DATABASE_URL });

const db = drizzle(client);

const migrationsFolder = path.join(__dirname, './migrations');

/**
 * Opt-in D2 runner (docs/aico/MIGRATION_LEDGER_SPIKE.md): same journal, but entries missing
 * from the ledger are applied even when older than the newest row, each migration commits
 * on its own, concurrent runners serialize on an advisory lock, and drift is never re-run.
 */
const runDualJournalMigrations = async () => {
  const {
    createPgExecutor,
    formatReport,
    readTrack,
    runDualJournal,
  } = require('./dualJournalRunner.cjs');
  const connection = await client.connect();
  try {
    const report = await runDualJournal({
      executor: createPgExecutor(connection),
      tracks: [readTrack('aico', migrationsFolder)],
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
};

const runMigrations = async () => {
  console.log('[Database] Start to migration...');
  if (process.env.AICO_MIGRATION_RUNNER === 'dual') {
    await runDualJournalMigrations();
  } else {
    await migrator.migrate(db, { migrationsFolder });
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
