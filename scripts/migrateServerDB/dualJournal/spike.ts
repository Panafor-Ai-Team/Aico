import { createRequire } from 'node:module';
import path from 'node:path';

import { migrationUsesPgSearchOrBm25 } from '../bm25Compatibility';
import {
  DualJournalMigrationError,
  type MigrationExecutor,
  type MigrationTrack,
  readLedger,
  readTrack,
  runDualJournal,
  stockDrizzlePending,
} from './runner';
import {
  AICO_EQUIVALENT_OF_UPSTREAM_0131,
  buildAicoTrack,
  extractMigrationsAtRef,
  UPSTREAM_0131,
  whenOf,
} from './tracks';

/**
 * SPIKE harness for design D2 (see docs/aico/MIGRATION_LEDGER_SPIKE.md). Runs every
 * scenario on a fresh in-memory PGlite (with pgvector, like getTestDB) and prints a JSON
 * report. Needs the `upstream/canary` ref locally:
 *
 *   bunx tsx scripts/migrateServerDB/dualJournal/spike.ts [--upstream-ref=upstream/canary]
 */

const repoRoot = path.join(__dirname, '../../..');
const upstreamRef =
  process.argv.find((arg) => arg.startsWith('--upstream-ref='))?.split('=')[1] ?? 'upstream/canary';

const dbRequire = createRequire(path.join(repoRoot, 'packages/database/package.json'));

const createDb = async () => {
  const { PGlite } = await import(dbRequire.resolve('@electric-sql/pglite'));
  const { vector } = await import(dbRequire.resolve('@electric-sql/pglite/vector'));
  const pg = new PGlite({ extensions: { vector } });
  const executor: MigrationExecutor = {
    exec: async (sql) => {
      await pg.exec(sql);
    },
    query: async (sql, params) => (await pg.query(sql, params)).rows as any[],
  };
  return { close: () => pg.close(), executor };
};

const skip = (entry: { statements: string[] }) => migrationUsesPgSearchOrBm25(entry.statements);

/** Normalized catalog of the public schema, for fresh-vs-upgraded comparison. */
const schemaSnapshot = async (executor: MigrationExecutor): Promise<Set<string>> => {
  const lines = new Set<string>();
  const columns = await executor.query<Record<string, string>>(`
    SELECT table_name, column_name, udt_name, is_nullable, coalesce(column_default, '') AS d
    FROM information_schema.columns WHERE table_schema = 'public'`);
  for (const c of columns) {
    lines.add(
      `col ${c.table_name}.${c.column_name} ${c.udt_name} null=${c.is_nullable} default=${c.d}`,
    );
  }
  const indexes = await executor.query<Record<string, string>>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
  );
  for (const i of indexes) lines.add(`idx ${i.indexname} ${i.indexdef}`);
  const constraints = await executor.query<Record<string, string>>(`
    SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace`);
  for (const c of constraints) lines.add(`con ${c.rel}.${c.conname} ${c.def}`);
  const triggers = await executor.query<Record<string, string>>(`
    SELECT event_object_table, trigger_name, event_manipulation, action_timing, action_statement
    FROM information_schema.triggers WHERE trigger_schema = 'public'`);
  for (const t of triggers) {
    lines.add(
      `trg ${t.event_object_table}.${t.trigger_name} ${t.action_timing} ${t.event_manipulation} ${t.action_statement}`,
    );
  }
  const functions = await executor.query<Record<string, string>>(`
    SELECT p.proname, md5(p.prosrc) AS src FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace`);
  for (const f of functions) lines.add(`fn ${f.proname} ${f.src}`);
  const enums = await executor.query<Record<string, string>>(`
    SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typnamespace = 'public'::regnamespace GROUP BY t.typname`);
  for (const e of enums) lines.add(`enum ${e.typname} ${e.labels}`);
  return lines;
};

const diffSnapshots = (a: Set<string>, b: Set<string>) => ({
  onlyInFresh: [...a].filter((line) => !b.has(line)).sort(),
  onlyInUpgraded: [...b].filter((line) => !a.has(line)).sort(),
});

