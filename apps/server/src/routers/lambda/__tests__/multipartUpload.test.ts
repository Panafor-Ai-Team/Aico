// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileS3 } from '@/server/modules/S3';

import { multipartUploadRouter } from '../multipartUpload';

vi.mock('@/server/modules/S3', () => ({ FileS3: vi.fn() }));

const VALID_KEY = 'files/482910/1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b.bin';

describe('multipartUploadRouter', () => {
  const mockCtx: any = { userId: 'user_test' };
  let s3Mock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    s3Mock = {
      abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
      completeMultipartUpload: vi.fn().mockResolvedValue(undefined),
      createMultipartUpload: vi.fn().mockResolvedValue('test-upload-id'),
      createPartUploadUrl: vi.fn().mockResolvedValue('https://example.com/part-1'),
      // HEAD on a fresh key fails: no object there yet.
      getFileMetadata: vi.fn().mockRejectedValue(new Error('NotFound')),
    };
    vi.mocked(FileS3).mockImplementation(() => s3Mock);
  });

  it('initiateMultipartUpload creates an S3 session and returns uploadId + key', async () => {
    const caller = multipartUploadRouter.createCaller(mockCtx);

    const result = await caller.initiateMultipartUpload({
      pathname: VALID_KEY,
      totalSize: 500 * 1024 * 1024,
    });

    expect(s3Mock.createMultipartUpload).toHaveBeenCalledWith(VALID_KEY, undefined);
    expect(result).toEqual({ key: VALID_KEY, uploadId: 'test-upload-id' });
  });

  it('initiateMultipartUpload rejects files over 1GB', async () => {
    const caller = multipartUploadRouter.createCaller(mockCtx);

    await expect(
      caller.initiateMultipartUpload({
        pathname: VALID_KEY,
        totalSize: 2 * 1024 * 1024 * 1024,
      }),
    ).rejects.toThrow();
    expect(s3Mock.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('getPartUploadUrl returns a signed URL for a 1-indexed part', async () => {
    const caller = multipartUploadRouter.createCaller(mockCtx);

    const result = await caller.getPartUploadUrl({
      key: VALID_KEY,
      partNumber: 3,
      uploadId: 'test-upload-id',
    });

    expect(s3Mock.createPartUploadUrl).toHaveBeenCalledWith(VALID_KEY, 'test-upload-id', 3);
    expect(result).toEqual({ url: 'https://example.com/part-1' });
  });

  it('getPartUploadUrl rejects partNumber 0 (S3 parts are 1-indexed)', async () => {
    const caller = multipartUploadRouter.createCaller(mockCtx);

    await expect(
      caller.getPartUploadUrl({ key: 'k', partNumber: 0, uploadId: 'u' }),
    ).rejects.toThrow();
  });

  it('completeMultipartUpload assembles parts and returns success', async () => {
    const caller = multipartUploadRouter.createCaller(mockCtx);
    const parts = [
      { ETag: '"etag-1"', PartNumber: 1 },
      { ETag: '"etag-2"', PartNumber: 2 },
    ];

    const result = await caller.completeMultipartUpload({
      key: VALID_KEY,
      parts,
      uploadId: 'test-upload-id',
    });

    expect(s3Mock.completeMultipartUpload).toHaveBeenCalledWith(VALID_KEY, 'test-upload-id', parts);
    expect(result).toEqual({ success: true });
  });

  it('abortMultipartUpload cleans up the S3 session and returns success', async () => {
    const caller = multipartUploadRouter.createCaller(mockCtx);

    const result = await caller.abortMultipartUpload({
      key: VALID_KEY,
      uploadId: 'test-upload-id',
    });

    expect(s3Mock.abortMultipartUpload).toHaveBeenCalledWith(VALID_KEY, 'test-upload-id');
    expect(result).toEqual({ success: true });
  });

  it('initiateMultipartUpload refuses a key outside the upload shape', async () => {
    const caller = multipartUploadRouter.createCaller(mockCtx);

    for (const pathname of [
      'generations/2026/abc.png',
      'files/../secrets/1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b.bin',
      'files/482910/not-a-uuid.bin',
    ]) {
      await expect(
        caller.initiateMultipartUpload({ pathname, totalSize: 10 * 1024 * 1024 }),
      ).rejects.toThrow('Invalid upload path');
    }
    expect(s3Mock.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('initiateMultipartUpload refuses to overwrite an existing object', async () => {
    s3Mock.getFileMetadata.mockResolvedValue({ contentLength: 10 });
    const caller = multipartUploadRouter.createCaller(mockCtx);

    await expect(
      caller.initiateMultipartUpload({ pathname: VALID_KEY, totalSize: 10 * 1024 * 1024 }),
    ).rejects.toThrow('Upload path is already in use');
    expect(s3Mock.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('part, complete and abort refuse keys outside the upload shape', async () => {
    const caller = multipartUploadRouter.createCaller(mockCtx);
    const key = 'generations/2026/abc.png';

    await expect(caller.getPartUploadUrl({ key, partNumber: 1, uploadId: 'u' })).rejects.toThrow(
      'Invalid upload path',
    );
    await expect(
      caller.completeMultipartUpload({
        key,
        parts: [{ ETag: '"e"', PartNumber: 1 }],
        uploadId: 'u',
      }),
    ).rejects.toThrow('Invalid upload path');
    await expect(caller.abortMultipartUpload({ key, uploadId: 'u' })).rejects.toThrow(
      'Invalid upload path',
    );
  });
});
