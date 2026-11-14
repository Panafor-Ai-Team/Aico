// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { documents, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { DocumentModel } from '../document';

const serverDB: LobeChatDatabase = await getTestDB();
const userId = 'subtree-loop-user';
const model = new DocumentModel(serverDB, userId);

const folder = (id: string, parentId: string | null) => ({
  content: '',
  fileType: 'custom/folder',
  id,
  parentId,
  source: 'document',
  sourceType: 'api' as const,
  title: id,
  totalCharCount: 0,
  totalLineCount: 0,
  userId,
});

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values({ id: userId });
});

afterEach(async () => {
  await serverDB.delete(users);
});

describe('DocumentModel subtree walk', () => {
  it('ends when stored parent links form a loop', async () => {
    await serverDB.insert(documents).values([folder('loop-a', null), folder('loop-b', 'loop-a')]);
    // Close the loop after insert (parent FK needs both rows to exist).
    const { eq } = await import('drizzle-orm');
    await serverDB.update(documents).set({ parentId: 'loop-b' }).where(eq(documents.id, 'loop-a'));

    await expect(model.countFileUsageInSubtree('loop-a')).resolves.toBe(0);
  });
});
