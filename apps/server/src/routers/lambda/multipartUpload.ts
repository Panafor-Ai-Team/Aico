import { z } from 'zod';

import { withScopedPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { FileS3 } from '@/server/modules/S3';

const MAX_MULTIPART_SIZE = 1024 * 1024 * 1024; // 1GB

const partSchema = z.object({
  ETag: z.string().min(1),
  PartNumber: z.number().int().min(1).max(10_000),
});

export const multipartUploadRouter = router({
  initiateMultipartUpload: authedProcedure
    .use(withScopedPermission('file:upload'))
    .input(
      z.object({
        contentType: z.string().optional(),
        pathname: z.string().min(1),
        totalSize: z.number().int().positive().max(MAX_MULTIPART_SIZE),
      }),
    )
    .mutation(async ({ input }) => {
      const s3 = new FileS3();
      const uploadId = await s3.createMultipartUpload(input.pathname, input.contentType);
      return { key: input.pathname, uploadId };
    }),

  getPartUploadUrl: authedProcedure
    .use(withScopedPermission('file:upload'))
    .input(
      z.object({
        key: z.string().min(1),
        partNumber: z.number().int().min(1).max(10_000),
        uploadId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const s3 = new FileS3();
      const url = await s3.createPartUploadUrl(input.key, input.uploadId, input.partNumber);
      return { url };
    }),

  completeMultipartUpload: authedProcedure
    .use(withScopedPermission('file:upload'))
    .input(
      z.object({
        key: z.string().min(1),
        parts: z.array(partSchema).min(1).max(10_000),
        uploadId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const s3 = new FileS3();
      await s3.completeMultipartUpload(input.key, input.uploadId, input.parts);
      return { success: true };
    }),

  abortMultipartUpload: authedProcedure
    .use(withScopedPermission('file:upload'))
    .input(z.object({ key: z.string().min(1), uploadId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const s3 = new FileS3();
      await s3.abortMultipartUpload(input.key, input.uploadId);
      return { success: true };
    }),
});

export type MultipartUploadRouter = typeof multipartUploadRouter;
