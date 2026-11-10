-- FIN-018: `getUserRemaining` swallowed every OpenRouter failure and returned
-- the full deposited balance with no log, which is indistinguishable from
-- "you have spent nothing". The org path already persists its derived figure
-- and a sync status; the personal wallet had neither, so a degraded read had
-- nothing to fall back to and nothing to report.
ALTER TABLE "user_wallets" ADD COLUMN IF NOT EXISTS "settled_usage_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_wallets" ADD COLUMN IF NOT EXISTS "last_sync_status" text DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_wallets" ADD COLUMN IF NOT EXISTS "last_sync_error" text;
