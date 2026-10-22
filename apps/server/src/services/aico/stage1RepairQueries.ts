/**
 * Read-only SQL for `scripts/aico/stage1RepairDryRun.ts`: rows damaged before
 * the stage-1 wallet/renewal fixes (#652). Kept here so the queries are tested
 * against the real migrated schema (`stage1RepairQueries.test.ts`).
 */

export const R1_UNSETTLED_REMOVED_MEMBERS = `
      SELECT m.org_id, m.id AS org_member_id, m.user_id, m.status AS member_status, m.left_at,
             b.renewal_status, b.is_active, b.period, b.period_amount_micro_usd,
             b.reserved_micro_usd, b.pending_period_amount_micro_usd, b.openrouter_key_id,
             (SELECT o.status || ' / attempts=' || o.attempts || ' / ' || coalesce(o.last_error, '')
                FROM aico_key_outbox o
               WHERE o.org_member_id = m.id AND o.action = 'reclaim_member'
               ORDER BY o.created_at DESC LIMIT 1) AS last_reclaim_job,
             (SELECT count(*) FROM wallet_transactions t
               WHERE t.org_member_id = m.id AND t.type = 'period_renewal'
                 AND m.left_at IS NOT NULL AND t.created_at > m.left_at) AS renewals_after_leaving
        FROM organization_members m
        JOIN member_budgets b ON b.org_member_id = m.id
       WHERE m.status IN ('left', 'revocation_pending')
         AND b.renewal_status <> 'settled'
       ORDER BY m.org_id, m.id`;

export const R6_BASELINE_KEY_CANDIDATES = `
      SELECT b.org_id, b.org_member_id, b.openrouter_key_id, b.period, b.period_amount_micro_usd,
             b.usage_baseline_micro_usd, b.billed_usage_before_baseline_micro_usd,
             b.settled_usage_micro_usd, b.managed_key_limit_micro_usd, b.checkpoint_multiplier_bp,
             (SELECT max(t.created_at) FROM wallet_transactions t
               WHERE t.org_member_id = b.org_member_id AND t.type = 'reclaim') AS last_reclaim_at,
             (SELECT max(t.created_at) FROM wallet_transactions t
               WHERE t.org_member_id = b.org_member_id AND t.type = 'allocate') AS last_allocate_at
        FROM member_budgets b
       WHERE b.openrouter_key_id IS NOT NULL
         AND coalesce(b.managed_key_provider_id, 'openrouter') = 'cheapvibecode'
         AND coalesce(b.usage_baseline_micro_usd, 0) > 0
         AND EXISTS (SELECT 1 FROM wallet_transactions t
                      WHERE t.org_member_id = b.org_member_id AND t.type = 'reclaim')
       ORDER BY b.org_id, b.org_member_id`;

export const R5_REFUND_AFTER_RECLAIM = `
      SELECT r.org_id, r.org_member_id, r.id AS reclaim_tx_id, r.created_at AS reclaimed_at,
             r.amount_micro_usd AS reclaimed_micro_usd,
             p.id AS refund_tx_id, p.created_at AS refunded_at,
             p.amount_micro_usd AS refunded_micro_usd
        FROM wallet_transactions r
        JOIN wallet_transactions p
          ON p.org_member_id = r.org_member_id AND p.type = 'period_refund'
         AND p.created_at > r.created_at
       WHERE r.type = 'reclaim'
         AND NOT EXISTS (SELECT 1 FROM wallet_transactions a
                          WHERE a.org_member_id = r.org_member_id AND a.type = 'allocate'
                            AND a.created_at > r.created_at AND a.created_at < p.created_at)
       ORDER BY r.org_id, r.created_at`;

export const W1_DEBITED_WALLETS_WITH_KEY = `
      SELECT w.user_id, w.balance_micro_usd, w.settled_usage_micro_usd, w.raw_capacity_micro_usd,
             w.managed_key_limit_micro_usd, w.openrouter_key_id, w.is_active,
             (SELECT max(t.created_at) FROM wallet_transactions t
               WHERE t.user_id = w.user_id AND t.type = 'manual_debit' AND t.org_id IS NULL) AS last_debit_at
        FROM user_wallets w
       WHERE w.openrouter_key_id IS NOT NULL
         AND w.balance_micro_usd - greatest(0, w.settled_usage_micro_usd) <= 0
         AND EXISTS (SELECT 1 FROM wallet_transactions t
                      WHERE t.user_id = w.user_id AND t.type = 'manual_debit')
       ORDER BY w.user_id`;
