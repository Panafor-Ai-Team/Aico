/**
 * Which upstream gateway backs the managed (`BRANDING_PROVIDER`) experience.
 *
 * Read here rather than from `@lobechat/env` because `packages/database` needs
 * it to resolve the per-provider usage multiplier and cannot depend on the env
 * package. The env schema (`packages/env/src/aico.ts`) remains the documented
 * home of the variable; this is the same literal read, mirroring how
 * `BRANDING_PROVIDER` is handled in `./branding`.
 *
 * Deliberately has no `NEXT_PUBLIC_` twin: the value is only meaningful on the
 * server, where every managed-provider decision is made. In a browser bundle it
 * resolves to the default, which is correct because no client code should be
 * branching on it — use `BRANDING_PROVIDER` for anything user-visible.
 */
export const MANAGED_PROVIDER_IDS = ['openrouter', 'cheapvibecode'] as const;

export type ManagedProviderId = (typeof MANAGED_PROVIDER_IDS)[number];

export const DEFAULT_MANAGED_PROVIDER_ID: ManagedProviderId = 'openrouter';

const resolveManagedProvider = (value: string | undefined): ManagedProviderId => {
  const trimmed = value?.trim();
  return MANAGED_PROVIDER_IDS.includes(trimmed as ManagedProviderId)
    ? (trimmed as ManagedProviderId)
    : DEFAULT_MANAGED_PROVIDER_ID;
};

/**
 * The managed provider in force for this deployment.
 *
 * Exactly one is live at a time, and that is load-bearing:
 * `user_wallets.raw_capacity_micro_usd` is a single blended pool denominated in
 * the active provider's raw USD, bought at whatever multiplier was in force at
 * top-up time. Running two managed providers simultaneously would need wallet
 * capacity split per provider first.
 */
export const MANAGED_PROVIDER_ID = resolveManagedProvider(process.env.AICO_MANAGED_PROVIDER);
