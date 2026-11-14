// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { files, globalFiles, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { FileModel } from '../file';

const serverDB: LobeChatDatabase = await getTestDB();

const ownerId = 'storage-claims-owner';
const otherId = 'storage-claims-other';
const ownerModel = new FileModel(serverDB, ownerId);
const otherModel = new FileModel(serverDB, otherId);

const seedGlobal = (hashId: string, url: string) =>
  serverDB.insert(globalFiles).values({
    creator: ownerId,
    fileType: 'image/png',
    hashId,
    size: 10,
    url,
  });

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values([{ id: ownerId }, { id: otherId }]);
});

afterEach(async () => {
  await serverDB.delete(files);
  await serverDB.delete(globalFiles);
  await serverDB.delete(users);
});

describe('FileModel storage key claims', () => {
  it('classifies a key by who uses it', async () => {
    await seedGlobal('hash-a', 'files/1/a.png');
    await ownerModel.create({
      fileHash: 'hash-a',
      fileType: 'image/png',
      name: 'a.png',
      size: 10,
      url: 'files/1/a.png',
    });

    expect(await ownerModel.getStorageKeyClaim('files/1/a.png')).toBe('own');
    expect(await otherModel.getStorageKeyClaim('files/1/a.png')).toBe('foreign');
    expect(await otherModel.getStorageKeyClaim('files/1/fresh.png')).toBe('unreferenced');
  });

  it('treats a global row key as own only for users who own that hash', async () => {
    await seedGlobal('hash-b', 'files/1/global-b.png');
    await otherModel.create({
      fileHash: 'hash-b',
      fileType: 'image/png',
      name: 'b.png',
      size: 10,
      url: 'files/2/other-copy.png',
    });

    expect(await otherModel.getStorageKeyClaim('files/1/global-b.png')).toBe('own');
    expect(await ownerModel.getStorageKeyClaim('files/1/global-b.png')).toBe('foreign');
  });

  it('only reports hashes and own copies the caller owns', async () => {
    await seedGlobal('hash-c', 'files/1/c.png');
    await ownerModel.create({
      fileHash: 'hash-c',
      fileType: 'image/png',
      name: 'c.png',
      size: 10,
      url: 'files/1/c.png',
    });

    expect(await ownerModel.hasOwnFileWithHash('hash-c')).toBe(true);
    expect(await otherModel.hasOwnFileWithHash('hash-c')).toBe(false);
    expect(await otherModel.hasAnyFileWithHash('hash-c')).toBe(true);
    expect(await ownerModel.findOwnFileByHash('hash-c')).toMatchObject({ url: 'files/1/c.png' });
    expect(await otherModel.findOwnFileByHash('hash-c')).toBeUndefined();
  });

  it('keeps keys that any row still points at out of storage cleanup', async () => {
    await seedGlobal('hash-d', 'files/1/d-global.png');
    await otherModel.create({
      fileHash: 'hash-d',
      fileType: 'image/png',
      name: 'd.png',
      size: 10,
      url: 'files/2/d-row.png',
    });

    const result = await ownerModel.filterUnreferencedStorageKeys([
      'files/1/d-global.png',
      'files/2/d-row.png',
      'files/3/gone.png',
      'files/3/gone.png',
    ]);

    expect(result).toEqual(['files/3/gone.png']);
  });

  it('returns the released global key when the last row of a hash is deleted', async () => {
    await seedGlobal('hash-e', 'files/1/e-global.png');
    const { id } = await ownerModel.create({
      fileHash: 'hash-e',
      fileType: 'image/png',
      name: 'e.png',
      size: 10,
      url: 'files/2/e-row.png',
    });

    const removed = await ownerModel.delete(id, true);

    expect(removed).toMatchObject({
      globalFileUrl: 'files/1/e-global.png',
      url: 'files/2/e-row.png',
    });
    expect(
      await ownerModel.filterUnreferencedStorageKeys([removed!.url, removed!.globalFileUrl!]),
    ).toEqual(['files/2/e-row.png', 'files/1/e-global.png']);
  });
});
