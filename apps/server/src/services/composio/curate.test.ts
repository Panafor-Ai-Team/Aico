import { describe, expect, it, vi } from 'vitest';

import { curateComposioTools, fetchCuratedComposioTools, type RawToolsClient } from './curate';

const tool = (slug: string) => ({ slug });

const clientWith = (getRawComposioTools: RawToolsClient['tools']['getRawComposioTools']) =>
  ({ tools: { getRawComposioTools } }) as RawToolsClient;

describe('curateComposioTools', () => {
  it('keeps prioritized reads and writes, drops other writes', () => {
    const tools = [
      tool('GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER'),
      tool('GITHUB_CREATE_A_CHECK_RUN'),
      tool('GITHUB_CREATE_AN_ISSUE'),
      tool('GITHUB_DELETE_A_REPOSITORY'),
    ];

    const result = curateComposioTools(tools, {
      prioritySlugs: [
        'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
        'GITHUB_CREATE_AN_ISSUE',
      ],
    });

    expect(result.map((t) => t.slug)).toEqual([
      'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
      'GITHUB_CREATE_AN_ISSUE',
    ]);
  });

  it('caps the manifest and dedupes slugs', () => {
    const tools = Array.from({ length: 60 }, (_, i) => tool(`GITHUB_LIST_THING_${i}`));
    tools.push(tool('GITHUB_LIST_THING_0'));

    const result = curateComposioTools(tools, { max: 10 });

    expect(result).toHaveLength(10);
    expect(new Set(result.map((t) => t.slug)).size).toBe(10);
  });

  it('does not stop adding reads when there are no priority writes', () => {
    const tools = [tool('GITHUB_GET_A_REPOSITORY'), tool('GITHUB_CREATE_A_COMMIT')];

    expect(curateComposioTools(tools, { max: 5 }).map((t) => t.slug)).toEqual([
      'GITHUB_GET_A_REPOSITORY',
    ]);
  });
});

describe('fetchCuratedComposioTools', () => {
  it('fetches the full GitHub list (limit disables the important-only page) and curates it', async () => {
    const getRawComposioTools = vi
      .fn()
      .mockResolvedValue([
        tool('GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER'),
        tool('GITHUB_DELETE_A_REPOSITORY'),
      ]);

    const result = await fetchCuratedComposioTools(clientWith(getRawComposioTools), 'github');

    expect(getRawComposioTools).toHaveBeenCalledWith({ limit: 1000, toolkits: ['github'] });
    expect(result.map((t) => t.slug)).toEqual([
      'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
    ]);
  });

  it('keeps the previous important-page behaviour for apps without curation', async () => {
    const getRawComposioTools = vi.fn().mockResolvedValue({ items: [tool('GMAIL_SEND')] });

    const result = await fetchCuratedComposioTools(clientWith(getRawComposioTools), 'gmail');

    expect(getRawComposioTools).toHaveBeenCalledWith({ toolkits: ['gmail'] });
    expect(result.map((t) => t.slug)).toEqual(['GMAIL_SEND']);
  });
});
