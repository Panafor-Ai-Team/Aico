import pg from 'pg';

import {
  R1_UNSETTLED_REMOVED_MEMBERS,
  R5_REFUND_AFTER_RECLAIM,
  R6_BASELINE_KEY_CANDIDATES,
  W1_DEBITED_WALLETS_WITH_KEY,
} from '../../apps/server/src/services/aico/stage1RepairQueries';

const { Pool } = pg;

/**
 * Dry run for repairing data damaged before the stage-1 wallet/renewal fixes
 * (#652 / #653). Never writes: it runs inside a READ ONLY transaction and only
 * prints what is wrong and what repair is proposed. Nothing here repairs
 * anything — each proposal needs an explicit owner decision first.
 *
 *   DATABASE_URL=... bunx tsx scripts/aico/stage1RepairDryRun.ts [--json]
 *
 * Sections:
 *   R1  removed members whose budget was never settled (credit never returned)
 *   R6  member keys that may have been minted with the old lifetime baseline
 *   R5  period refunds paid after a reclaim with no re-allocation in between
 *   W1  personal wallets fully debited whose key may still carry headroom
 *
 * R6 and W1 cannot be confirmed from Postgres alone: the key's live usage has
 * to be read from the gateway. Rows there are candidates, not findings.
 */

const MICRO = 1_000_000;
const asJson = process.argv.includes('--json');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const usd = (micro: number | string | null | undefined) =>
  `$${(Number(micro ?? 0) / MICRO).toFixed(6)}`;

const run = async () => {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  const report: Record<string, unknown[]> = {};

  try {
    await client.query('BEGIN TRANSACTION READ ONLY');

    // ---- R1: removed members never settled ----
    // The reclaim read a frozen CheapVibeCode key and failed every attempt, so
    // the budget stayed active and kept being renewed. With the fix deployed, a
    // fresh `reclaim_member` outbox job settles it through the normal path.
    const r1 = await client.query(R1_UNSETTLED_REMOVED_MEMBERS);
    report.r1 = r1.rows.map((row) => ({
      ...row,
      proposedRepair:
        're-queue one `reclaim_member` outbox job for this member (after #653 is deployed); the reclaim credits the org and settles the budget',
      upperBoundReturned: usd(
        Number(row.reserved_micro_usd ?? 0) || Number(row.period_amount_micro_usd ?? 0),
      ),
    }));

    // ---- R6: keys possibly minted with the old lifetime baseline ----
    // A budget re-allocated after a reclaim, on a CheapVibeCode key, whose
    // stored limit still includes a non-zero baseline. Confirm by reading the
    // key: if (limit − remaining) is below the baseline, the key's counter never
    // carried that baseline and the member could spend unbilled up to it.
    const r6 = await client.query(R6_BASELINE_KEY_CANDIDATES);
    report.r6 = r6.rows
      .filter((row) => row.last_allocate_at && row.last_reclaim_at < row.last_allocate_at)
      .map((row) => ({
        ...row,
        confirmWith:
          'live read of the key: raw used on key = limit − remaining; affected if that is below usage_baseline_micro_usd',
        proposedRepair:
          'if confirmed: set usage_baseline to 0 and billed_usage_before_baseline to the cycle spend, then resize the key to (cap − billed) / M; unbilled spend already made is reported, not recovered automatically',
      }));

    // ---- R5: period refund after a reclaim, no re-allocation in between ----
    // The renewal refunded a member that a concurrent revoke had already
    // reclaimed. The second refund is the excess; recovering it is an org-wallet
    // debit and must be an explicit owner decision.
    const r5 = await client.query(R5_REFUND_AFTER_RECLAIM);
    report.r5 = r5.rows.map((row) => ({
      ...row,
      possibleExcess: usd(row.refunded_micro_usd),
      proposedRepair:
        'owner review only: if the refund is confirmed as a double credit, debit the org wallet by that amount with an adjustment ledger row',
    }));

    // ---- W1: fully debited wallets that may still have key headroom ----
    const w1 = await client.query(W1_DEBITED_WALLETS_WITH_KEY);
    report.w1 = w1.rows.map((row) => ({
      ...row,
      confirmWith: 'live read of the key: affected if it still has remaining headroom',
      proposedRepair:
        'if confirmed: queue one `shrink_user_key` outbox job (after #653 is deployed)',
    }));

    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const sections: [string, string][] = [
    ['r1', 'R1 — removed members never settled'],
    ['r6', 'R6 — member keys possibly minted with the old baseline (candidates)'],
    ['r5', 'R5 — period refund after a reclaim (possible double credit)'],
    ['w1', 'W1 — fully debited wallets with a key (candidates)'],
  ];
  for (const [key, title] of sections) {
    const rows = report[key] ?? [];
    console.log(`\n=== ${title}: ${rows.length} row(s) ===`);
    for (const row of rows) console.log(row);
  }
  console.log('\nDry run only. Nothing was written.');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
