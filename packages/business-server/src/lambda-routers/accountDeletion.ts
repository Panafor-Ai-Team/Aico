import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import { UserModel } from '@/database/models/user';
import { users } from '@/database/schemas';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

/**
 * Account deletion with Aico trial-abuse blocklist write-before-delete.
 */
export const accountDeletionRouter = router({
  requestDeletion: authedProcedure
    .use(serverDatabase)
    .input(z.object({ confirmEmail: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.serverDB.query.users.findFirst({
        where: eq(users.id, ctx.userId),
      });
      if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });

      // Deletion is irreversible and writes an abuse-blocklist row, so the confirmation is
      // mandatory: normalise both sides, and treat a user without a stored email as a mismatch.
      const storedEmail = user.email?.trim().toLowerCase();
      if (!storedEmail || input.confirmEmail.trim().toLowerCase() !== storedEmail) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'EMAIL_MISMATCH' });
      }

      const billing = new AicoBillingModel(ctx.serverDB);
      await billing.addAbuseBlocklist({
        email: user.email,
        phone: user.phone,
        reason: 'account_deletion',
      });

      await UserModel.deleteUser(ctx.serverDB, ctx.userId);

      return { ok: true as const };
    }),
});
