-- The mint-time limit of a managed key, recorded because some providers report
-- only what is LEFT on a key, never what was spent.
--
-- OpenRouter returns `usage` and `limit` on `GET /key/{hash}`, so nothing here
-- is needed for it and nothing here is written on that path. CheapVibeCode's
-- `GET /v1/balance` returns the calling key's remaining allowance and nothing
-- else, so spend is `limit - remaining` — and the limit is known only to us,
-- because it is what we asked for at mint and there is no endpoint to read it
-- back (`GET /v1/keys` is 405, `/v1/keys/{id}` is 404).
--
-- Denominated in RAW micro-USD, i.e. the same units as
-- `member_budgets.usage_baseline_micro_usd` and `user_wallets.raw_capacity_micro_usd`,
-- NOT billed micro-USD. Storing a billed figure here would silently apply the
-- markup twice.
--
-- NULL means "no managed key has been minted, or it was minted by a provider
-- that reports usage directly". Readers must treat NULL as unknown, never as
-- zero: a zero limit would read as a fully spent key.
ALTER TABLE "member_budgets"
  ADD COLUMN IF NOT EXISTS "managed_key_limit_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "user_wallets"
  ADD COLUMN IF NOT EXISTS "managed_key_limit_micro_usd" bigint;
--> statement-breakpoint
-- Raw spend that happened on keys this wallet has already retired.
--
-- A member budget carries the same fact in its checkpoint
-- (`billed_usage_before_baseline_micro_usd` with a zeroed baseline), but a
-- personal wallet has no checkpoint: `billedUsageFromCapacity` bills the ratio
-- of raw usage to raw capacity directly. When a key is replaced — which an
-- immutable-limit provider forces on every top-up — the new key's counter starts
-- at zero, so without this the wallet would forget everything spent on the old
-- key and re-grant it.
--
-- Total raw spend is therefore `raw_usage_before_key_micro_usd +
-- (managed_key_limit_micro_usd - remaining)`. Zero is correct here, unlike the
-- limit above: a wallet that has never rotated a key has genuinely spent nothing
-- on a previous one.
ALTER TABLE "user_wallets"
  ADD COLUMN IF NOT EXISTS "raw_usage_before_key_micro_usd" bigint DEFAULT 0 NOT NULL;
