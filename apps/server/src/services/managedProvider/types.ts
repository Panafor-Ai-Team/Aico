import type { ManagedProviderId } from '@lobechat/business-const';
import type { ChatModelCard } from '@lobechat/types';

/**
 * The provider-neutral seam between Aico's billing stack and whichever upstream
 * gateway is backing the managed experience (`AICO_MANAGED_PROVIDER`).
 *
 * Two things shape this interface, and both come from CheapVibeCode's API being
 * materially narrower than OpenRouter's:
 *
 * 1. **A key is addressed by credential, not by id.** OpenRouter reads a key's
 *    remaining allowance with `GET /keys/{hash}` using the *management* key.
 *    CVC has no such route — `GET /v1/balance` is scoped to whichever key
 *    authenticates the call, so reading a member's remaining allowance means
 *    holding that member's own key. Callers already store it
 *    (`openrouterKeyCiphertext`), so both implementations can be satisfied.
 *
 * 2. **Not every operation exists everywhere.** CVC can freeze, resize and
 *    delete a key (by its secret), but cannot reset a limit on a period boundary,
 *    and its resize is a read-then-delta rather than OpenRouter's absolute
 *    `PATCH` — so it gets its own `resizeKey` instead of `updateKey`. Rather than have the
 *    optional methods throw and make every call site defensive, capabilities are
 *    declared up front and the caller branches on them.
 *
 * Units are USD floats at this boundary, matching what `keyService` already
 * passes OpenRouter. Providers denominated in something else (CVC prices in its
 * own tokens) convert internally, so the ledger stays micro-USD end to end.
 */
export interface ManagedProviderCapabilities {
  /** `limit_reset: daily|weekly|monthly` is enforced upstream. When false, the
   *  period cap is ours to account via balance-delta checkpoints. */
  nativePeriodicLimits: boolean;
  /**
   * `getKey` needs the key's own plaintext secret, because per-key state is read
   * by authenticating *as* the key rather than by id.
   *
   * Callers gate the ciphertext decrypt on this: `getUserRemaining` runs on the
   * chat hot path, and decrypting on every request for a provider that does not
   * need it is pure cost.
   */
  readKeyBySecret: boolean;
  /** A key can be deleted or disabled upstream. When false, retiring a key means
   *  ceasing to use it — safe only because managed keys never reach the browser.
   *  With `readKeyBySecret`, both operations need the key's `apiKey` too. */
  revoke: boolean;
  /** An existing key's limit can be changed after creation. When false, the
   *  limit written at mint time is final for that key's lifetime. */
  updateLimit: boolean;
}

/** How a provider identifies one of our minted keys. */
export interface ManagedKeyCredential {
  /**
   * The key's plaintext secret. Required by providers that read per-key state by
   * authenticating as the key (CVC). Never logged, never returned to a client.
   */
  apiKey?: string;
  /** The provider's own id/hash for the key, as stored in `openrouter_key_id`. */
  hash: string;
  /**
   * The allowance this key was minted with, in USD.
   *
   * CVC's `GET /v1/balance` reports only what is *left*; there is no route that
   * reports what the key started with. Spend is therefore `limit - remaining`,
   * and the limit is something only we know — we wrote it at mint time. Pass it
   * so `getKey` can report `usage`; omit it and `usage` comes back `0` with
   * `limit: null`, because guessing it would silently under-report spend.
   *
   * Ignored by providers that report usage directly (OpenRouter).
   */
  limitUsd?: number;
}

export interface ManagedKeyInfo {
  disabled: boolean;
  hash: string;
  /** Total allowance in USD, as minted. `null` when the key is uncapped. */
  limit: number | null;
  /** Allowance left in USD. `null` when the provider cannot report it. */
  limitRemaining: number | null;
  name: string | null;
  /** Lifetime spend in USD. */
  usage: number;
  /**
   * Per-period spend in USD. Only populated by providers with
   * `nativePeriodicLimits`; `null` elsewhere, which is the signal for callers to
   * fall back to their own checkpoint arithmetic rather than silently treating
   * lifetime usage as this period's.
   */
  usageDaily: number | null;
  usageMonthly: number | null;
  usageWeekly: number | null;
}

export interface CreateManagedKeyResult extends ManagedKeyInfo {
  /** The plaintext secret. Returned exactly once, at creation. */
  key: string;
}

export type ManagedKeyLimitReset = 'daily' | 'weekly' | 'monthly' | null;

export interface CreateManagedKeyParams {
  /**
   * Model ids this key may call, enforced upstream where supported. Settable at
   * creation only on CVC, so it is defence in depth behind
   * `AicoManagedPolicy.assertModelAllowed`, never the primary gate.
   */
  allowedModels?: string[];
  limitReset?: ManagedKeyLimitReset;
  limitUsd: number;
  name: string;
}

export interface UpdateManagedKeyParams {
  /** The key's secret, for providers that address edits by it (CVC). */
  apiKey?: string;
  disabled?: boolean;
  hash: string;
  limitReset?: ManagedKeyLimitReset;
  limitUsd?: number;
  name?: string;
}

export interface ResizeManagedKeyParams {
  /** Desired freeze state, applied first; its answer is also the live read. */
  active: boolean;
  apiKey: string;
  hash: string;
  /** Absolute target limit on the key's own (continuous) counter, in USD. */
  limitUsd: number;
}

export interface ManagedProviderClient {
  capabilities: ManagedProviderCapabilities;
  createKey: (params: CreateManagedKeyParams) => Promise<CreateManagedKeyResult>;
  /** Present only when `capabilities.revoke`. */
  deleteKey?: (credential: ManagedKeyCredential) => Promise<void>;
  /** Account-level float in USD, for the master-balance monitor. */
  getAccountBalanceUsd: () => Promise<number>;
  getKey: (credential: ManagedKeyCredential) => Promise<ManagedKeyInfo>;
  /**
   * The provider's live catalog, already mapped to our card shape.
   *
   * Optional because a mock has no catalog to report, and because the caller
   * must be able to tell "this provider cannot list models" from "this provider
   * has no models": catalog sync treats the first as an error and leaves the
   * stored catalog alone, whereas an empty list would look like a successful
   * sync of nothing.
   */
  listModels?: () => Promise<ChatModelCard[]>;
  providerId: ManagedProviderId;
  /**
   * Resize a key in place against its *live* limit (CheapVibeCode). Never
   * computes a delta from a stored figure, so a repeat after an ambiguous
   * failure converges instead of adding twice. Returns the key as it now is.
   */
  resizeKey?: (params: ResizeManagedKeyParams) => Promise<ManagedKeyInfo>;
  /** Present only when `capabilities.updateLimit` (or `revoke`, for `disabled`). */
  updateKey?: (params: UpdateManagedKeyParams) => Promise<ManagedKeyInfo>;
}
