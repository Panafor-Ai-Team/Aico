import path from 'node:path';

import { describe, expect, it } from 'vitest';

import legacy from './__fixtures__/legacyJournal.json';
import { AICO_EQUIVALENCES, readTrack, readTracks } from './runner';
import { AICO_MIGRATIONS_FOLDER } from './tracks';

/**
 * Production ledgers are keyed by the `when` of every migration shipped before the journal
 * split (the fixture, taken from canary at the split). Each of them must stay reachable
 * from today's two journals — by `when`, or through `AICO_EQUIVALENCES` once upstream's
 * own copy replaced Aico's — and keep its content: a changed `when` would run a historical
 * (financial) migration again, a changed hash is reported as drift on every deploy.
 */
const repoRoot = path.join(__dirname, '../../..');
const aicoFolder = path.join(repoRoot, AICO_MIGRATIONS_FOLDER);

/**
 * Upstream-owned migrations upstream edited after Aico applied them. The runner never
 * re-executes them (identity is `when`); it reports them as drift. Each entry pins the new
 * hash, so any further edit has to be reviewed here again. Aico migrations never belong
 * here: they are immutable once shipped.
 */
const UPSTREAM_EDITS_OF_SHIPPED: Record<string, { hash: string; reason: string }> = {
  '0111_workspace_device_and_ai_infra_surrogate_pk': {
    hash: '911345132c80541af0c97406f06cb6d336f75d2a267121c81cef1a8dfa1d51b6',
    reason: 'comments only: internal issue ids removed (lobehub/lobehub#18327)',
  },
};

const current = readTracks(path.join(repoRoot, 'packages/database'));
const entries = current.flatMap((track) =>
  track.entries.map((entry) => ({ ...entry, track: track.name })),
);
const byWhen = new Map(entries.map((entry) => [entry.when, entry]));
const byTag = new Map(entries.map((entry) => [entry.tag, entry]));
/** Shipped `when` → the upstream entry that now stands for it. */
const equivalentOf = new Map(
  Object.entries(AICO_EQUIVALENCES).flatMap(([tag, when]) =>
    byTag.has(tag) ? [[when, byTag.get(tag)!] as const] : [],
  ),
);

describe('journal split', () => {
  it('reaches every shipped migration exactly once, by `when` or by equivalence', () => {
    const unreachable = legacy.entries.filter(
      (shipped) => byWhen.has(shipped.when) === equivalentOf.has(shipped.when),
    );

    expect(unreachable).toEqual([]);
  });

  it('keeps every shipped migration unchanged, apart from the reviewed upstream edits', () => {
    const changed = legacy.entries.flatMap((shipped) => {
      const entry = byWhen.get(shipped.when);
      if (!entry) return [];
      if (entry.tag !== shipped.tag) return [{ ...shipped, now: entry.tag }];
      if (entry.hash === shipped.hash) return [];
      const edit = UPSTREAM_EDITS_OF_SHIPPED[shipped.tag];
      return edit && entry.track === 'main' && edit.hash === entry.hash
        ? []
        : [{ ...shipped, now: entry.hash }];
    });

    expect(changed).toEqual([]);
  });

  it('never lists an Aico migration as editable', () => {
    const aicoTags = new Set(readTrack('aico', aicoFolder).entries.map((entry) => entry.tag));

    expect(Object.keys(UPSTREAM_EDITS_OF_SHIPPED).filter((tag) => aicoTags.has(tag))).toEqual([]);
  });

  it('replaces an equivalent Aico migration only with the same SQL', () => {
    const sameSql = [...equivalentOf].map(([when, entry]) => {
      const shipped = legacy.entries.find((candidate) => candidate.when === when)!;
      return { shipped: shipped.tag, statements: entry.statements.map((sql) => sql.trim()) };
    });

    // Aico 0134 was a renumbered copy of upstream 0131; upstream's file differs only in
    // its trailing newline.
    expect(sameSql).toEqual(
      equivalentOf.size === 0
        ? []
        : [
            {
              shipped: '0134_agents_add_name_column',
              statements: ['ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "name" varchar(255);'],
            },
          ],
    );
  });

  it('applies the main journal before the Aico journal', () => {
    expect(current.map((track) => track.name)).toEqual(['main', 'aico']);
  });
});
