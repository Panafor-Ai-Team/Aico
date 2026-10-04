-- One managed key per member budget.
--
-- Renewal refunds each budget from its key's remaining allowance. Two budgets
-- pointing at one key refund the same money twice, which is how an org wallet
-- got credited more than it ever funded. Keyless budgets (NULL) are unaffected.
--
-- Fails if duplicates already exist; clear them before deploying.
CREATE UNIQUE INDEX IF NOT EXISTS "member_budgets_openrouter_key_id_uidx" ON "member_budgets" USING btree ("openrouter_key_id") WHERE "member_budgets"."openrouter_key_id" IS NOT NULL;
