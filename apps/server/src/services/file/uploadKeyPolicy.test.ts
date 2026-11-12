// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { assertUploadKeyIsFree, isSafeUploadKey } from './uploadKeyPolicy';

const ID = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b';

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
