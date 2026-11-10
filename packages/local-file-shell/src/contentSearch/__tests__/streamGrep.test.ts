import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GrepContentParams, GrepContentResult } from '../../types';
import { BaseContentSearch } from '../base';

// Mock logger to keep test output clean
vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Simulate the production condition where a large file cannot be buffered
// into memory (OOM / over-limit): buffered reads always fail, so only the
// streaming path can possibly return matches.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readFile: vi.fn().mockRejectedValue(new Error('mock OOM: file too large to buffer')),
  };
});

class TestContentSearch extends BaseContentSearch {
  async grep(params: GrepContentParams): Promise<GrepContentResult> {
    return this.grepWithNodejs(params);
  }

  async checkToolAvailable(): Promise<boolean> {
    return true;
  }
}

describe('grepWithNodejs large-file streaming', () => {
  let dir: string;
  let contentSearch: TestContentSearch;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(path.join(tmpdir(), 'stream-grep-'));
    contentSearch = new TestContentSearch();
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  const seedLargeCsv = (targetEmail: string): string => {
    const file = path.join(dir, 'contacts.csv');
    const header = 'id,name,email,phone\n';
    // ~12MB: past the 10MB streaming threshold
    const fillerLine =
      '1,John Doe,john.doe@example.com,555-0100,extra,columns,padding,0123456789\n';
    const repeat = Math.ceil((12 * 1024 * 1024) / fillerLine.length);
    writeFileSync(
      file,
      header + fillerLine.repeat(repeat) + `999999,Jane Doe,${targetEmail},555-0199\n`,
    );
    return file;
  };

  it('finds a match on the last line of a 12MB file in content mode', async () => {
    const file = seedLargeCsv('mahdyaralipor0@gmail.com');

    const result = await contentSearch.grep({
      '-n': true,
      'output_mode': 'content',
      'path': file,
      'pattern': 'mahdyaralipor0@gmail\\.com',
    });

    expect(result.success).toBe(true);
    expect(result.engine).toBe('nodejs');
    expect(result.total_matches).toBe(1);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toContain('mahdyaralipor0@gmail.com');
  });

  it('returns the file path in files_with_matches mode', async () => {
    const file = seedLargeCsv('mahdyaralipor0@gmail.com');

    const result = await contentSearch.grep({
      output_mode: 'files_with_matches',
      path: file,
      pattern: 'mahdyaralipor0@gmail\\.com',
    });

    expect(result.success).toBe(true);
    expect(result.matches).toContain(file);
  });

  it('counts matches in count mode', async () => {
    const file = seedLargeCsv('mahdyaralipor0@gmail.com');

    const result = await contentSearch.grep({
      output_mode: 'count',
      path: file,
      pattern: 'john\\.doe@example\\.com',
    });

    expect(result.success).toBe(true);
    expect(result.total_matches).toBeGreaterThan(1000);
    expect(result.matches).toHaveLength(1);
  });

  it('emits before-context around a match in a large file', async () => {
    const file = seedLargeCsv('mahdyaralipor0@gmail.com');

    const result = await contentSearch.grep({
      '-B': 1,
      '-n': true,
      'output_mode': 'content',
      'path': file,
      'pattern': 'mahdyaralipor0@gmail\\.com',
    });

    expect(result.success).toBe(true);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[1]).toContain('mahdyaralipor0@gmail.com');
  });

  it('surfaces the error instead of silently succeeding when a single file cannot be read', async () => {
    const file = path.join(dir, 'tiny.txt');
    writeFileSync(file, 'hello world\n');

    const result = await contentSearch.grep({
      output_mode: 'content',
      path: file,
      pattern: 'hello',
    });

    // readFile is mocked to fail: today this resolves success:true with zero
    // matches and the user never learns the search did nothing.
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mock OOM/);
    expect(result.matches).toHaveLength(0);
  });
});
