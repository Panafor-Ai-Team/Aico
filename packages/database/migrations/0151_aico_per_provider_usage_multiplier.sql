-- Per-provider usage multiplier.
--
-- `platform_usage_multiplier_config` was a singleton keyed `id = 'default'`.
-- The managed provider is now selectable (`AICO_MANAGED_PROVIDER`), and the two
-- gateways have different unit economics, so `id` becomes the provider key:
--   openrouter    12000 bp (1.20x) — unchanged, the rate in force today
--   cheapvibecode 12500 bp (1.25x) — CVC sells 25M tokens per USD, so a $1
--                                    top-up buys $0.80 raw = 20M tokens
--
-- The 'default' row is deliberately LEFT IN PLACE as the fallback for any
-- deployment whose BRANDING_PROVIDER has no row of its own.
--
-- The openrouter row is seeded from the live 'default' value rather than the
-- constant, so a platform admin who already tuned the rate keeps it.
INSERT INTO "platform_usage_multiplier_config" ("id", "multiplier_bp", "updated_by_user_id")
SELECT 'openrouter', "multiplier_bp", "updated_by_user_id"
FROM "platform_usage_multiplier_config"
WHERE "id" = 'default'
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- Covers a fresh database where the 'default' row does not exist yet.
INSERT INTO "platform_usage_multiplier_config" ("id", "multiplier_bp")
VALUES ('openrouter', 12000), ('cheapvibecode', 12500)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- NOTE: `member_budgets.checkpoint_multiplier_bp`, `user_wallets.raw_capacity_micro_usd`
-- and `usage_logs.multiplier_bp` are intentionally NOT touched. They record the
-- rate money was actually bought/billed at; re-deriving them here would reprice
-- funds already taken. A provider switch is handled lazily at the next
-- checkpoint sync, exactly like an admin rate change.
