import path from 'node:path';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

import {
  analyzeLedger,
  extractCreatedTables,
  type JournalEntry,
  readJournal,
} from './migrationLedger';

const migrationsFolder = path.join(__dirname, '../../packages/database/migrations');

const entry = (tag: string, when: number, hash = `hash-${tag}`): JournalEntry => ({
  createdTables: [],
  hash,
  idx: 0,
  tag,
  when,
});

describe('readJournal', () => {
  const journal = readJournal(migrationsFolder);

  it('hashes every migration exactly like drizzle-orm', () => {
    const drizzle = readMigrationFiles({ migrationsFolder });

    expect(journal.map((e) => e.hash)).toEqual(drizzle.map((m) => m.hash));
    expect(journal.map((e) => e.when)).toEqual(drizzle.map((m) => m.folderMillis));
  });

  it('keeps journal `when` values unique, so ledger rows map to one entry', () => {
    const whens = journal.map((e) => e.when);

    expect(new Set(whens).size).toBe(whens.length);
  });
});

describe('extractCreatedTables', () => {
  it('finds plain, guarded and schema-qualified CREATE TABLE targets', () => {
    expect(
      extractCreatedTables(`
        CREATE TABLE "a" (id text);
        CREATE TABLE IF NOT EXISTS "b" (id text);
        CREATE TABLE "public"."c" (id text);
        CREATE TABLE IF NOT EXISTS "a" (id text);
      `),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('analyzeLedger', () => {
  it('matches rows to entries by created_at', () => {
    const journal = [entry('0001', 1), entry('0002', 2)];
    const report = analyzeLedger(journal, [
      { createdAt: 1, hash: 'hash-0001', id: 1 },
      { createdAt: 2, hash: 'hash-0002', id: 2 },
    ]);

    expect(report.matched).toBe(2);
    expect(report.missing).toEqual([]);
    expect(report.drizzlePending).toEqual([]);
  });

  it('flags an entry the stock migrator skipped because a newer `when` was applied first', () => {
    // The 0141 / 0142 shape: 0141 is stamped later than 0142 and shipped first.
    const journal = [entry('0140', 100), entry('0141', 300), entry('0142', 200)];
    const report = analyzeLedger(journal, [
      { createdAt: 100, hash: 'hash-0140', id: 1 },
      { createdAt: 300, hash: 'hash-0141', id: 2 },
    ]);

    expect(report.missing).toEqual([
      { createdTables: [], skippedByDrizzle: true, tag: '0142', when: 200 },
    ]);
    expect(report.drizzlePending).toEqual([]);
  });

  it('reports genuinely pending entries newer than every row', () => {
    const report = analyzeLedger(
      [entry('0001', 1), entry('0002', 2)],
      [{ createdAt: 1, hash: 'hash-0001', id: 1 }],
    );

    expect(report.missing).toEqual([
      { createdTables: [], skippedByDrizzle: false, tag: '0002', when: 2 },
    ]);
    expect(report.drizzlePending).toEqual([{ tag: '0002', when: 2 }]);
  });

  it('reports unknown and duplicate rows', () => {
    const report = analyzeLedger(
      [entry('0001', 1)],
      [
        { createdAt: 1, hash: 'hash-0001', id: 1 },
        { createdAt: 1, hash: 'hash-0001', id: 2 },
        { createdAt: 99, hash: 'stray', id: 3 },
      ],
    );

    expect(report.unknownRows.map((row) => row.id)).toEqual([3]);
    expect(report.duplicateRows.map((row) => row.id)).toEqual([1, 2]);
  });

  it('reports hash drift when the file changed after it was applied', () => {
    const report = analyzeLedger([entry('0132', 5, 'new')], [{ createdAt: 5, hash: 'old', id: 1 }]);

    expect(report.matched).toBe(1);
    expect(report.hashDrift).toEqual([{ appliedHash: 'old', currentHash: 'new', tag: '0132' }]);
  });

  it('treats an empty ledger as everything pending', () => {
    const report = analyzeLedger([entry('0001', 1)], []);

    expect(report.maxCreatedAt).toBeNull();
    expect(report.missing[0].skippedByDrizzle).toBe(false);
    expect(report.drizzlePending).toEqual([{ tag: '0001', when: 1 }]);
  });
});
