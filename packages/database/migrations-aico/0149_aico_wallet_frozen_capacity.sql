-- FIN-015: a freeze zeroed `balance_micro_usd` but left `raw_capacity_micro_usd`
-- in place. That column is pushed to OpenRouter as the key limit, so the next
-- credit re-enabled the wallet carrying the pre-freeze capacity on top of the
-- newly purchased one — spend the user never paid for. Capacity now moves out
-- alongside the balance and is restored by an explicit unfreeze.
ALTER TABLE "user_wallets" ADD COLUMN IF NOT EXISTS "frozen_raw_capacity_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Repair wallets already frozen under the old behaviour: park their capacity
-- with the balance it belongs to, so it is restored on unfreeze rather than
-- handed out by the next credit.
UPDATE "user_wallets"
SET "frozen_raw_capacity_micro_usd" = "raw_capacity_micro_usd",
    "raw_capacity_micro_usd" = 0
WHERE "frozen_micro_usd" > 0 AND "balance_micro_usd" = 0;