/** Row checksums of every table, so an upgrade provably leaves existing rows untouched. */
const dataChecksums = async (executor: MigrationExecutor) => {
  const tables = await executor.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const sums: Record<string, string> = {};
  for (const { table_name } of tables) {
    const [row] = await executor.query<{ sum: string | null }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS sum FROM "${table_name}" t`,
    );
    sums[table_name] = row.sum ?? '';
  }
  return sums;
};

/** Minimal financial fixtures: a user, an org, a wallet and a ledger row. */
const seedBilling = async (executor: MigrationExecutor) => {
  const statements = [
    `INSERT INTO users (id, email) VALUES ('spike-user', 'spike@example.com')`,
    `INSERT INTO organizations (id, name, slug, public_code, owner_user_id) VALUES ('spike-org', 'Spike Org', 'spike-org', 'SPIKE1', 'spike-user')`,
    `INSERT INTO user_wallets (id, user_id, balance_micro_usd) VALUES ('spike-wallet', 'spike-user', 12345678)`,
    `INSERT INTO wallet_transactions (id, user_id, type, amount_micro_usd, amount_toman) VALUES ('spike-tx', 'spike-user', 'manual_credit', 12345678, 617283)`,
  ];
  const failures: string[] = [];
  for (const statement of statements) {
    try {
      await executor.exec(statement);
    } catch (error) {
      failures.push(`${statement.slice(0, 40)}…: ${(error as Error).message}`);
    }
  }
  return failures;
};

const main = async () => {
  const aicoFolder = path.join(repoRoot, 'packages/database/migrations');
  const upstreamFolder = extractMigrationsAtRef(repoRoot, upstreamRef);
  const aicoTrackFolder = buildAicoTrack(aicoFolder, upstreamFolder);

  const aicoToday = readTrack('aico-today', aicoFolder);
  const upstream = readTrack('upstream', upstreamFolder);
  const aicoOwn = readTrack('aico', aicoTrackFolder);
  const tracks: MigrationTrack[] = [upstream, aicoOwn];
  const equivalences = { [UPSTREAM_0131]: whenOf(aicoFolder, AICO_EQUIVALENT_OF_UPSTREAM_0131) };

  const results: Record<string, unknown> = {
    tracks: {
      aico: aicoOwn.entries.length,
      aicoToday: aicoToday.entries.length,
      upstream: upstream.entries.length,
    },
    upstreamRef,
  };

  /** A database migrated the way Aico production is today. */
  const buildToday = async () => {
    const db = await createDb();
    await runDualJournal({ executor: db.executor, skip, tracks: [aicoToday] });
    return db;
  };

  // S1 — fresh install with D2
  const fresh = await createDb();
  const s1 = await runDualJournal({ equivalences, executor: fresh.executor, skip, tracks });
  const freshSchema = await schemaSnapshot(fresh.executor);
  results.S1_fresh = { applied: s1.applied.length, skipped: s1.skipped, equivalent: s1.equivalent };
  await fresh.close();

  // S2 — upgrade a today-shaped database; schema must equal S1, data untouched
  {
    const db = await buildToday();
    const seedFailures = await seedBilling(db.executor);
    const before = await dataChecksums(db.executor);
    const report = await runDualJournal({ equivalences, executor: db.executor, skip, tracks });
    const after = await dataChecksums(db.executor);
    const changedTables = Object.keys(before).filter((table) => before[table] !== after[table]);
    const diff = diffSnapshots(freshSchema, await schemaSnapshot(db.executor));
    // S4 — the old single-journal migrator must have nothing left to do
    const oldImagePending = stockDrizzlePending(aicoToday, await readLedger(db.executor));
    results.S2_upgrade = {
      applied: report.applied.length,
      changedTables,
      drift: report.drift.map((d) => d.tag),
      equivalent: report.equivalent,
      schemaDiff: diff,
      seedFailures,
      unknownRows: report.unknownRows.length,
    };
    results.S4_oldImageAfterFullRun = { pending: oldImagePending };
    await db.close();
  }

  // S3 — 0142 never recorded: (b) tables present (manual repair), (a') tables and 0146 gone
  for (const variant of ['tablesPresent', 'tablesAndDependentsMissing'] as const) {
    const db = await buildToday();
    const tag0142 = '0142_aico_security_audit_and_alerts';
    await db.executor.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1', [
      whenOf(aicoFolder, tag0142),
    ]);
    if (variant === 'tablesAndDependentsMissing') {
      await db.executor.exec(
        'DROP TABLE IF EXISTS aico_security_audit_logs, aico_security_alert_state CASCADE',
      );
      await db.executor.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1', [
        whenOf(aicoFolder, '0146_aico_platform_admin_identity'),
      ]);
    }
    let error: string | undefined;
    let applied: string[] = [];
    try {
      applied = (await runDualJournal({ equivalences, executor: db.executor, skip, tracks }))
        .applied;
    } catch (cause) {
      error = (cause as Error).message + ' / ' + String((cause as any).cause?.message ?? '');
    }
    const diff = diffSnapshots(freshSchema, await schemaSnapshot(db.executor));
    results[`S3_${variant}`] = {
      aicoApplied: applied.filter((tag) => aicoOwn.entries.some((e) => e.tag === tag)),
      error,
      schemaDiff: diff,
    };
    await db.close();
  }

  // S5 — failure mid-batch, then resume
  {
    const db = await buildToday();
    const failAt = '0150_agent_interventions_and_live_activity';
    const broken: MigrationTrack = {
      ...upstream,
      entries: upstream.entries.map((entry) =>
        entry.tag === failAt
          ? { ...entry, statements: [...entry.statements, 'SELECT spike_injected_failure()'] }
          : entry,
      ),
    };
    let failedTag: string | undefined;
    try {
      await runDualJournal({
        equivalences,
        executor: db.executor,
        skip,
        tracks: [broken, aicoOwn],
      });
    } catch (error) {
      if (error instanceof DualJournalMigrationError) failedTag = error.tag;
      else throw error;
    }
    const partialLedger = await readLedger(db.executor);
    const committedUpstream = upstream.entries.filter((entry) =>
      partialLedger.some((row) => row.createdAt === entry.when),
    ).length;
    const oldImagePendingPartial = stockDrizzlePending(aicoToday, partialLedger);
    const resumed = await runDualJournal({ equivalences, executor: db.executor, skip, tracks });
    const diff = diffSnapshots(freshSchema, await schemaSnapshot(db.executor));
    results.S5_failureResume = {
      committedUpstreamBeforeResume: committedUpstream,
      failedTag,
      oldImagePendingAtPartialState: oldImagePendingPartial,
      resumedApplied: resumed.applied.length,
      schemaDiff: diff,
    };
    await db.close();
  }

  // S6 — 0132 applied under an older file version
  {
    const db = await buildToday();
    await db.executor.query(
      `UPDATE drizzle.__drizzle_migrations SET hash = 'e90b647b-old-version' WHERE created_at = $1`,
      [whenOf(aicoFolder, '0132_shocking_blizzard')],
    );
    const report = await runDualJournal({ equivalences, executor: db.executor, skip, tracks });
    results.S6_hashDrift = {
      drift: report.drift.map((d) => d.tag),
      reExecuted: report.applied.includes('0132_shocking_blizzard'),
    };
    await db.close();
  }

  console.log(JSON.stringify(results, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
