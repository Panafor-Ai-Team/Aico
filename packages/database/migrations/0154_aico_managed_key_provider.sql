-- Which gateway minted the managed key this row holds.
--
-- Nothing else in the schema records it, and without it a provider cutover is
-- unsafe: `ensureUserKey` / `ensureMemberKey` see a non-empty
-- `openrouter_key_id` plus ciphertext, conclude the subject already has a live
-- key, and send an OpenRouter secret to CheapVibeCode (or the reverse). Every
-- request then fails on a credential the new gateway has never heard of, and the
-- failure looks like an outage rather than a misconfiguration.
--
-- With the stamp, a key minted by a gateway that is no longer active is treated
-- as absent: a replacement is minted, sized from the subject's *billed* balance
-- so no money is revalued, and the old key is deliberately LEFT ALIVE upstream.
-- That is what makes rollback an env change — flipping `AICO_MANAGED_PROVIDER`
-- back mints a correctly funded key on the original gateway rather than needing
-- a restore. (CheapVibeCode has no revoke endpoint anyway; retired keys are
-- recorded in `aico_key_outbox` instead.)
--
-- NULL means "minted before this column existed", which can only be OpenRouter:
-- it was the sole managed provider until this migration. Backfilled rather than
-- left null so the predicate has no special case, and defaulted for the same
-- reason on rows written by an older deployment mid-rollout.
ALTER TABLE "member_budgets"
  ADD COLUMN IF NOT EXISTS "managed_key_provider_id" text;--> statement-breakpoint
ALTER TABLE "user_wallets"
  ADD COLUMN IF NOT EXISTS "managed_key_provider_id" text;--> statement-breakpoint

UPDATE "member_budgets"
  SET "managed_key_provider_id" = 'openrouter'
  WHERE "managed_key_provider_id" IS NULL AND "openrouter_key_id" IS NOT NULL;--> statement-breakpoint

UPDATE "user_wallets"
  SET "managed_key_provider_id" = 'openrouter'
  WHERE "managed_key_provider_id" IS NULL AND "openrouter_key_id" IS NOT NULL;
