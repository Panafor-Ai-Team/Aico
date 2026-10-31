import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * SPIKE — builds the two migration folders design D2 would ship, in a temp directory:
 * upstream's migrations verbatim from a git ref, and Aico's own migrations as a second
 * journal that keeps their original `when` values (the ledger identity).
 */

interface JournalFile {
  dialect: string;
  entries: Array<{ breakpoints: boolean; idx: number; tag: string; version: string; when: number }>;
  version: string;
}

const MIGRATIONS_PATH = 'packages/database/migrations';

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

/**
 * Writes the Aico-only track: entries of the Aico journal that upstream does not have,
 * minus Aico's renumbered copy of upstream 0131, with their original `when` values.
 */
export const buildAicoTrack = (aicoFolder: string, upstreamFolder: string): string => {
  const aico = readJournalFile(aicoFolder);
  const upstreamTags = new Set(readJournalFile(upstreamFolder).entries.map((entry) => entry.tag));

  const own = aico.entries.filter(
    (entry) => !upstreamTags.has(entry.tag) && entry.tag !== AICO_EQUIVALENT_OF_UPSTREAM_0131,
  );

  const target = path.join(mkdtempSync(path.join(tmpdir(), 'aico-track-')), 'migrations-aico');
  mkdirSync(path.join(target, 'meta'), { recursive: true });
  for (const entry of own) {
    copyFileSync(path.join(aicoFolder, `${entry.tag}.sql`), path.join(target, `${entry.tag}.sql`));
  }
  writeFileSync(
    path.join(target, 'meta/_journal.json'),
    JSON.stringify({ ...aico, entries: own.map((entry, idx) => ({ ...entry, idx })) }, null, 2),
  );
  return target;
};

/** `when` of an entry in a migrations folder's journal. */
export const whenOf = (folder: string, tag: string): number => {
  const entry = readJournalFile(folder).entries.find((candidate) => candidate.tag === tag);
  if (!entry) throw new Error(`${tag} not in ${folder}`);
  return entry.when;
};
