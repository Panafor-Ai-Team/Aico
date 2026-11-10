import { describe, expect, it, vi } from 'vitest';

import { searchSkills, toDetail, toListItem } from './skillCatalog';

const row = {
  author: { name: 'acme', url: 'https://github.com/acme' },
  category: 'devops-cloud',
  content: '# skill body',
  description: 'does things',
  github: { fullName: 'acme/skill', stars: 3, url: 'https://github.com/acme/skill' },
  identifier: 'acme-skill',
  installs: 42,
  manifest: { name: 'skill' },
  name: 'skill',
  repo: 'acme/skill',
  resources: { 'ref/a.md': { content: 'x' } },
  stars: 3,
  updated_at: '2026-11-09T00:00:00.000Z',
  version: '1.0.0',
};

describe('skillCatalog', () => {
  it('maps a catalog row to a market list item', () => {
    expect(toListItem(row)).toMatchObject({
      author: 'acme',
      category: 'devops-cloud',
      commentCount: 0,
      identifier: 'acme-skill',
      installCount: 42,
      isFeatured: false,
      name: 'skill',
      ratingCount: 0,
      updatedAt: row.updated_at,
      version: '1.0.0',
    });
  });

  it('maps a catalog row to market detail, keeping resources and manifest', () => {
    const detail = toDetail(row);

    expect(detail.content).toBe('# skill body');
    expect(detail.manifest).toEqual({ name: 'skill' });
    expect(detail.resources).toEqual({ 'ref/a.md': { content: 'x' } });
    expect(detail.repository).toBe('acme/skill');
    expect(detail.overview.summary).toBe('does things');
    expect(detail.author).toEqual({ name: 'acme', url: 'https://github.com/acme' });
  });

  it('falls back to LIKE when the BM25 query syntax rejects user input', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('syntax error in query'))
      .mockResolvedValueOnce({ rows: [{ ...row, total: 1 }] });

    const result = await searchSkills({ execute } as any, { q: 'a"b', pageSize: 10 });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ currentPage: 1, pageSize: 10, totalCount: 1, totalPages: 1 });
    expect(result.items[0].identifier).toBe('acme-skill');
  });

  it('reports an unseeded catalog so the caller can fall back upstream', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });

    await expect(searchSkills({ execute } as any, { q: 'anything' })).rejects.toThrow(
      /skill_catalog unavailable/,
    );
  });
});
