-- Create the foreign keys `aicoOrganization.ts` has always declared but no
-- migration ever created, and give the reconciliation-runs FK the name the
-- schema generates. Without this, a database built from migrations and one
-- built from the schema differ, and drizzle-kit keeps proposing these FKs.
--
-- Every FK here is ON DELETE SET NULL, so a reference to a row that no longer
-- exists is cleared the same way: it is set to NULL. The original id is kept
-- on the row (`payload` / `metadata`, key `aicoOrphanedRefs`) so audit history
-- is not lost; amounts and every other column are untouched. A NOTICE reports
-- how many rows were cleared.
--
-- Idempotent: each block does nothing once its constraint exists.

DO $$
DECLARE cleared bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.aico_key_outbox'::regclass
      AND conname = 'aico_key_outbox_user_id_users_id_fk'
  ) THEN
    UPDATE "aico_key_outbox" AS o
    SET "payload" = coalesce(o."payload", '{}'::jsonb)
          || jsonb_build_object('aicoOrphanedRefs',
               coalesce(o."payload" -> 'aicoOrphanedRefs', '{}'::jsonb)
               || jsonb_build_object('userId', o."user_id")),
        "user_id" = NULL
    WHERE o."user_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "users" AS u WHERE u."id" = o."user_id");
    GET DIAGNOSTICS cleared = ROW_COUNT;
    IF cleared > 0 THEN
      RAISE NOTICE 'aico_key_outbox.user_id: % orphaned reference(s) set to NULL', cleared;
    END IF;

    ALTER TABLE "aico_key_outbox" ADD CONSTRAINT "aico_key_outbox_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE cleared bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.aico_key_outbox'::regclass
      AND conname = 'aico_key_outbox_org_id_organizations_id_fk'
  ) THEN
    UPDATE "aico_key_outbox" AS o
    SET "payload" = coalesce(o."payload", '{}'::jsonb)
          || jsonb_build_object('aicoOrphanedRefs',
               coalesce(o."payload" -> 'aicoOrphanedRefs', '{}'::jsonb)
               || jsonb_build_object('orgId', o."org_id")),
        "org_id" = NULL
    WHERE o."org_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "organizations" AS r WHERE r."id" = o."org_id");
    GET DIAGNOSTICS cleared = ROW_COUNT;
    IF cleared > 0 THEN
      RAISE NOTICE 'aico_key_outbox.org_id: % orphaned reference(s) set to NULL', cleared;
    END IF;

    ALTER TABLE "aico_key_outbox" ADD CONSTRAINT "aico_key_outbox_org_id_organizations_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE cleared bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.aico_key_outbox'::regclass
      AND conname = 'aico_key_outbox_org_member_id_organization_members_id_fk'
  ) THEN
    UPDATE "aico_key_outbox" AS o
    SET "payload" = coalesce(o."payload", '{}'::jsonb)
          || jsonb_build_object('aicoOrphanedRefs',
               coalesce(o."payload" -> 'aicoOrphanedRefs', '{}'::jsonb)
               || jsonb_build_object('orgMemberId', o."org_member_id")),
        "org_member_id" = NULL
    WHERE o."org_member_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "organization_members" AS m WHERE m."id" = o."org_member_id");
    GET DIAGNOSTICS cleared = ROW_COUNT;
    IF cleared > 0 THEN
      RAISE NOTICE 'aico_key_outbox.org_member_id: % orphaned reference(s) set to NULL', cleared;
    END IF;

    ALTER TABLE "aico_key_outbox" ADD CONSTRAINT "aico_key_outbox_org_member_id_organization_members_id_fk"
      FOREIGN KEY ("org_member_id") REFERENCES "public"."organization_members"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
-- A UX preference only (never used to authorize), so it is simply cleared.
DO $$
DECLARE cleared bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.user_wallets'::regclass
      AND conname = 'user_wallets_preferred_organization_id_organizations_id_fk'
  ) THEN
    UPDATE "user_wallets" AS w
    SET "preferred_organization_id" = NULL
    WHERE w."preferred_organization_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "organizations" AS r WHERE r."id" = w."preferred_organization_id");
    GET DIAGNOSTICS cleared = ROW_COUNT;
    IF cleared > 0 THEN
      RAISE NOTICE 'user_wallets.preferred_organization_id: % orphaned reference(s) set to NULL', cleared;
    END IF;

    ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_preferred_organization_id_organizations_id_fk"
      FOREIGN KEY ("preferred_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE cleared bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.wallet_transactions'::regclass
      AND conname = 'wallet_transactions_org_member_id_organization_members_id_fk'
  ) THEN
    UPDATE "wallet_transactions" AS t
    SET "metadata" = coalesce(t."metadata", '{}'::jsonb)
          || jsonb_build_object('aicoOrphanedRefs',
               coalesce(t."metadata" -> 'aicoOrphanedRefs', '{}'::jsonb)
               || jsonb_build_object('orgMemberId', t."org_member_id")),
        "org_member_id" = NULL
    WHERE t."org_member_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "organization_members" AS m WHERE m."id" = t."org_member_id");
    GET DIAGNOSTICS cleared = ROW_COUNT;
    IF cleared > 0 THEN
      RAISE NOTICE 'wallet_transactions.org_member_id: % orphaned reference(s) set to NULL', cleared;
    END IF;

    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_org_member_id_organization_members_id_fk"
      FOREIGN KEY ("org_member_id") REFERENCES "public"."organization_members"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
-- 0157 named this FK by hand; use the name the schema generates (Postgres
-- truncates identifiers to 63 bytes, which is the name it ends up with).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.aico_reconciliation_runs'::regclass
      AND conname = 'aico_reconciliation_runs_triggered_by_admin_id_fk'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.aico_reconciliation_runs'::regclass
      AND conname = 'aico_reconciliation_runs_triggered_by_admin_id_platform_admin_u'
  ) THEN
    ALTER TABLE "aico_reconciliation_runs"
      RENAME CONSTRAINT "aico_reconciliation_runs_triggered_by_admin_id_fk"
      TO "aico_reconciliation_runs_triggered_by_admin_id_platform_admin_u";
  END IF;
END $$;
