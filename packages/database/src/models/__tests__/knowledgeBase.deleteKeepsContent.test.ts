// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { documents, files, knowledgeBaseFiles, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { KnowledgeBaseModel } from '../knowledgeBase';

const serverDB: LobeChatDatabase = await getTestDB();
const userId = 'kb-delete-keeps-user';
const model = new KnowledgeBaseModel(serverDB, userId);

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values({ id: userId });
});

afterEach(async () => {
  await serverDB.delete(users);
});

describe('KnowledgeBaseModel.delete', () => {
  it('removes the library but keeps its files, pages and folders', async () => {
    const kb = await model.create({ name: 'lib' });
    await serverDB.insert(files).values({
      fileType: 'text/plain',
      id: 'file_in_lib',
      name: 'a.txt',
      size: 1,
      url: 'files/1/a.txt',
      userId,
    });
    await serverDB
      .insert(knowledgeBaseFiles)
      .values({ fileId: 'file_in_lib', knowledgeBaseId: kb.id, userId });
    await serverDB.insert(documents).values({
      content: '',
      fileType: 'custom/folder',
      id: 'docs_folder_in_lib',
      knowledgeBaseId: kb.id,
      source: 'document',
      sourceType: 'api',
      title: 'Folder',
      totalCharCount: 0,
      totalLineCount: 0,
      userId,
    });

    await model.delete(kb.id);

    const [file] = await serverDB.select().from(files).where(eq(files.id, 'file_in_lib'));
    const [folder] = await serverDB
      .select()
      .from(documents)
      .where(eq(documents.id, 'docs_folder_in_lib'));
    const links = await serverDB
      .select()
      .from(knowledgeBaseFiles)
      .where(eq(knowledgeBaseFiles.knowledgeBaseId, kb.id));

    expect(file).toBeDefined();
    expect(folder?.knowledgeBaseId).toBeNull();
    expect(links).toEqual([]);
  });
});
