import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { migrationUsesPgSearchOrBm25 } from '../bm25Compatibility';
import { diffSnapshots, schemaSnapshot } from './catalog';
import { type MigrationExecutor, type MigrationTrack, readTrack, runDualJournal } from './runner';
import { AICO_EQUIVALENT_OF_UPSTREAM_0131 } from './tracks';

/**
 * Fails when Aico's migrations and `aicoOrganization.ts` describe different schemas.
 *
 * Builds two in-memory PGlite databases and compares their full catalogs:
 *   - from migrations: every entry of `packages/database/migrations`;
 *   - from the schema: the upstream entries only (0000–0130, plus 0134, Aico's copy of
 *     upstream 0131), then the DDL `drizzle-kit generate` emits for `aicoOrganization.ts`.
 *
 *   bunx tsx scripts/migrateServerDB/dualJournal/schemaDrift.ts
 *
 * Objects drizzle cannot declare (triggers, functions) are ignored; any other difference
 * exits 1.
 */

const repoRoot = path.join(__dirname, '../../..');
const migrationsFolder = path.join(repoRoot, 'packages/database/migrations');
const aicoSchemaFile = path.join(repoRoot, 'packages/database/src/schemas/aicoOrganization.ts');
const dbRequire = createRequire(path.join(repoRoot, 'packages/database/package.json'));

/** Last upstream migration Aico shares with LobeHub before the journals diverge. */
const LAST_SHARED_UPSTREAM_IDX = 130;

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

const migrate = (executor: MigrationExecutor, track: MigrationTrack) =>
  runDualJournal({
    executor,
    skip: (entry) => migrationUsesPgSearchOrBm25(entry.statements),
    tracks: [track],
  });

/** Runs drizzle-kit on the Aico schema file alone and returns its DDL statements. */
const generateAicoDdl = (): string[] => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'aico-schema-drift-'));
  try {
    const configFile = path.join(workDir, 'drizzle.config.ts');
    writeFileSync(
      configFile,
      `export default ${JSON.stringify({ dialect: 'postgresql', out: path.join(workDir, 'out'), schema: aicoSchemaFile })};\n`,
    );
    execFileSync('bunx', ['drizzle-kit', 'generate', `--config=${configFile}`], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const outDir = path.join(workDir, 'out');
    const sqlFile = readdirSync(outDir).find((file) => file.endsWith('.sql'));
    if (!sqlFile) throw new Error('drizzle-kit generated no SQL for aicoOrganization.ts');
    return readFileSync(path.join(outDir, sqlFile), 'utf8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
};

/** Triggers and functions live only in migrations: drizzle has no way to declare them. */
const isUndeclarable = (line: string) => line.startsWith('trg ') || line.startsWith('fn ');

const main = async () => {
  const full = readTrack('aico', migrationsFolder);
  const upstreamOnly: MigrationTrack = {
    ...full,
    entries: full.entries.filter(
      (entry) =>
        Number.parseInt(entry.tag, 10) <= LAST_SHARED_UPSTREAM_IDX ||
        entry.tag === AICO_EQUIVALENT_OF_UPSTREAM_0131,
    ),
  };

  const fromMigrations = await createDb();
  await migrate(fromMigrations.executor, full);

  const fromSchema = await createDb();
  await migrate(fromSchema.executor, upstreamOnly);
  for (const statement of generateAicoDdl()) await fromSchema.executor.exec(statement);

  const { onlyInFresh, onlyInUpgraded } = diffSnapshots(
    await schemaSnapshot(fromMigrations.executor),
    await schemaSnapshot(fromSchema.executor),
  );
  await fromMigrations.close();
  await fromSchema.close();

  const drift = [
    ...onlyInFresh.filter((line) => !isUndeclarable(line)).map((line) => `- ${line}`),
    ...onlyInUpgraded.filter((line) => !isUndeclarable(line)).map((line) => `+ ${line}`),
  ];

  if (drift.length === 0) {
    console.log(
      `✅ Aico migrations match aicoOrganization.ts (${full.entries.length - upstreamOnly.entries.length} Aico migrations compared).`,
    );
    return;
  }

  console.error(
    '❌ Schema drift between Aico migrations (-) and aicoOrganization.ts (+).\n' +
      'Add a migration, or fix the schema, so both describe the same database:\n',
  );
  for (const line of drift) console.error(`  ${line}`);
  process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
