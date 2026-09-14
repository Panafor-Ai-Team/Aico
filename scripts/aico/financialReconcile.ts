import pg from 'pg';

const { Pool } = pg;

/**
 * Read-only reconciliation probe for the Aico credit system.
 *
 * The wallet ledger is an upstream-ledger design: `balance_micro_usd` is money
 * paid and never decreases, `raw_capacity_micro_usd` is the raw upstream spend
 * that money bought, and OpenRouter enforces the cap by holding that capacity
 * as the key's lifetime limit. So "is the accounting right?" cannot be answered
 * from Postgres alone — it needs OpenRouter's own usage counters.
 *
 * Never writes. Runs inside a READ ONLY transaction and only ever issues GETs
 * against OpenRouter.
 */

const MICRO = 1_000_000;

const args = new Set(process.argv.slice(2));
const withOpenRouter = args.has('--with-openrouter');
const asJson = args.has('--json');
const userArg = process.argv.find((a) => a.startsWith('--user='));
const focusUserId = userArg ? userArg.slice('--user='.length) : null;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const usd = (micro: number | null | undefined) => `$${(Number(micro ?? 0) / MICRO).toFixed(6)}`;

interface WalletRow {
  balance_micro_usd: string;
  credited_micro_usd: string | null;
  frozen_micro_usd: string;
  is_active: boolean;
  last_synced_at: Date | null;
  openrouter_key_id: string | null;
  raw_added_micro_usd: string | null;
  raw_capacity_micro_usd: string;
  usage_log_cost_micro_usd: string | null;
  user_id: string;
}

interface KeyInfo {
  disabled?: boolean;
  limit?: number | null;
  limit_remaining?: number | null;
  usage?: number | null;
}

/**
 * Mirrors `isStaleManagedKeyId` in packages/database/src/utils/aicoMoney.ts.
 * A `mock_` hash means the deployment ran against MockOpenRouterManagementClient,
 * whose usage counter is permanently zero — reconciling against it would report
 * a clean bill of health for a system that never measured anything.
 */
const isMockKeyId = (keyId: string) => keyId.startsWith('mock_');

const fetchKey = async (managementKey: string, hash: string): Promise<KeyInfo> => {
  const res = await fetch(`https://openrouter.ai/api/v1/keys/${hash}`, {
    headers: { Authorization: `Bearer ${managementKey}` },
    method: 'GET',
  });
  if (!res.ok) throw new Error(`OpenRouter Management API ${res.status} for ${hash}`);
  const body = (await res.json()) as { data?: KeyInfo };
  return body.data ?? {};
};

