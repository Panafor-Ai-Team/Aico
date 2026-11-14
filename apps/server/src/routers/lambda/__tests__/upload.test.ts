// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileS3 } from '@/server/modules/S3';

import { uploadRouter } from '../upload';

vi.mock('@/server/modules/S3', () => ({ FileS3: vi.fn() }));

const VALID_KEY = 'files/482910/1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b.png';

describe('uploadRouter.createS3PreSignedUrl', () => {
  const mockCtx: any = { userId: 'user_test' };
  let s3Mock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    s3Mock = {
      createPreSignedUrl: vi.fn().mockResolvedValue('https://storage.test/signed'),
      getFileMetadata: vi.fn().mockRejectedValue(new Error('NotFound')),
    };
    vi.mocked(FileS3).mockImplementation(() => s3Mock);
  });

  it('signs a fresh key with the client upload shape', async () => {
    const caller = uploadRouter.createCaller(mockCtx);

    await expect(caller.createS3PreSignedUrl({ pathname: VALID_KEY })).resolves.toBe(
      'https://storage.test/signed',
    );
    expect(s3Mock.createPreSignedUrl).toHaveBeenCalledWith(VALID_KEY);
  });

  it('signs the import and skill upload shapes', async () => {
    const caller = uploadRouter.createCaller(mockCtx);

    for (const pathname of [
      'import_config/1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b.json',
      'skills/482910/1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b.zip',
    ]) {
      await expect(caller.createS3PreSignedUrl({ pathname })).resolves.toBeDefined();
    }
  });

  it('refuses to overwrite an object that already exists', async () => {
    s3Mock.getFileMetadata.mockResolvedValue({ contentLength: 42 });
    const caller = uploadRouter.createCaller(mockCtx);

    await expect(caller.createS3PreSignedUrl({ pathname: VALID_KEY })).rejects.toThrow(
      'Upload path is already in use',
    );
    expect(s3Mock.createPreSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses keys outside the upload directories', async () => {
    const caller = uploadRouter.createCaller(mockCtx);

    for (const pathname of [
      'generations/482910/1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b.png',
      'files/482910/../other/1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b.png',
      '/files/482910/1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b.png',
      'files/482910/avatar.png',
    ]) {
      await expect(caller.createS3PreSignedUrl({ pathname })).rejects.toThrow(
        'Invalid upload path',
      );
    }
    expect(s3Mock.createPreSignedUrl).not.toHaveBeenCalled();
  });
});
