import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      /**
       * When `1`, Trial may be enabled via platform_trial_config in non-production.
       * Production always rejects Trial activation/execution until atomic quota ships.
       */
      AICO_ALLOW_TRIAL?: string;
      /**
       * Usage ledger mode for managed traffic: `off` (default, legacy per-key
       * brakes only), `shadow` (records holds and what enforce would refuse, never
       * blocks) or `enforce` (every managed call reserves a hold in our database
       * before it reaches the upstream and settles when it ends). Enforce refuses
       * traffic until the cutover snapshot has completed.
       */
      AICO_BILLING_LEDGER_MODE?: string;
      /**
       * Shared bearer token for product → control-plane `/internal/*` calls.
       * Must match the control plane's `AICO_CONTROL_PLANE_SERVICE_TOKEN`.
       */
      AICO_CONTROL_PLANE_SERVICE_TOKEN?: string;
      /**
       * Base URL of the Aico control plane (no trailing slash), e.g. `http://localhost:3020`.
       * Product server uses this for OpenRouter management proxy calls.
       */
      AICO_CONTROL_PLANE_URL?: string;
      /**
       * CheapVibeCode tokens per 1 USD of raw upstream capacity. CVC prices in its
       * own tokens and publishes no USD rate, so this is the only bridge between
       * their unit and our micro-USD ledger. Default 25,000,000 (the rate we buy
       * at). Changing it re-denominates every CVC key limit written after the
       * change; it does NOT revalue limits already pushed upstream.
       */
      AICO_CVC_TOKENS_PER_USD?: string;
      /**
       * When `1`, this process is the control plane (may hold `OPENROUTER_MANAGEMENT_API_KEY`).
       * Product servers must leave this unset.
       */
      AICO_IS_CONTROL_PLANE?: string;
      /**
       * Shared-key mode only. Managed traffic is refused once the upstream account
       * float, net of ledger spend since the last reading and open holds, would
       * drop below this many raw micro-USD. Default 1,000,000 ($1).
       */
      AICO_LEDGER_FLOAT_FLOOR_MICRO_USD?: string;
      /**
       * Seconds after which a float reading is considered stale and alerts.
       * A stale reading never blocks traffic on its own. Default 600.
       */
      AICO_LEDGER_FLOAT_MAX_AGE_SECONDS?: string;
      /**
       * Seconds an unsettled hold stays open before maintenance charges it in
       * full. Must outlive the longest stream (route maxDuration is 300s).
       * Default 900.
       */
      AICO_LEDGER_HOLD_TTL_SECONDS?: string;
      /** Maximum concurrent open holds per wallet or member budget. Default 6. */
      AICO_LEDGER_MAX_OPEN_HOLDS?: string;
      /**
       * Output cap injected as `max_tokens` on managed chat requests that did not
       * ask for one. It bounds the hold, so it bounds what a request can cost.
       * Default 32,000.
       */
      AICO_MANAGED_DEFAULT_MAX_OUTPUT_TOKENS?: string;
      /**
       * `per_subject` (default): every wallet/budget has its own upstream key.
       * `shared`: all managed traffic uses `AICO_SHARED_INFERENCE_API_KEY` and the
       * usage ledger is the only brake. Shared requires
       * `AICO_BILLING_LEDGER_MODE=enforce`; any other combination refuses traffic.
       */
      AICO_MANAGED_INFERENCE_KEY?: string;
      /**
       * Which upstream gateway backs the managed (`BRANDING_PROVIDER`) experience:
       * `openrouter` (default) or `cheapvibecode`. This is the rollback lever — both
       * implementations stay live and switching is an env change, not a restore.
       *
       * Exactly ONE managed provider is live per deployment, and that is load-bearing:
       * `user_wallets.raw_capacity_micro_usd` is a single blended pool denominated in
       * the active provider's raw USD, bought at whatever multiplier was in force at
       * top-up time. Never run two managed providers at once without first splitting
       * wallet capacity per provider.
       */
      AICO_MANAGED_PROVIDER?: string;
      /**
       * When `1`, managed-provider calls are mocked in-process (local QA).
       * Ignored in production — see `createOpenRouterManagementClient`.
       */
      AICO_OPENROUTER_MOCK?: string;
      /**
       * Optional HTTPS webhook for Aico security ops alerts (MON-003).
       * Receives JSON: { type, severity, summary, details, timestamp }.
       */
      AICO_SECURITY_ALERT_WEBHOOK_URL?: string;
      /**
       * CheapVibeCode primary key used as the single inference key when
       * `AICO_MANAGED_INFERENCE_KEY=shared`. It has no upstream limit: the usage
       * ledger is the only brake. Never log it. Accepted risk (2026-09-16).
       */
      AICO_SHARED_INFERENCE_API_KEY?: string;
      /**
       * Toman per 1 USD — fallback FX rate when platform_fx_config is unavailable.
       * Example: 187400 means 187,400 toman = $1. Prefer setting the rate in the
       * platform admin panel (platform_fx_config).
       */
      AICO_TOMAN_PER_USD?: string;
      /**
       * CheapVibeCode API origin, no trailing slash. Their docs describe a
       * Primary/Fallback domain switch as the remedy for an outage, so this is a
       * comma-separated list tried in order.
       */
      CHEAPVIBECODE_BASE_URL?: string;
      /**
       * CheapVibeCode primary key (sk-cvc-…). Unlike OpenRouter's, this single
       * credential is BOTH the management API key and a fully funded inference
       * key — a leak spends the account float directly, it does not merely mint
       * keys. Control plane only; product servers must NOT set this.
       */
      CHEAPVIBECODE_MANAGEMENT_API_KEY?: string;
      /**
       * OpenRouter Management API key (sk-or-…). Creates per-user keys.
       * Never expose to the client. Product servers must NOT set this — only the control plane.
       */
      OPENROUTER_MANAGEMENT_API_KEY?: string;
    }
  }
}

