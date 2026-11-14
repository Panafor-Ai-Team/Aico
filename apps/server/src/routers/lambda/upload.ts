import { z } from 'zod';

import { withScopedPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { FileS3 } from '@/server/modules/S3';
import { assertSafeUploadKey, assertUploadKeyIsFree } from '@/server/services/file/uploadKeyPolicy';

export const uploadRouter = router({
  createS3PreSignedUrl: authedProcedure
    .use(withScopedPermission('file:upload'))
    .input(z.object({ pathname: z.string() }))
    .mutation(async ({ input }) => {
      assertSafeUploadKey(input.pathname);

      const s3 = new FileS3();
      await assertUploadKeyIsFree(s3, input.pathname);

      return await s3.createPreSignedUrl(input.pathname);
    }),
});

export type FileRouter = typeof uploadRouter;
