// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { assertUploadKeyIsFree, isSafeUploadKey } from './uploadKeyPolicy';

const ID = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b';
const HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('isSafeUploadKey', () => {
  it.each([
    `files/482910/${ID}.png`,
    `files/482910/${ID}.README`,
    `files/482910/${ID}.`,
    `files/482910/${ID}.پی‌دی‌اف`,
    `skills/482910/${ID}.zip`,
    `ragEval/482910/${ID}.csv`,
    `eval-datasets/482910/${ID}.jsonl`,
    `import_config/${ID}.json`,
    // CLI `uploadLocalFile` and the desktop agents' `fileStoreImageUploader`
    // name uploads after the sha256 of the bytes (no extension when the local
    // file has none).
    `files/2026-11-14/${HASH}.png`,
    `files/2026-11-14/${HASH}`,
    `files/2026-11-14/${HASH.toUpperCase()}.pdf`,
  ])('accepts the client shape %s', (key) => {
    expect(isSafeUploadKey(key)).toBe(true);
  });

  it.each([
    '',
    `generations/482910/${ID}.png`,
    `files/${ID}`,
    `files/482910/..//${ID}.png`,
    `files/../482910/${ID}.png`,
    `files/482910/${ID}.png/extra`,
    `/files/482910/${ID}.png`,
    `files\\482910\\${ID}.png`,
    `files/a/b/c/d/${ID}.png`,
    'files/482910/avatar.png',
    `files/482910/${ID.replace('4d3b', '1d3b')}.png`,
    `files/482910/${ID}.a\u0000b`,
    `files/482910/${ID}.${'x'.repeat(600)}`,
    `files/2026-11-14/${HASH.slice(1)}.png`,
    `files/2026-11-14/${HASH}0.png`,
    `files/2026-11-14/${HASH.slice(1)}g.png`,
    `files/2026-11-14/${HASH}.a\u0000b`,
    `generations/2026-11-14/${HASH}.png`,
  ])('rejects %s', (key) => {
    expect(isSafeUploadKey(key)).toBe(false);
  });
});

describe('assertUploadKeyIsFree', () => {
  it('passes when HEAD fails (no object)', async () => {
    const storage = { getFileMetadata: vi.fn().mockRejectedValue(new Error('NotFound')) };
    await expect(assertUploadKeyIsFree(storage, 'k')).resolves.toBeUndefined();
  });

  it('throws FORBIDDEN when the object exists', async () => {
    const storage = { getFileMetadata: vi.fn().mockResolvedValue({}) };
    await expect(assertUploadKeyIsFree(storage, 'k')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