export const getAicoConfig = () => {
  return createEnv({
    server: {
      AICO_ALLOW_TRIAL: z.boolean().optional().default(false),
      AICO_BILLING_LEDGER_MODE: z.enum(['off', 'shadow', 'enforce']).default('off'),
      AICO_CONTROL_PLANE_SERVICE_TOKEN: z.string().optional(),
      AICO_CONTROL_PLANE_URL: z.string().url().optional(),
      AICO_IS_CONTROL_PLANE: z.boolean().optional().default(false),
      AICO_LEDGER_FLOAT_FLOOR_MICRO_USD: z.coerce.number().int().nonnegative().default(1_000_000),
      AICO_LEDGER_FLOAT_MAX_AGE_SECONDS: z.coerce.number().int().min(60).default(600),
      AICO_LEDGER_HOLD_TTL_SECONDS: z.coerce.number().int().min(360).max(3600).default(900),
      AICO_LEDGER_MAX_OPEN_HOLDS: z.coerce.number().int().min(1).max(64).default(6),
      AICO_MANAGED_DEFAULT_MAX_OUTPUT_TOKENS: z.coerce
        .number()
        .int()
        .min(256)
        .max(200_000)
        .default(32_000),
      AICO_MANAGED_INFERENCE_KEY: z.enum(['per_subject', 'shared']).default('per_subject'),
      AICO_MANAGED_PROVIDER: z.enum(['openrouter', 'cheapvibecode']).default('openrouter'),
      AICO_SHARED_INFERENCE_API_KEY: z.string().optional(),
      AICO_CVC_TOKENS_PER_USD: z.coerce.number().positive().int().default(25_000_000),
      AICO_OPENROUTER_MOCK: z.boolean().optional().default(false),
      CHEAPVIBECODE_BASE_URL: z.string().default('https://cheapvibecode.ru'),
      CHEAPVIBECODE_MANAGEMENT_API_KEY: z.string().optional(),
      AICO_SECURITY_ALERT_WEBHOOK_URL: z.string().url().optional(),
      AICO_TOMAN_PER_USD: z.coerce.number().positive().int().default(187_400),
      OPENROUTER_MANAGEMENT_API_KEY: z.string().optional(),
    },
    runtimeEnv: {
      AICO_ALLOW_TRIAL: process.env.AICO_ALLOW_TRIAL === '1',
      AICO_BILLING_LEDGER_MODE: process.env.AICO_BILLING_LEDGER_MODE || 'off',
      AICO_CONTROL_PLANE_SERVICE_TOKEN: process.env.AICO_CONTROL_PLANE_SERVICE_TOKEN,
      AICO_CONTROL_PLANE_URL: process.env.AICO_CONTROL_PLANE_URL,
      AICO_IS_CONTROL_PLANE: process.env.AICO_IS_CONTROL_PLANE === '1',
      // `|| undefined`: an empty value falls back to the default instead of coercing to 0.
      AICO_LEDGER_FLOAT_FLOOR_MICRO_USD: process.env.AICO_LEDGER_FLOAT_FLOOR_MICRO_USD || undefined,
      AICO_LEDGER_FLOAT_MAX_AGE_SECONDS: process.env.AICO_LEDGER_FLOAT_MAX_AGE_SECONDS || undefined,
      AICO_LEDGER_HOLD_TTL_SECONDS: process.env.AICO_LEDGER_HOLD_TTL_SECONDS || undefined,
      AICO_LEDGER_MAX_OPEN_HOLDS: process.env.AICO_LEDGER_MAX_OPEN_HOLDS || undefined,
      AICO_MANAGED_DEFAULT_MAX_OUTPUT_TOKENS:
        process.env.AICO_MANAGED_DEFAULT_MAX_OUTPUT_TOKENS || undefined,
      AICO_MANAGED_INFERENCE_KEY: process.env.AICO_MANAGED_INFERENCE_KEY || 'per_subject',
      AICO_MANAGED_PROVIDER: process.env.AICO_MANAGED_PROVIDER || 'openrouter',
      AICO_SHARED_INFERENCE_API_KEY: process.env.AICO_SHARED_INFERENCE_API_KEY || undefined,
      AICO_CVC_TOKENS_PER_USD: process.env.AICO_CVC_TOKENS_PER_USD,
      AICO_OPENROUTER_MOCK: process.env.AICO_OPENROUTER_MOCK === '1',
      CHEAPVIBECODE_BASE_URL: process.env.CHEAPVIBECODE_BASE_URL || 'https://cheapvibecode.ru',
      CHEAPVIBECODE_MANAGEMENT_API_KEY: process.env.CHEAPVIBECODE_MANAGEMENT_API_KEY,
      AICO_SECURITY_ALERT_WEBHOOK_URL: process.env.AICO_SECURITY_ALERT_WEBHOOK_URL || undefined,
      AICO_TOMAN_PER_USD: process.env.AICO_TOMAN_PER_USD,
      OPENROUTER_MANAGEMENT_API_KEY: process.env.OPENROUTER_MANAGEMENT_API_KEY,
    },
  });
};

export const aicoEnv = getAicoConfig();

/** @deprecated Prefer `tomanToMicroUsd` from `@/database/utils/aicoMoney`. Kept for transitional call sites. */
export const tomanToUsd = (amountToman: number, rate = aicoEnv.AICO_TOMAN_PER_USD): number => {
  if (!Number.isFinite(amountToman) || amountToman <= 0) throw new Error('Invalid FX amount');
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isInteger(rate))
    throw new Error('Invalid FX rate');
  // Integer floor via micro-USD then back to 6-decimal number for legacy callers.
  const micro = (BigInt(Math.trunc(amountToman)) * 1_000_000n) / BigInt(rate);
  return Number(micro) / 1_000_000;
};
