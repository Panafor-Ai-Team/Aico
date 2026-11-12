// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { documents, files, globalFiles, knowledgeBaseFiles, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { KnowledgeBaseModel } from '../knowledgeBase';

const serverDB: LobeChatDatabase = await getTestDB();

const attackerId = 'kb-foreign-attacker';
const victimId = 'kb-foreign-victim';
const attackerModel = new KnowledgeBaseModel(serverDB, attackerId);

const seedVictimFile = async () => {
  await serverDB.insert(globalFiles).values({
    creator: victimId,
    fileType: 'application/pdf',
    hashId: 'victim-hash',
    size: 1,
    url: 'files/1/victim.pdf',
  });
  await serverDB.insert(files).values({
    fileHash: 'victim-hash',
    fileType: 'application/pdf',
    id: 'file_victim',
    name: 'victim.pdf',
    size: 1,
    url: 'files/1/victim.pdf',
    userId: victimId,
  });
  await serverDB.insert(documents).values({
    content: 'victim private text',
    fileId: 'file_victim',
    fileType: 'application/pdf',
    id: 'docs_victim_parse',
    source: 'files/1/victim.pdf',
    sourceType: 'file',
    totalCharCount: 19,
    totalLineCount: 1,
    userId: victimId,
  });
};

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.delete(globalFiles);
  await serverDB.insert(users).values([{ id: attackerId }, { id: victimId }]);
});

afterEach(async () => {
  await serverDB.delete(users);
  await serverDB.delete(globalFiles);
});

describe('KnowledgeBaseModel with other users files', () => {
  it('does not link a file id the caller does not own', async () => {
    await seedVictimFile();
    const kb = await attackerModel.create({ name: 'mine' });

    const linked = await attackerModel.addFilesToKnowledgeBase(kb.id, ['file_victim']);

    expect(linked).toEqual([]);
    const links = await serverDB
      .select()
      .from(knowledgeBaseFiles)
      .where(eq(knowledgeBaseFiles.knowledgeBaseId, kb.id));
    expect(links).toEqual([]);
  });

  it('does not copy or take over a foreign file that an old link points at', async () => {
    await seedVictimFile();
    const kb = await attackerModel.create({ name: 'mine' });
    // A link written before the ownership check existed.
    await serverDB
      .insert(knowledgeBaseFiles)
      .values({ fileId: 'file_victim', knowledgeBaseId: kb.id, userId: attackerId });

    await attackerModel.copyToWorkspace(kb.id, null, attackerId);
    await attackerModel.transferTo(kb.id, null, attackerId);

    const attackerFiles = await serverDB.select().from(files).where(eq(files.userId, attackerId));
    const attackerDocs = await serverDB
      .select()
      .from(documents)
      .where(eq(documents.userId, attackerId));
    expect(attackerFiles).toEqual([]);
    expect(attackerDocs).toEqual([]);

    const [victimFile] = await serverDB.select().from(files).where(eq(files.id, 'file_victim'));
    expect(victimFile.userId).toBe(victimId);
  });
});
