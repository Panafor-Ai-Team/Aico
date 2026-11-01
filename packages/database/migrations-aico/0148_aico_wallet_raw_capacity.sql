-- AICO-184: a top-up buys raw upstream spend at the multiplier in force when it
-- was paid. `raw_capacity_micro_usd` is the raw counterpart of the wallet's
-- cumulative `balance_micro_usd`, so no later multiplier change can revalue
-- money already paid.
ALTER TABLE "user_wallets" ADD COLUMN IF NOT EXISTS "raw_capacity_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Backfill from the AICO-180 checkpoint using each wallet's own rate, which is
-- exactly the key limit that wallet is enforcing right now:
--   keyLimit = baseline + (balance - billedBefore) / M_checkpoint
-- so nobody's spendable capacity moves at deploy time. floor() matches
-- `removeMultiplierMicroUsd` — never hand out more headroom than was paid for.
UPDATE "user_wallets"
SET "raw_capacity_micro_usd" = "usage_baseline_micro_usd" + floor(
  GREATEST(0, "balance_micro_usd" - "billed_usage_before_baseline_micro_usd")::numeric
    * 10000 / GREATEST(1, "checkpoint_multiplier_bp")
)
WHERE "balance_micro_usd" > 0;--> statement-breakpoint

-- The per-wallet checkpoint is subsumed: capacity is fixed at payment time, so
-- there is no rate left to rebase. `member_budgets` are allowances rather than
-- payments and keep theirs.
ALTER TABLE "user_wallets" DROP COLUMN IF EXISTS "usage_baseline_micro_usd";--> statement-breakpoint
ALTER TABLE "user_wallets" DROP COLUMN IF EXISTS "billed_usage_before_baseline_micro_usd";--> statement-breakpoint
ALTER TABLE "user_wallets" DROP COLUMN IF EXISTS "checkpoint_multiplier_bp";
