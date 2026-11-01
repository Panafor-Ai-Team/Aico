import path from 'node:path';

import { describe, expect, it } from 'vitest';

import legacy from './__fixtures__/legacyJournal.json';
import { AICO_EQUIVALENCES, readTrack, readTracks } from './runner';
import { AICO_MIGRATIONS_FOLDER, buildLegacyJournal, MAIN_MIGRATIONS_FOLDER } from './tracks';

/**
 * Production ledgers are keyed by the `when` of every migration shipped before the journal
 * split (the fixture, taken from canary at the split). Moving files between journals must
 * keep each one byte-identical, with its tag and `when`: a changed hash is reported as
 * drift, a changed `when` would run a historical (financial) migration again.
 */
const repoRoot = path.join(__dirname, '../../..');
const mainFolder = path.join(repoRoot, MAIN_MIGRATIONS_FOLDER);
const aicoFolder = path.join(repoRoot, AICO_MIGRATIONS_FOLDER);

const shape = ({ hash, tag, when }: { hash: string; tag: string; when: number }) => ({
  hash,
  tag,
  when,
});

describe('journal split', () => {
  it('rebuilds the pre-split single journal exactly: same tags, hashes and `when`, same order', () => {
    const rebuilt = readTrack('legacy', buildLegacyJournal(mainFolder, aicoFolder)).entries;

    expect(rebuilt.slice(0, legacy.entries.length).map(shape)).toEqual(legacy.entries);
  });

  it('keeps every shipped migration in one of the two journals, unchanged', () => {
    const current = readTracks(path.join(repoRoot, 'packages/database')).flatMap(
      (track) => track.entries,
    );
    const byWhen = new Map(current.map((entry) => [entry.when, entry]));
    const coveredByEquivalence = new Set(
      Object.entries(AICO_EQUIVALENCES)
        .filter(([tag]) => current.some((entry) => entry.tag === tag))
        .map(([, when]) => when),
    );

    const missingOrChanged = legacy.entries.filter((shipped) => {
      const entry = byWhen.get(shipped.when);
      if (!entry) return !coveredByEquivalence.has(shipped.when);
      return entry.tag !== shipped.tag || entry.hash !== shipped.hash;
    });

    expect(missingOrChanged).toEqual([]);
  });

  it('applies the main journal before the Aico journal', () => {
    expect(readTracks(path.join(repoRoot, 'packages/database')).map((track) => track.name)).toEqual(
      ['main', 'aico'],
    );
  });
});
