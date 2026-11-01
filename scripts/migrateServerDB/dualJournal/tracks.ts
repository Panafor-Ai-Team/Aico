import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Track helpers for the dual-journal scenarios: upstream's migrations verbatim from a git
 * ref, and the pre-split single journal rebuilt from `migrations/` + `migrations-aico/`.
 */

interface JournalFile {
  dialect: string;
  entries: Array<{ breakpoints: boolean; idx: number; tag: string; version: string; when: number }>;
  version: string;
}

const MIGRATIONS_PATH = 'packages/database/migrations';

export const MAIN_MIGRATIONS_FOLDER = 'packages/database/migrations';
export const AICO_MIGRATIONS_FOLDER = 'packages/database/migrations-aico';

/** Aico's renumbered copy of upstream `0131_agents_add_name_column` (same SQL). */
export const AICO_EQUIVALENT_OF_UPSTREAM_0131 = '0134_agents_add_name_column';
export const UPSTREAM_0131 = '0131_agents_add_name_column';

const readJournalFile = (folder: string): JournalFile =>
  JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as JournalFile;

/** Extracts `packages/database/migrations` at `ref` into a temp dir and returns its path. */
export const extractMigrationsAtRef = (repoRoot: string, ref: string): string => {
  const target = mkdtempSync(path.join(tmpdir(), 'aico-migrations-'));
  const archive = execFileSync('git', ['archive', ref, MIGRATIONS_PATH], {
    cwd: repoRoot,
    maxBuffer: 512 * 1024 * 1024,
  });
  execFileSync('tar', ['-x', '-C', target], { input: archive });
  return path.join(target, MIGRATIONS_PATH);
};

/** Numeric prefix of a migration tag (`0131_x` → 131, `20261101094543_x` → 20261101094543). */
const tagNumber = (tag: string) => Number.parseInt(tag, 10);

/**
 * Rebuilds the single journal Aico shipped before the split (0000–0160 in one folder) from
 * the two journals, ordered by tag number: what a database migrated before the split, or an
 * image built before it, saw. `legacyJournal.test.ts` pins it to the pre-split journal.
 */
export const buildLegacyJournal = (mainFolder: string, aicoFolder: string): string => {
  const main = readJournalFile(mainFolder);
  const aico = readJournalFile(aicoFolder);
  const entries = [
    ...main.entries.map((entry) => ({ entry, folder: mainFolder })),
    ...aico.entries.map((entry) => ({ entry, folder: aicoFolder })),
  ].sort((a, b) => tagNumber(a.entry.tag) - tagNumber(b.entry.tag));

  const target = path.join(mkdtempSync(path.join(tmpdir(), 'aico-legacy-')), 'migrations');
  mkdirSync(path.join(target, 'meta'), { recursive: true });
  for (const { entry, folder } of entries) {
    copyFileSync(path.join(folder, `${entry.tag}.sql`), path.join(target, `${entry.tag}.sql`));
  }
  writeFileSync(
    path.join(target, 'meta/_journal.json'),
    JSON.stringify(
      { ...main, entries: entries.map(({ entry }, idx) => ({ ...entry, idx })) },
      null,
      2,
    ),
  );
  return target;
};

/** `when` of an entry in a migrations folder's journal. */
export const whenOf = (folder: string, tag: string): number => {
  const entry = readJournalFile(folder).entries.find((candidate) => candidate.tag === tag);
  if (!entry) throw new Error(`${tag} not in ${folder}`);
  return entry.when;
};
