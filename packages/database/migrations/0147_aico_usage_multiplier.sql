-- AICO-180 platform usage multiplier. Seeded to 12000 bp (1.20x).
CREATE TABLE IF NOT EXISTS "platform_usage_multiplier_config" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"multiplier_bp" bigint DEFAULT 12000 NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "platform_usage_multiplier_config" ADD CONSTRAINT "platform_usage_multiplier_config_updated_by_user_id_users_id_fk"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
INSERT INTO "platform_usage_multiplier_config" ("id", "multiplier_bp")
VALUES ('default', 12000)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- Usage-multiplier checkpoint. Existing rows start at baseline 0 with the
-- default multiplier, so already-recorded OpenRouter usage is billed at 1.20x
-- from the moment this ships. There is no pre-multiplier usage to preserve.
ALTER TABLE "user_wallets" ADD COLUMN IF NOT EXISTS "usage_baseline_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_wallets" ADD COLUMN IF NOT EXISTS "billed_usage_before_baseline_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_wallets" ADD COLUMN IF NOT EXISTS "checkpoint_multiplier_bp" bigint DEFAULT 12000 NOT NULL;--> statement-breakpoint
ALTER TABLE "member_budgets" ADD COLUMN IF NOT EXISTS "usage_baseline_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "member_budgets" ADD COLUMN IF NOT EXISTS "billed_usage_before_baseline_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "member_budgets" ADD COLUMN IF NOT EXISTS "checkpoint_multiplier_bp" bigint DEFAULT 12000 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN IF NOT EXISTS "multiplier_bp" bigint DEFAULT 12000 NOT NULL;
