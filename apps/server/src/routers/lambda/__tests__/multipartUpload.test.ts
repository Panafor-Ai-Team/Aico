// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileS3 } from '@/server/modules/S3';

import { multipartUploadRouter } from '../multipartUpload';

vi.mock('@/server/modules/S3', () => ({ FileS3: vi.fn() }));

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
    };
    vi.mocked(FileS3).mockImplementation(() => s3Mock);
  });

  it('initiateMultipartUpload creates an S3 session and returns uploadId + key', async () => {
    const caller = multipartUploadRouter.createCaller(mockCtx);

    const result = await caller.initiateMultipartUpload({
      pathname: 'files/1/mock-uuid.bin',
      totalSize: 500 * 1024 * 1024,
    });

    expect(s3Mock.createMultipartUpload).toHaveBeenCalledWith('files/1/mock-uuid.bin', undefined);
    expect(result).toEqual({ key: 'files/1/mock-uuid.bin', uploadId: 'test-upload-id' });
  });

  it('initiateMultipartUpload rejects files over 1GB', async () => {
    const caller = multipartUploadRouter.createCaller(mockCtx);

    await expect(
      caller.initiateMultipartUpload({
        pathname: 'files/1/mock-uuid.bin',
        totalSize: 2 * 1024 * 1024 * 1024,
      }),
    ).rejects.toThrow();
    expect(s3Mock.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('getPartUploadUrl returns a signed URL for a 1-indexed part', async () => {
    const caller = multipartUploadRouter.createCaller(mockCtx);

    const result = await caller.getPartUploadUrl({
      key: 'files/1/mock-uuid.bin',
      partNumber: 3,
      uploadId: 'test-upload-id',
    });

    expect(s3Mock.createPartUploadUrl).toHaveBeenCalledWith(
      'files/1/mock-uuid.bin',
      'test-upload-id',
      3,
    );
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
      key: 'files/1/mock-uuid.bin',
      parts,
      uploadId: 'test-upload-id',
    });

    expect(s3Mock.completeMultipartUpload).toHaveBeenCalledWith(
      'files/1/mock-uuid.bin',
      'test-upload-id',
      parts,
    );
    expect(result).toEqual({ success: true });
  });

  it('abortMultipartUpload cleans up the S3 session and returns success', async () => {
    const caller = multipartUploadRouter.createCaller(mockCtx);

    const result = await caller.abortMultipartUpload({
      key: 'files/1/mock-uuid.bin',
      uploadId: 'test-upload-id',
    });

    expect(s3Mock.abortMultipartUpload).toHaveBeenCalledWith(
      'files/1/mock-uuid.bin',
      'test-upload-id',
    );
    expect(result).toEqual({ success: true });
  });
});
