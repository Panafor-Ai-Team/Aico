import { describe, expect, it } from 'vitest';

import {
  createPgExecutor,
  DualJournalMigrationError,
  formatReport,
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
  const calls: string[] = [];
  let pendingInserts: Array<{ created_at: number; hash: string }> = [];
  let pendingStatements: string[] = [];

  const executor: MigrationExecutor = {
    exec: async (sql) => {
      calls.push(sql);
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
      calls.push(sql);
      if (sql.startsWith('SELECT id, hash, created_at')) return ledger as any[];
      if (sql.startsWith('INSERT INTO')) {
        pendingInserts.push({ created_at: params[1] as number, hash: params[0] as string });
      }
      return [];
    },
  };

  return { calls, executed, executor, ledger };
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

  it('takes the advisory lock before bootstrapping the ledger schema', async () => {
    // CREATE … IF NOT EXISTS races when two runners hit a fresh database at once.
    const db = createFakeDb();

    await runDualJournal({ executor: db.executor, tracks: [track('upstream', [entry('u1', 1)])] });

    expect(db.calls[0]).toBe('SELECT pg_advisory_lock($1)');
    expect(db.calls.findIndex((sql) => sql.startsWith('CREATE SCHEMA'))).toBeGreaterThan(0);
    expect(db.calls.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
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

describe('createPgExecutor', () => {
  it('sends every statement through the one dedicated client', async () => {
    const calls: Array<[string, unknown[] | undefined]> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push([sql, params]);
        return { rows: [{ ok: 1 }] };
      },
    };
    const executor = createPgExecutor(client);

    await executor.exec('BEGIN');
    const rows = await executor.query('SELECT $1', [1]);
    await executor.exec('COMMIT');

    expect(rows).toEqual([{ ok: 1 }]);
    expect(calls).toEqual([
      ['BEGIN', undefined],
      ['SELECT $1', [1]],
      ['COMMIT', undefined],
    ]);
  });
});

describe('formatReport', () => {
  it('summarizes a report on one line, naming drifted entries', () => {
    expect(
      formatReport({
        applied: ['a'],
        drift: [{ appliedHash: 'x', currentHash: 'y', tag: '0132' }],
        equivalent: [],
        skipped: [],
        unknownRows: [],
      }),
    ).toBe('applied=1 skipped=0 equivalent=0 drift=1 (0132) unknownRows=0');
  });

  it('prints the no-op line the Docker smoke test expects', () => {
    expect(
      formatReport({ applied: [], drift: [], equivalent: [], skipped: [], unknownRows: [] }),
    ).toBe('applied=0 skipped=0 equivalent=0 drift=0 unknownRows=0');
  });
});
