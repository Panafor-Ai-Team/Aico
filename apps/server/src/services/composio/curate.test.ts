import { describe, expect, it, vi } from 'vitest';

import {
  classifyComposioTool,
  curateComposioTools,
  fetchCuratedComposioTools,
  type RawToolsClient,
} from './curate';

const tool = (slug: string, tags: string[] = []) => ({ slug, tags });

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

  it('fetches the full list for every app, not just the SDK important page', async () => {
    const getRawComposioTools = vi.fn().mockResolvedValue({ items: [tool('GMAIL_FETCH_EMAILS')] });

    await fetchCuratedComposioTools(clientWith(getRawComposioTools), 'gmail');

    expect(getRawComposioTools).toHaveBeenCalledWith({ limit: 1000, toolkits: ['gmail'] });
  });

  // Regression: Google Drive's first "important" page was 20 alphabetical writes
  // (ADD_FILE_SHARING_PREFERENCE … EMPTY_TRASH) with no way to list or find files.
  it('keeps find/list reads for an app without a priority list and drops destructive tools', async () => {
    const getRawComposioTools = vi
      .fn()
      .mockResolvedValue([
        tool('GOOGLEDRIVE_FIND_FILE', ['readOnlyHint', 'important']),
        tool('GOOGLEDRIVE_DOWNLOAD_FILE', ['readOnlyHint', 'important']),
        tool('GOOGLEDRIVE_GET_ABOUT', ['readOnlyHint']),
        tool('GOOGLEDRIVE_CREATE_FOLDER', ['important']),
        tool('GOOGLEDRIVE_EMPTY_TRASH', ['destructiveHint', 'important']),
        tool('GOOGLEDRIVE_DELETE_FILE', ['destructiveHint', 'important']),
        tool('GOOGLEDRIVE_STOP_WATCH_CHANNEL'),
      ]);

    const result = await fetchCuratedComposioTools(clientWith(getRawComposioTools), 'googledrive');
    const slugs = result.map((t) => t.slug);

    expect(slugs).toContain('GOOGLEDRIVE_FIND_FILE');
    expect(slugs).toContain('GOOGLEDRIVE_DOWNLOAD_FILE');
    expect(slugs).toContain('GOOGLEDRIVE_CREATE_FOLDER');
    expect(slugs).not.toContain('GOOGLEDRIVE_EMPTY_TRASH');
    expect(slugs).not.toContain('GOOGLEDRIVE_DELETE_FILE');
    expect(slugs).not.toContain('GOOGLEDRIVE_STOP_WATCH_CHANNEL');
  });
});

describe('classifyComposioTool', () => {
  it('trusts Composio hints over the tool name', () => {
    expect(classifyComposioTool(tool('GOOGLEDRIVE_DOWNLOAD_FILE', ['readOnlyHint']))).toBe('read');
    expect(classifyComposioTool(tool('GOOGLEDRIVE_EMPTY_TRASH', ['destructiveHint']))).toBe(
      'delete',
    );
  });

  it('classifies a multi-word namespace read (ONE_DRIVE_GET_ITEM) from its hint', () => {
    expect(classifyComposioTool(tool('ONE_DRIVE_GET_ITEM', ['readOnlyHint']))).toBe('read');
  });

  it('falls back to name inference for untagged tools', () => {
    expect(classifyComposioTool(tool('GMAIL_FETCH_EMAILS'))).toBe('read');
    expect(classifyComposioTool(tool('GMAIL_SEND_EMAIL'))).toBe('write');
  });
});

describe('curateComposioTools ranking', () => {
  it('ranks important reads and list/search verbs ahead of other reads within the budget', () => {
    const result = curateComposioTools(
      [
        tool('APP_GET_ZZZ', ['readOnlyHint']),
        tool('APP_LIST_THINGS', ['readOnlyHint']),
        tool('APP_GET_CORE', ['readOnlyHint', 'important']),
      ],
      { max: 2 },
    );

    expect(result.map((t) => t.slug)).toEqual(['APP_GET_CORE', 'APP_LIST_THINGS']);
  });

  it('drops deprecated tools', () => {
    const result = curateComposioTools([
      { isDeprecated: true, slug: 'APP_LIST_OLD', tags: ['readOnlyHint'] },
      tool('APP_LIST_NEW', ['readOnlyHint']),
    ]);

    expect(result.map((t) => t.slug)).toEqual(['APP_LIST_NEW']);
  });
});
