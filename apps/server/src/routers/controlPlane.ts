import { router } from '@/libs/trpc/lambda';

import { platformAdminRouter } from './lambda/platformAdmin';

/**
 * Control-plane-only tRPC surface (platform admin).
 *
 * Defined here, rather than beside its Hono handler in
 * `apps/aico-control-plane`, so the SPA client can import the router *type*
 * without reaching across app boundaries — `apps/aico-control-plane` is not in
 * the root tsconfig `include`, so a type imported from there is not checked.
 * This mirrors how `lambdaClient` imports `LambdaRouter` from `@/server/routers/lambda`.
 *
 * The client must use `typeof controlPlaneRouter`. A hand-written stand-in like
 * `{ platformAdmin: PlatformAdminRouter }` is not an `AnyTRPCRouter` — it has no
 * `_def` — so `createTRPCClient` silently produces a client with no typed
 * procedures, and every Platform Admin call goes unchecked.
 */
export const controlPlaneRouter = router({
  platformAdmin: platformAdminRouter,
});

export type ControlPlaneRouter = typeof controlPlaneRouter;
