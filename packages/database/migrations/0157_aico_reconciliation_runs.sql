-- Books-balance checks for the admin panel.
--
-- Each row is one reconciliation pass (cron every 15 minutes, or an admin's
-- "Run now"): every wallet's ledger chain, the CVC float against what keys
-- promise, stored key limits against the live ones, and key hygiene. Results
-- only — ids and amounts, never a key secret.
--
-- Purely additive: nothing in the billing path reads this table.
CREATE TABLE IF NOT EXISTS "aico_reconciliation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"triggered_by_admin_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "aico_reconciliation_runs" ADD CONSTRAINT "aico_reconciliation_runs_triggered_by_admin_id_fk" FOREIGN KEY ("triggered_by_admin_id") REFERENCES "public"."platform_admin_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aico_reconciliation_runs_started_at_idx" ON "aico_reconciliation_runs" USING btree ("started_at");