const run = async () => {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  const findings: string[] = [];
  const report: Record<string, unknown> = {};

  try {
    await client.query('BEGIN TRANSACTION READ ONLY');

    // ---- Wallet-level roll-up: INV-1 inputs, INV-2, INV-3, INV-7 ----
    const wallets = await client.query<WalletRow>(
      `
        SELECT w.user_id,
               w.balance_micro_usd,
               w.raw_capacity_micro_usd,
               w.frozen_micro_usd,
               w.is_active,
               w.openrouter_key_id,
               w.last_synced_at,
               t.credited_micro_usd,
               t.raw_added_micro_usd,
               u.usage_log_cost_micro_usd
        FROM user_wallets w
        LEFT JOIN (
          SELECT user_id,
                 SUM(amount_micro_usd) AS credited_micro_usd,
                 SUM(COALESCE((metadata->>'rawCapacityAddedMicroUsd')::bigint, 0))
                   AS raw_added_micro_usd
          FROM wallet_transactions
          WHERE user_id IS NOT NULL AND org_id IS NULL
          GROUP BY user_id
        ) t ON t.user_id = w.user_id
        LEFT JOIN (
          SELECT user_id, SUM(cost_micro_usd) AS usage_log_cost_micro_usd
          FROM usage_logs
          WHERE user_id IS NOT NULL
          GROUP BY user_id
        ) u ON u.user_id = w.user_id
        ${focusUserId ? 'WHERE w.user_id = $1' : ''}
        ORDER BY w.balance_micro_usd DESC
      `,
      focusUserId ? [focusUserId] : [],
    );

    const inv2 = wallets.rows.filter(
      (r) => Number(r.raw_capacity_micro_usd) !== Number(r.raw_added_micro_usd ?? 0),
    );
    const inv3 = wallets.rows.filter(
      (r) =>
        Number(r.balance_micro_usd) + Number(r.frozen_micro_usd) !==
        Number(r.credited_micro_usd ?? 0),
    );
    // A wallet that was credited but whose capacity never followed pushes a key
    // limit of 0 — it can be spent to exactly nothing, or be unlimited, depending
    // on how OpenRouter reads `limit: 0`. Either way it is not what was paid for.
    const zeroCapacityFunded = wallets.rows.filter(
      (r) => Number(r.balance_micro_usd) > 0 && Number(r.raw_capacity_micro_usd) === 0,
    );
    const frozen = wallets.rows.filter((r) => Number(r.frozen_micro_usd) > 0);
    const mockKeys = wallets.rows.filter(
      (r) => r.openrouter_key_id && isMockKeyId(r.openrouter_key_id),
    );

    report.walletCount = wallets.rowCount;
    report.inv2Breaches = inv2.map((r) => r.user_id);
    report.inv3Breaches = inv3.map((r) => r.user_id);
    report.zeroCapacityFunded = zeroCapacityFunded.map((r) => r.user_id);
    report.frozenWallets = frozen.map((r) => ({
      frozenMicroUsd: Number(r.frozen_micro_usd),
      userId: r.user_id,
    }));
    report.mockKeyWallets = mockKeys.map((r) => r.user_id);

    if (inv2.length)
      findings.push(
        `INV-2 breached on ${inv2.length} wallet(s): raw_capacity != sum of credited capacity`,
      );
    if (inv3.length)
      findings.push(
        `INV-3 breached on ${inv3.length} wallet(s): balance + frozen != sum of credits`,
      );
    if (zeroCapacityFunded.length)
      findings.push(
        `${zeroCapacityFunded.length} funded wallet(s) have raw_capacity = 0 (key limit would be pushed as 0)`,
      );
    if (mockKeys.length)
      findings.push(
        `${mockKeys.length} wallet(s) hold a mock_ OpenRouter key — that deployment never metered anything`,
      );
    if (frozen.length)
      findings.push(`${frozen.length} wallet(s) hold frozen funds with no unfreeze path in code`);

    // ---- INV-6: ledger contiguity ----
    const ledger = await client.query<{
      amount_micro_usd: string;
      balance_after_micro_usd: string | null;
      balance_before_micro_usd: string | null;
      id: string;
      user_id: string;
    }>(
      `
        SELECT id, user_id, amount_micro_usd, balance_before_micro_usd, balance_after_micro_usd
        FROM wallet_transactions
        WHERE user_id IS NOT NULL AND org_id IS NULL
          AND balance_before_micro_usd IS NOT NULL
          AND balance_after_micro_usd IS NOT NULL
          ${focusUserId ? 'AND user_id = $1' : ''}
        ORDER BY user_id, created_at
      `,
      focusUserId ? [focusUserId] : [],
    );

    const inv6Self = ledger.rows.filter(
      (r) =>
        Number(r.balance_after_micro_usd) - Number(r.balance_before_micro_usd) !==
        Number(r.amount_micro_usd),
    );
    const inv6Chain: string[] = [];
    let prev: (typeof ledger.rows)[number] | null = null;
    for (const row of ledger.rows) {
      if (
        prev &&
        prev.user_id === row.user_id &&
        Number(prev.balance_after_micro_usd) !== Number(row.balance_before_micro_usd)
      ) {
        inv6Chain.push(row.id);
      }
      prev = row;
    }

    report.inv6SelfBreaches = inv6Self.map((r) => r.id);
    report.inv6ChainBreaches = inv6Chain;
    if (inv6Self.length)
      findings.push(
        `INV-6 breached: ${inv6Self.length} ledger row(s) where after - before != amount`,
      );
    if (inv6Chain.length)
      findings.push(
        `INV-6 breached: ${inv6Chain.length} ledger row(s) where before != previous row's after (concurrent-credit snapshot race)`,
      );

    // ---- INV-7: what usage_logs claims was spent ----
    const usageTotals = await client.query<{
      nonzero_cost_rows: string;
      row_count: string;
      settled_rows: string;
      total_cost_micro_usd: string | null;
      total_tokens: string | null;
    }>(`
      SELECT COUNT(*) AS row_count,
             COUNT(*) FILTER (WHERE cost_micro_usd > 0) AS nonzero_cost_rows,
             COUNT(*) FILTER (WHERE settlement_status <> 'pending') AS settled_rows,
             SUM(cost_micro_usd) AS total_cost_micro_usd,
             SUM(total_tokens) AS total_tokens
      FROM usage_logs
    `);
    const ut = usageTotals.rows[0];
    report.usageLogs = {
      nonzeroCostRows: Number(ut.nonzero_cost_rows),
      rowCount: Number(ut.row_count),
      settledRows: Number(ut.settled_rows),
      totalCostMicroUsd: Number(ut.total_cost_micro_usd ?? 0),
      totalTokens: Number(ut.total_tokens ?? 0),
    };
    if (Number(ut.row_count) > 0 && Number(ut.nonzero_cost_rows) === 0)
      findings.push(
        `INV-7 violated by construction: ${ut.row_count} usage_logs rows, all with cost 0 — spend is entirely unattributed`,
      );
    if (Number(ut.row_count) > 0 && Number(ut.settled_rows) === 0)
      findings.push(
        `No usage_logs row has ever left settlement_status 'pending' — no settlement job runs`,
      );

    // ---- Org side: cached member usage ----
    const memberBudgets = await client.query<{
      never_synced: string;
      row_count: string;
      settled_total: string | null;
      zero_usage: string;
    }>(`
      SELECT COUNT(*) AS row_count,
             COUNT(*) FILTER (WHERE last_synced_at IS NULL) AS never_synced,
             COUNT(*) FILTER (WHERE settled_usage_micro_usd = 0) AS zero_usage,
             SUM(settled_usage_micro_usd) AS settled_total
      FROM member_budgets
      WHERE is_active
    `);
    report.memberBudgets = memberBudgets.rows[0];

    // ---- INV-1: needs OpenRouter ----
    if (withOpenRouter) {
      const managementKey = process.env.OPENROUTER_MANAGEMENT_API_KEY;
      if (!managementKey) {
        throw new Error(
          '--with-openrouter requires OPENROUTER_MANAGEMENT_API_KEY (run this on the control plane, never the product server)',
        );
      }

      const keyed = wallets.rows.filter(
        (r) => r.openrouter_key_id && !isMockKeyId(r.openrouter_key_id),
      );
      if (keyed.length === 0) {
        throw new Error(
          'No real OpenRouter keys found — every wallet is unkeyed or mock. Refusing to report reconciliation numbers that would be meaningless.',
        );
      }

      let rawSpendMicro = 0;
      const limitDrift: {
        keyId: string;
        limitUsd: number;
        rawCapacityUsd: number;
        userId: string;
      }[] = [];

      for (const w of keyed) {
        const info = await fetchKey(managementKey, w.openrouter_key_id!);
        const usageMicro = Math.floor(Number(info.usage ?? 0) * MICRO);
        rawSpendMicro += usageMicro;

        const expectedLimitUsd = Number(w.raw_capacity_micro_usd) / MICRO;
        const actualLimitUsd = Number(info.limit ?? 0);
        // Compare in whole micro-USD: the limit round-trips through a float on
        // the way to OpenRouter, so an exact float equality check would produce
        // false positives on every wallet.
        if (Math.round(expectedLimitUsd * MICRO) !== Math.round(actualLimitUsd * MICRO)) {
          limitDrift.push({
            keyId: w.openrouter_key_id!,
            limitUsd: actualLimitUsd,
            rawCapacityUsd: expectedLimitUsd,
            userId: w.user_id,
          });
        }
      }

      report.openRouter = {
        keysChecked: keyed.length,
        limitDrift,
        totalRawSpendMicroUsd: rawSpendMicro,
        unattributedMicroUsd: rawSpendMicro - Number(ut.total_cost_micro_usd ?? 0),
      };
      if (limitDrift.length)
        findings.push(
          `INV-1 breached on ${limitDrift.length} key(s): OpenRouter limit != raw_capacity_micro_usd`,
        );
      findings.push(
        `Unattributed spend: ${usd(rawSpendMicro)} raw upstream vs ${usd(Number(ut.total_cost_micro_usd ?? 0))} recorded in usage_logs`,
      );
    }

    await client.query('COMMIT');
  } finally {
    client.release();
    await pool.end();
  }

  if (asJson) {
    console.log(JSON.stringify({ findings, report }, null, 2));
    return;
  }

  console.log('\n=== Aico financial reconciliation (read-only) ===\n');
  console.log(JSON.stringify(report, null, 2));
  console.log('\n--- Findings ---');
  if (findings.length === 0) console.log('No invariant breaches detected.');
  for (const f of findings) console.log(`  • ${f}`);
  if (!withOpenRouter)
    console.log('\n(INV-1 and the unattributed-spend figure need --with-openrouter.)');
  console.log('');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
