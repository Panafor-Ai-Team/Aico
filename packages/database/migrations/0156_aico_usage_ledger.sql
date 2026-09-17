-- Hold-and-settle usage ledger for managed traffic.
--
-- CheapVibeCode caps how many keys an account may ever mint, and its keys are
-- immutable, so every top-up burns a key slot. The ledger lets all managed
-- traffic share one upstream key while every cent is enforced here instead:
-- a request reserves a hold with one conditional UPDATE before it reaches the
-- upstream and settles against actual token usage when it ends.
--
-- Purely additive. Every new column defaults to 0 and nothing reads it while
-- `AICO_BILLING_LEDGER_MODE=off`, so this migration changes no behaviour and
-- no paid balance.
--
-- Wallets are gated in RAW micro-USD (`raw_capacity - raw_used - raw_held`), the
-- unit a top-up bought, so a later multiplier change never revalues money
-- already paid. Budgets are gated in BILLED micro-USD, like the rest of the
-- budget columns.
ALTER TABLE "user_wallets" ADD COLUMN IF NOT EXISTS "raw_used_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_wallets" ADD COLUMN IF NOT EXISTS "raw_held_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_wallets" ADD COLUMN IF NOT EXISTS "open_holds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "member_budgets" ADD COLUMN IF NOT EXISTS "held_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "member_budgets" ADD COLUMN IF NOT EXISTS "open_holds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Bumped only where renewal resets `settled_usage_micro_usd`, so a hold opened
-- in one cycle never adds its charge to the next.
ALTER TABLE "member_budgets" ADD COLUMN IF NOT EXISTS "ledger_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "usage_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"subject_type" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text,
	"org_member_id" text,
	"budget_id" text,
	"budget_epoch" integer,
	"billing_source" text NOT NULL,
	"operation" text NOT NULL,
	"model_id" text NOT NULL,
	"priced_model_id" text,
	"resolved_model_id" text,
	"unit" text NOT NULL,
	"multiplier_bp" integer NOT NULL,
	"model_multiplier_bp" integer DEFAULT 10000 NOT NULL,
	"est_input_tokens" integer DEFAULT 0 NOT NULL,
	"max_output_tokens" integer DEFAULT 0 NOT NULL,
	"hold_raw_micro_usd" bigint DEFAULT 0 NOT NULL,
	"hold_micro_usd" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"settle_reason" text,
	"would_refuse" boolean DEFAULT false NOT NULL,
	"refuse_reason" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"reasoning_tokens" integer,
	"total_tokens" integer,
	"raw_cost_micro_usd" bigint,
	"charged_raw_micro_usd" bigint,
	"charged_micro_usd" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "usage_holds" ADD CONSTRAINT "usage_holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "usage_holds" ADD CONSTRAINT "usage_holds_org_member_id_organization_members_id_fk" FOREIGN KEY ("org_member_id") REFERENCES "public"."organization_members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "usage_holds_status_expires_at_idx" ON "usage_holds" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_holds_user_id_status_idx" ON "usage_holds" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_holds_org_member_id_status_idx" ON "usage_holds" USING btree ("org_member_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_holds_budget_id_status_idx" ON "usage_holds" USING btree ("budget_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_holds_settled_at_idx" ON "usage_holds" USING btree ("settled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_holds_created_at_idx" ON "usage_holds" USING btree ("created_at");--> statement-breakpoint

-- One `usage_logs` row per settled hold, however many times settle is retried.
ALTER TABLE "usage_logs" ADD COLUMN IF NOT EXISTS "hold_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_logs_hold_id_unique" ON "usage_logs" USING btree ("hold_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "aico_ledger_state" (
	"id" text PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"enforce_started_at" timestamp with time zone,
	"snapshot_completed_at" timestamp with time zone,
	"snapshot_wallets_cursor" text,
	"snapshot_wallets_done_at" timestamp with time zone,
	"snapshot_budgets_cursor" text,
	"snapshot_budgets_done_at" timestamp with time zone,
	"float_raw_micro_usd" bigint,
	"float_read_at" timestamp with time zone,
	"float_refresh_claimed_at" timestamp with time zone,
	"reconcile_float_raw_micro_usd" bigint,
	"reconcile_read_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

INSERT INTO "aico_ledger_state" ("id") VALUES ('default') ON CONFLICT ("id") DO NOTHING;
