// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../../core/getTestDB';
import { documents, files } from '../../../schemas/file';
import { users } from '../../../schemas/user';
import type { LobeChatDatabase } from '../../../type';
import { KnowledgeRepo } from '../index';

const userId = 'knowledge-list-shape-user';
const serverDB: LobeChatDatabase = await getTestDB();
const repo = new KnowledgeRepo(serverDB, userId);

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values({ id: userId });
});

describe('KnowledgeRepo list shape', () => {
  it('never returns page bodies in list or recent rows', async () => {
    await serverDB.insert(documents).values({
      content: 'x'.repeat(10_000),
      editorData: { root: { children: [] } },
      fileType: 'custom/document',
      id: 'docs_big_page',
      source: 'document',
      sourceType: 'api',
      title: 'Big page',
      totalCharCount: 10_000,
      totalLineCount: 1,
      userId,
    });

    const [listed] = await repo.query({ limit: 10 });
    const [recent] = await repo.queryRecent(10, 'page');

    expect(listed).toMatchObject({ content: null, editorData: null, id: 'docs_big_page' });
    expect(recent).toMatchObject({ content: null, editorData: null, id: 'docs_big_page' });
  });

  it('pages through rows that share a timestamp without repeats or gaps', async () => {
    const sameTime = new Date('2026-01-01T00:00:00.000Z');
    const ids = Array.from({ length: 30 }, (_, i) => `file_tie_${String(i).padStart(2, '0')}`);
    await serverDB.insert(files).values(
      ids.map((id) => ({
        createdAt: sameTime,
        fileType: 'text/plain',
        id,
        name: `${id}.txt`,
        size: 1,
        updatedAt: sameTime,
        url: `files/1/${id}.txt`,
        userId,
      })),
    );

    const seen: string[] = [];
    for (let offset = 0; offset < 30; offset += 7) {
      const page = await repo.query({ limit: 7, offset });
      seen.push(...page.map((item) => item.id));
    }

    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });
});
