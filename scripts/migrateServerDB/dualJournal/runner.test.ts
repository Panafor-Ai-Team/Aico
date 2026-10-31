import { describe, expect, it } from 'vitest';

import {
  DualJournalMigrationError,
  type MigrationEntry,
  type MigrationExecutor,
  type MigrationTrack,
  runDualJournal,
  stockDrizzlePending,
} from './runner';

/** In-memory ledger with real transaction semantics for the statements the runner issues. */
const createFakeDb = (rows: Array<{ created_at: number; hash: string }> = []) => {
  const ledger = rows.map((row, index) => ({ ...row, id: index + 1 }));
  const executed: string[] = [];
  let pendingInserts: Array<{ created_at: number; hash: string }> = [];
  let pendingStatements: string[] = [];

  const executor: MigrationExecutor = {
    exec: async (sql) => {
      if (sql === 'BEGIN') {
        pendingInserts = [];
        pendingStatements = [];
      } else if (sql === 'COMMIT') {
        for (const insert of pendingInserts) ledger.push({ ...insert, id: ledger.length + 1 });
        executed.push(...pendingStatements);
      } else if (sql === 'ROLLBACK') {
        pendingInserts = [];
        pendingStatements = [];
      } else if (
        sql.startsWith('CREATE SCHEMA') ||
        sql.startsWith('CREATE TABLE IF NOT EXISTS "drizzle"')
      ) {
        // ledger bootstrap
      } else {
        if (sql.includes('FAIL')) throw new Error(`statement failed: ${sql}`);
        pendingStatements.push(sql);
      }
    },
    query: async (sql, params = []) => {
      if (sql.startsWith('SELECT id, hash, created_at')) return ledger as any[];
      if (sql.startsWith('INSERT INTO')) {
        pendingInserts.push({ created_at: params[1] as number, hash: params[0] as string });
      }
      return [];
    },
  };

  return { executed, executor, ledger };
};

const entry = (tag: string, when: number, statements = [`-- ${tag}`]): MigrationEntry => ({
  hash: `hash-${tag}`,
  statements,
  tag,
  when,
});

const track = (name: string, entries: MigrationEntry[]): MigrationTrack => ({ entries, name });

describe('runDualJournal', () => {
  it('applies entries the ledger lacks even when they are older than the newest row', async () => {
    // Upstream 0132 is stamped before Aico's newest migration — drizzle would skip it.
    const db = createFakeDb([
      { created_at: 100, hash: 'hash-u0131' },
      { created_at: 900, hash: 'hash-a0159' },
    ]);
    const upstream = track('upstream', [entry('u0131', 100), entry('u0132', 200)]);
    const aico = track('aico', [entry('a0159', 900)]);

    const report = await runDualJournal({ executor: db.executor, tracks: [upstream, aico] });

    expect(report.applied).toEqual(['u0132']);
    expect(db.executed).toEqual(['-- u0132']);
    expect(stockDrizzlePending(upstream, [{ createdAt: 900, hash: 'x', id: 1 }])).toEqual([]);
  });

  it('treats an entry as satisfied by an equivalent row from the other track', async () => {
    const db = createFakeDb([{ created_at: 555, hash: 'hash-a0134' }]);

    const report = await runDualJournal({
      equivalences: { u0131: 555 },
      executor: db.executor,
      tracks: [track('upstream', [entry('u0131', 100)])],
    });

    expect(report.equivalent).toEqual(['u0131']);
    expect(report.applied).toEqual([]);
    expect(report.unknownRows).toEqual([]);
  });

  it('reports hash drift without re-running the changed migration', async () => {
    const db = createFakeDb([{ created_at: 100, hash: 'old-hash' }]);

    const report = await runDualJournal({
      executor: db.executor,
      tracks: [track('aico', [entry('a0132', 100)])],
    });

    expect(report.drift).toEqual([
      { appliedHash: 'old-hash', currentHash: 'hash-a0132', tag: 'a0132' },
    ]);
    expect(db.executed).toEqual([]);
  });

  it('commits each migration separately and resumes after a failure', async () => {
    const db = createFakeDb();
    const broken = track('upstream', [
      entry('u1', 1),
      entry('u2', 2, ['-- u2 part 1', 'FAIL']),
      entry('u3', 3),
    ]);

    const failure = await runDualJournal({ executor: db.executor, tracks: [broken] }).catch(
      (error) => error,
    );

    expect(failure).toBeInstanceOf(DualJournalMigrationError);
    expect(failure.tag).toBe('u2');
    expect(db.ledger.map((row) => row.created_at)).toEqual([1]);
    expect(db.executed).toEqual(['-- u1']);

    const fixed = track('upstream', [entry('u1', 1), entry('u2', 2), entry('u3', 3)]);
    const resumed = await runDualJournal({ executor: db.executor, tracks: [fixed] });

    expect(resumed.applied).toEqual(['u2', 'u3']);
    expect(db.ledger.map((row) => row.created_at)).toEqual([1, 2, 3]);
  });

  it('records skipped entries without executing them', async () => {
    const db = createFakeDb();

    const report = await runDualJournal({
      executor: db.executor,
      skip: (candidate) => candidate.tag === 'u-bm25',
      tracks: [track('upstream', [entry('u-bm25', 1, ['CREATE EXTENSION pg_search'])])],
    });

    expect(report.skipped).toEqual(['u-bm25']);
    expect(db.executed).toEqual([]);
    expect(db.ledger).toHaveLength(1);
  });

  it('reports ledger rows that match no entry', async () => {
    const db = createFakeDb([{ created_at: 42, hash: 'stray' }]);

    const report = await runDualJournal({
      executor: db.executor,
      tracks: [track('upstream', [entry('u1', 1)])],
    });

    expect(report.unknownRows).toEqual([{ createdAt: 42, hash: 'stray', id: 1 }]);
  });
});
