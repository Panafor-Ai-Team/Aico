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

  it('keeps reads ahead of backfilled writes when there is no priority list', () => {
    // Backfill advertises non-important writes so every app can act, but reads
    // still come first in the returned set.
    const tools = [tool('GITHUB_GET_A_REPOSITORY'), tool('GITHUB_CREATE_A_COMMIT')];

    expect(curateComposioTools(tools, { max: 5 }).map((t) => t.slug)).toEqual([
      'GITHUB_GET_A_REPOSITORY',
      'GITHUB_CREATE_A_COMMIT',
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

  // Regression: without a priority list, the 8 write slots filled alphabetically
  // (ADD_FILE_SHARING_PREFERENCE … CREATE_COMMENT) and the in-place edit tools
  // were dropped. Shaped like the live catalog (2026-11-17).
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

  it('ranks mutation verbs (UPDATE/EDIT/MOVE) ahead of ancillary creates in the default write slots', () => {
    const writes = [
      tool('GDRIVE_ADD_FILE_SHARING_PREFERENCE', ['important']),
      tool('GDRIVE_CREATE_COMMENT', ['important']),
      tool('GDRIVE_CREATE_SHORTCUT_TO_FILE', ['important']),
      tool('GDRIVE_CREATE_FOLDER', ['important']),
      tool('GDRIVE_UPDATE_SPREADSHEET_VALUES', ['important']),
      tool('GDRIVE_MOVE_FILE', ['important']),
      tool('GDRIVE_EDIT_FILE', ['important']),
      tool('GDRIVE_CREATE_FILE_FROM_TEXT', ['important']),
      tool('GDRIVE_CREATE_FILE_FROM_TEXT2', ['important']),
      tool('GDRIVE_UPLOAD_FILE', ['important']),
      tool('GDRIVE_REPLACE_FILE'), // not important — must lose the slot contest
    ];
    const result = curateComposioTools(writes, { max: 20 });
    const slugs = result.map((t) => t.slug);

    expect(slugs).toContain('GDRIVE_UPDATE_SPREADSHEET_VALUES');
    expect(slugs).toContain('GDRIVE_MOVE_FILE');
    expect(slugs).toContain('GDRIVE_EDIT_FILE');
    expect(slugs.indexOf('GDRIVE_UPDATE_SPREADSHEET_VALUES')).toBeLessThan(
      slugs.indexOf('GDRIVE_ADD_FILE_SHARING_PREFERENCE'),
    );
    expect(slugs).not.toContain('GDRIVE_REPLACE_FILE'); // not important, 8-slot cap
  });

  // Regression: Zendesk tags none of its writes as `important`, so the default
  // path advertised zero write tools — the agent could read but never act.
  it('backfills the write slots with mutation-verb writes when none are important', () => {
    const result = curateComposioTools(
      [
        tool('ZENDESK_SEARCH_TICKETS', ['readOnlyHint', 'important']),
        tool('ZENDESK_GET_TICKET', ['readOnlyHint', 'important']),
        tool('ZENDESK_UPDATE_TICKET', ['updateHint']),
        tool('ZENDESK_ADD_COMMENT_TO_TICKET', ['createHint']),
        tool('ZENDESK_CREATE_ACCESS_RULE', ['createHint']),
        tool('ZENDESK_DELETE_TICKET', ['destructiveHint', 'important']),
      ],
      { max: 5 },
    );
    const slugs = result.map((t) => t.slug);

    expect(slugs).toContain('ZENDESK_UPDATE_TICKET'); // mutation verb outranks alphabetical
    expect(slugs).toContain('ZENDESK_ADD_COMMENT_TO_TICKET');
    expect(slugs).toContain('ZENDESK_CREATE_ACCESS_RULE'); // backfill fills remaining slots
    expect(slugs).not.toContain('ZENDESK_DELETE_TICKET');
    expect(result.filter((t) => !t.tags?.includes('readOnlyHint'))).toHaveLength(3);
  });

  it('advertises the Google Drive in-place edit tools from its priority list', async () => {
    const getRawComposioTools = vi.fn().mockResolvedValue(
      [
        'GOOGLEDRIVE_FIND_FILE|readOnlyHint',
        'GOOGLEDRIVE_LIST_FILES|readOnlyHint',
        'GOOGLEDRIVE_GET_FILE_METADATA|readOnlyHint',
        'GOOGLEDRIVE_DOWNLOAD_FILE|readOnlyHint',
        'GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE|readOnlyHint',
        'GOOGLEDRIVE_PARSE_FILE|readOnlyHint',
        'GOOGLEDRIVE_READ_SPREADSHEET_VALUES|readOnlyHint',
        'GOOGLEDRIVE_BATCH_GET_SPREADSHEET_VALUES|readOnlyHint',
        'GOOGLEDRIVE_EDIT_FILE',
        'GOOGLEDRIVE_UPDATE_FILE_PUT',
        'GOOGLEDRIVE_MOVE_FILE',
        'GOOGLEDRIVE_CREATE_FILE_FROM_TEXT',
        'GOOGLEDRIVE_CREATE_FOLDER',
        'GOOGLEDRIVE_COPY_FILE_ADVANCED',
        'GOOGLEDRIVE_UPDATE_SPREADSHEET_VALUES',
        'GOOGLEDRIVE_BATCH_UPDATE_SPREADSHEET_VALUES',
        'GOOGLEDRIVE_CREATE_COMMENT',
        'GOOGLEDRIVE_EMPTY_TRASH|destructiveHint',
        'GOOGLEDRIVE_DELETE_FILE|destructiveHint',
        // Pad with extra reads past the 40-tool cap so the cap is exercised.
        ...Array.from({ length: 30 }, (_, i) => `GOOGLEDRIVE_GET_THING_${i}|readOnlyHint`),
      ].map((entry) => {
        const [slug, tags = ''] = entry.split('|');
        return tool(slug, tags ? tags.split(',') : []);
      }),
    );

    const result = await fetchCuratedComposioTools(clientWith(getRawComposioTools), 'googledrive');
    const slugs = result.map((t) => t.slug);

    for (const editTool of [
      'GOOGLEDRIVE_EDIT_FILE',
      'GOOGLEDRIVE_UPDATE_FILE_PUT',
      'GOOGLEDRIVE_MOVE_FILE',
      'GOOGLEDRIVE_UPDATE_SPREADSHEET_VALUES',
      'GOOGLEDRIVE_BATCH_UPDATE_SPREADSHEET_VALUES',
    ]) {
      expect(slugs).toContain(editTool);
    }
    expect(slugs).not.toContain('GOOGLEDRIVE_CREATE_COMMENT');
    expect(slugs).not.toContain('GOOGLEDRIVE_EMPTY_TRASH');
    expect(slugs).not.toContain('GOOGLEDRIVE_DELETE_FILE');
  });

  it('advertises the Google Docs markdown edit tools from its priority list', async () => {
    const getRawComposioTools = vi
      .fn()
      .mockResolvedValue([
        tool('GOOGLEDOCS_GET_DOCUMENT_BY_ID', ['readOnlyHint']),
        tool('GOOGLEDOCS_SEARCH_DOCUMENTS', ['readOnlyHint']),
        tool('GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN'),
        tool('GOOGLEDOCS_REPLACE_ALL_TEXT'),
        tool('GOOGLEDOCS_INSERT_TEXT_ACTION'),
        tool('GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN'),
        tool('GOOGLEDOCS_DELETE_CONTENT_RANGE'),
      ]);

    const result = await fetchCuratedComposioTools(clientWith(getRawComposioTools), 'googledocs');
    const slugs = result.map((t) => t.slug);

    expect(slugs).toContain('GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN');
    expect(slugs).toContain('GOOGLEDOCS_REPLACE_ALL_TEXT');
    expect(slugs).toContain('GOOGLEDOCS_INSERT_TEXT_ACTION');
  });

  it('advertises the Google Sheets value-update tools from its priority list', async () => {
    const getRawComposioTools = vi
      .fn()
      .mockResolvedValue([
        tool('GOOGLESHEETS_VALUES_GET', ['readOnlyHint']),
        tool('GOOGLESHEETS_GET_SPREADSHEET_INFO', ['readOnlyHint']),
        tool('GOOGLESHEETS_VALUES_UPDATE'),
        tool('GOOGLESHEETS_UPDATE_VALUES_BATCH'),
        tool('GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND'),
        tool('GOOGLESHEETS_UPSERT_ROWS'),
      ]);

    const result = await fetchCuratedComposioTools(clientWith(getRawComposioTools), 'googlesheets');
    const slugs = result.map((t) => t.slug);

    expect(slugs).toContain('GOOGLESHEETS_VALUES_UPDATE');
    expect(slugs).toContain('GOOGLESHEETS_UPDATE_VALUES_BATCH');
    expect(slugs).toContain('GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND');
    expect(slugs).toContain('GOOGLESHEETS_UPSERT_ROWS');
  });
});

describe('classifyComposioTool', () => {
  it('trusts Composio hints over the tool name', () => {
    expect(classifyComposioTool(tool('GOOGLEDRIVE_DOWNLOAD_FILE', ['readOnlyHint']))).toBe('read');
    expect(classifyComposioTool(tool('GOOGLEDRIVE_EMPTY_TRASH', ['destructiveHint']))).toBe(
      'delete',
    );
  });

  it('trusts updateHint / createHint over the name — Dropbox upload is not a delete', () => {
    expect(classifyComposioTool(tool('DROPBOX_ALPHA_UPLOAD_FILE', ['updateHint']))).toBe('write');
    expect(classifyComposioTool(tool('DROPBOX_CREATE_FOLDER', ['createHint']))).toBe('write');
    expect(
      classifyComposioTool(tool('DROPBOX_DELETE_FILE', ['updateHint', 'destructiveHint'])),
    ).toBe('delete');
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
