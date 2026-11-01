-- Per-model coefficient overrides, editable from the platform admin panel.
--
-- Why a separate table rather than a column on `openrouter_model_catalog`:
-- `replaceCatalog` rewrites `pricing` and `payload` from `excluded.*` on every
-- sync, deletes rows for models that leave the upstream catalog, and truncates
-- the table outright on an empty snapshot. An override stored on the catalog row
-- would not survive a cron run.
--
-- Why overrides are needed at all: upstream-published coefficients are not always
-- what upstream actually charges. Measured against CheapVibeCode, deepseek-v4.1-flash
-- billed x0.433 against an advertised x0.3 and mimo-v2.5 x0.072 against x0.05,
-- while glm-5.3-flash matched exactly. Nothing in /v1/models predicts which.
--
-- Scope: an override moves the price shown in the model picker and the per-message
-- cost estimate. It does NOT move the wallet debit, which is derived from the
-- upstream key's balance delta and is aggregate, not per-model. The override
-- therefore makes what we display agree with what is actually charged.
CREATE TABLE IF NOT EXISTS "platform_model_multiplier_overrides" (
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	-- Effective coefficient in basis points (10000 = x1.00). Band 1000-100000.
	"multiplier_bp" bigint NOT NULL,
	-- Free-text reason, e.g. measured x0.433 vs published x0.3 on 2026-09-14.
	"note" text,
	-- A users.id. NOT a platform_admin_users.id: admin attribution lives in
	-- aico_security_events.actor_admin_id, which the edit procedures record.
	"updated_by_user_id" text,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "platform_model_multiplier_overrides_pk" PRIMARY KEY ("provider_id", "model_id")
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "platform_model_multiplier_overrides" ADD CONSTRAINT "platform_model_multiplier_overrides_updated_by_user_id_users_id_fk"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_model_multiplier_overrides_provider_idx"
  ON "platform_model_multiplier_overrides" ("provider_id");
