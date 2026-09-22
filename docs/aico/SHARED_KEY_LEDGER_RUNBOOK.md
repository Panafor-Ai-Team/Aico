# Shared-key usage ledger runbook

CheapVibeCode (CVC) caps how many API keys an account may ever create, and CVC
keys are immutable, so every wallet top-up used to burn a key slot. This runbook
moves managed traffic onto **one key** (the CVC primary key) and enforces every
cent in our own database with a hold-and-settle ledger.

- **Before each call:** a hold is placed atomically against the wallet or member
  budget: `UPDATE … WHERE available >= hold AND open_holds < max`.
- **After each call:** the hold settles to the cost recomputed from token counts.
  Unmeasured calls are charged the full hold, never zero.
- **Overspend is bounded:** `max overspend per subject ≤ MAX_OPEN_HOLDS × max(actual − hold)`.
  Output is capped by the injected `max_tokens` and input is over-estimated, so
  `actual ≤ hold` for normal traffic. Phase A measures that before anything is
  enforced.

Schema: migration `0156_aico_usage_ledger.sql`, which is additive only. It adds
the `usage_holds` and `aico_ledger_state` tables, ledger columns on
`user_wallets` and `member_budgets`, and `usage_logs.hold_id`.

**Never** print, log or paste `AICO_SHARED_INFERENCE_API_KEY`, the CVC primary
key or `CRON_SECRET`. Read `CRON_SECRET` from the env file into a shell variable.

## Environment

| Variable                                 | Default       | Meaning                                                                                                   |
| ---------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `AICO_BILLING_LEDGER_MODE`               | `off`         | `off` \| `shadow` \| `enforce`                                                                            |
| `AICO_MANAGED_INFERENCE_KEY`             | `per_subject` | `per_subject` \| `shared`                                                                                 |
| `AICO_SHARED_INFERENCE_API_KEY`          | —             | CVC primary key, used only when `shared`. Never log. Accepted risk (2026-09-16).                          |
| `AICO_LEDGER_HOLD_TTL_SECONDS`           | `900`         | Open holds past this are charged in full by maintenance (360–3600).                                       |
| `AICO_LEDGER_MAX_OPEN_HOLDS`             | `6`           | Concurrent in-flight calls per wallet or budget (1–64).                                                   |
| `AICO_MANAGED_DEFAULT_MAX_OUTPUT_TOKENS` | `32000`       | `max_tokens` injected when the client sends none.                                                         |
| `AICO_LEDGER_FLOAT_FLOOR_MICRO_USD`      | `1000000`     | Shared mode refuses holds that would take the CVC account below this.                                     |
| `AICO_LEDGER_FLOAT_MAX_AGE_SECONDS`      | `600`         | A float reading older than this alerts, and requests are allowed.                                         |
| `CHEAPVIBECODE_API_KEY`                  | blank         | Must stay blank on product containers. Compose forces it blank; shared mode refuses traffic if it is set. |

### Mode matrix

| mode \ key                        | `per_subject`                                           | `shared`                                |
| --------------------------------- | ------------------------------------------------------- | --------------------------------------- |
| `off`                             | exactly the legacy behaviour                            | refused (`ledger_misconfigured`)        |
| `shadow`                          | legacy + shadow holds, never refuses                    | refused (`ledger_misconfigured`)        |
| `enforce`, snapshot not finalized | refused (`snapshot_pending`)                            | refused (`snapshot_pending`)            |
| `enforce`, snapshot finalized     | ledger authoritative; per-subject key is a backup brake | ledger authoritative on the primary key |

Also:

- `aico_ledger_state.paused = true` refuses managed traffic in **every** mode
  within 5 seconds. It also stops renewals and the key outbox.
- Going back to `off` or `shadow` after enforce started is refused
  (`enforce_downgrade`). See [Rollback](#rollback).

Users see "The service is temporarily unavailable" for every
`PLATFORM_CAPACITY_EXHAUSTED:*` refusal. The suffix is in server logs and alerts.

### Cron endpoints

Both require `Authorization: Bearer $CRON_SECRET`.

- `GET /api/aico/cron/ledger-maintenance`:
  - Expires overdue holds, up to 500 per run.
  - In shared + authoritative mode, reconciles the CVC account balance
    against ledger spend over windows of at least 1 hour.
  - It raises a warning above `1.05× + $0.10` and a critical alert above `1.25× + $1`.
  - Compose runs it every 5 minutes (`aico-ledger-maintenance`).
- `POST /api/aico/cron/ledger-snapshot?phase=wallets|budgets|finalize&limit=1..100`:
  the cutover snapshot (Phase B). It returns 409 with `reason` when a
  precondition fails and 502 on a transient upstream error. The cursor is
  persisted, so rerunning resumes.

## Preflight (read-only)

1. **Where the primary key lives.** On the server, list env var **names only**
   whose value starts with the primary key prefix, in both `.env` files and
   inside the product and control-plane containers. Example:
   `awk -F= '$2 ~ /^sk-cvc-4b3e/ {print $1}' <file>`. Do not print values.
   Wrap every `docker exec` in `timeout`, and never restart dockerd or containerd.
2. **CVC honours `max_tokens`.** From a trusted shell, send one request with
   `max_tokens: 64` to `glm-5.3-flash`, `deepseek-v4.1-flash` and `grok-4.6`.
   `usage.completion_tokens` must be ≤ 64, reasoning included. If CVC ignores
   it, **stop**: the output bound rests on it.
3. **Migration on a copy.** Apply 0156 to a copy of the database. Confirm
   `\d user_wallets` and `\d member_budgets` gained columns and row counts are
   unchanged.
4. **Catalog coverage.** Every enabled model must have a fixed text input price:
   ```sql
   SELECT id FROM openrouter_model_catalog WHERE enabled AND NOT (pricing::text LIKE '%textInput%');
   ```
   This must return no rows.
5. **Model picker.** With `CHEAPVIBECODE_API_KEY=` blank, confirm on staging that
   the managed model picker still lists models.
6. **Overdue renewals.** Resolve any overdue member renewals first: the Phase B
   pause blocks renewals.

## Phase A: shadow (24–48 h)

Deploy through the normal canary pipeline with:

```
AICO_BILLING_LEDGER_MODE=shadow
AICO_MANAGED_INFERENCE_KEY=per_subject
```

- Nothing is enforced; per-subject upstream keys still brake.
- The only visible change is the default `max_tokens` of 32,000.
- Image, video, TTS and ASR calls are recorded as `not_metered` shadow rows.

### Report SQL

```sql
-- 1. Estimator safety: max_ratio must be ≤ 1.0
SELECT model_id, operation, count(*) AS n,
       max(raw_cost_micro_usd::numeric / NULLIF(hold_raw_micro_usd, 0)) AS max_ratio,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY raw_cost_micro_usd::numeric / NULLIF(hold_raw_micro_usd, 0)) AS p99_ratio
FROM usage_holds WHERE mode = 'shadow' AND settle_reason = 'usage'
GROUP BY 1, 2 ORDER BY max_ratio DESC NULLS LAST;

-- 2. What enforce would have refused
SELECT refuse_reason, billing_source, count(*) FROM usage_holds
WHERE mode = 'shadow' AND would_refuse GROUP BY 1, 2 ORDER BY 3 DESC;

-- 3. Unpriced models in use
SELECT model_id, count(*) FROM usage_holds
WHERE mode = 'shadow' AND refuse_reason = 'pricing' GROUP BY 1;

-- 4. Operations enforce would block
SELECT operation, count(*) FROM usage_holds
WHERE mode = 'shadow' AND refuse_reason = 'not_metered' GROUP BY 1;

-- 5. Settle outcomes and what estimates would have cost
SELECT operation, status, settle_reason, count(*),
       sum(hold_raw_micro_usd) AS hold_raw, sum(raw_cost_micro_usd) AS actual_raw
FROM usage_holds WHERE mode = 'shadow' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- 6. Peak concurrency per subject
SELECT a.user_id, a.billing_source, a.org_member_id, max(c.n) AS peak
FROM usage_holds a
CROSS JOIN LATERAL (
  SELECT count(*) AS n FROM usage_holds b
  WHERE b.mode = 'shadow' AND b.user_id = a.user_id AND b.billing_source = a.billing_source
    AND b.org_member_id IS NOT DISTINCT FROM a.org_member_id
    AND b.created_at <= a.created_at AND coalesce(b.settled_at, b.expires_at) > a.created_at
) c
WHERE a.mode = 'shadow' GROUP BY 1, 2, 3 ORDER BY peak DESC LIMIT 20;
```

### Exit criteria

All must hold. Otherwise fix the cause and repeat Phase A.

- `max_ratio ≤ 1.0` for every model with `n ≥ 20` (query 1).
- No unpriced model carries real traffic (query 3 is empty, or those models are
  disabled).
- The owner has decided on the image/video/TTS/ASR volume (query 4). Enforce
  refuses those operations.
- `estimate_error` + `estimate_no_usage` is below 2% of chat settles (query 5).
- The owner accepts the `estimate_aborted` total (query 5). That is what
  Stop-button aborts will cost users.
- Peak concurrency ≤ 6 (query 6). Otherwise raise `AICO_LEDGER_MAX_OPEN_HOLDS`.

## Phase B: cutover

Expect about 10–20 minutes of refused managed traffic, so schedule a maintenance
window. Get the owner's go-ahead before each step.

1. **Pause.**
   ```sql
   UPDATE aico_ledger_state SET paused = true, updated_at = now() WHERE id = 'default';
   ```
   Within 5 seconds all managed traffic is refused, and renewals and the key
   outbox stop.
2. **Drain.** Wait 10 minutes so in-flight streams and agent runs finish on
   their per-subject keys.
3. **Deploy** through the normal pipeline, with the owner editing the server `.env`:
   ```
   AICO_BILLING_LEDGER_MODE=enforce
   AICO_MANAGED_INFERENCE_KEY=shared
   AICO_SHARED_INFERENCE_API_KEY=<primary key, set by the owner>
   ```
   `CHEAPVIBECODE_API_KEY` stays blank (compose forces it). Traffic is still
   refused with `:paused`, which is expected.
4. **Snapshot wallets, then budgets.** Repeat each until the response has
   `done: true`:
   ```bash
   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "$TARGET/api/aico/cron/ledger-snapshot?phase=wallets&limit=25"
   ```
   ```bash
   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "$TARGET/api/aico/cron/ledger-snapshot?phase=budgets&limit=25"
   ```
   - A 502 is transient. Wait 30 seconds and rerun; it resumes from the cursor.
   - A 409 names the failed precondition: `mode_not_enforce`, `not_paused`,
     `already_completed` or `open_holds`.
   - `degradedUserIds` lists wallets whose legacy key could not be read. Their
     usage was estimated from settled usage, never zero.
5. **Finalize.**
   ```bash
   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "$TARGET/api/aico/cron/ledger-snapshot?phase=finalize"
   ```
   Record `overdrawnWallets`, `degradedWallets` and `totalRawAvailable`.
6. **Verify.**
   ```sql
   SELECT paused, enforce_started_at, snapshot_completed_at FROM aico_ledger_state;
   SELECT count(*) FILTER (WHERE raw_used_micro_usd > raw_capacity_micro_usd) AS overdrawn,
          count(*) FILTER (WHERE last_sync_status = 'degraded') AS degraded,
          sum(GREATEST(raw_capacity_micro_usd - raw_used_micro_usd, 0)) AS raw_owed_to_wallets
   FROM user_wallets;
   SELECT count(*) FROM member_budgets WHERE held_micro_usd <> 0 OR open_holds <> 0; -- must be 0
   SELECT count(*) FROM usage_holds WHERE mode = 'enforce';                        -- must be 0
   ```
   Compare `raw_owed_to_wallets` plus budget obligations with the CVC account
   balance. If obligations exceed the balance, **report it to the owner before
   unpausing**. Do not fund anything as part of this runbook.
7. **Unpause.**
   ```sql
   UPDATE aico_ledger_state SET paused = false, updated_at = now() WHERE id = 'default';
   ```
8. **Smoke test.**
   - A funded test user chats. One `usage_holds` row goes `open` → `settled/usage`,
     one `usage_logs` row carries its `hold_id`, and wallet `raw_used_micro_usd`
     increases.
   - An unfunded user gets `PERSONAL_FUNDS_UNAVAILABLE`.
   - A top-up is spendable immediately, and no CVC key is created.
9. **Watch** for the first hours: the `aico-ledger-maintenance` logs, reconcile
   alerts, and
   ```sql
   SELECT status, settle_reason, count(*) FROM usage_holds
   WHERE created_at > now() - interval '1 hour' GROUP BY 1, 2;
   ```

## Emergency brake

Set `paused = true` (Phase B step 1). It takes effect within 5 seconds in every
mode, with no deploy. Unpause with step 7 once the cause is understood.

## Rollback

- **Soft rollback (safe).** Set `AICO_MANAGED_INFERENCE_KEY=per_subject` and keep
  `enforce`. The ledger keeps braking, but every subject needs its own CVC key
  again, which brings back the key-quota problem.
- **Hard rollback to `off` or `shadow` is refused by design**
  (`enforce_downgrade`). Legacy key limits know nothing about post-cutover
  spend and would over-spend. It needs two deliberate steps, and only with the
  owner:
  1. A reverse snapshot that re-mints keys with `limit = ledger remaining`.
     This is **not built**.
  2. Clear the enforce markers:
     `UPDATE aico_ledger_state SET enforce_started_at = NULL, snapshot_completed_at = NULL WHERE id = 'default';`
- **Legacy per-subject keys** are left untouched after cutover for the rollback
  window. After about 7 stable days the owner may enqueue
  `disable_user_key` / `disable_member_key` for them.

## Known limitations (accepted)

- **Aborted streams** (Stop button, closed tab) are charged the full hold
  5 seconds after the abort.
- **`generateObject`** output cannot be capped upstream. Its hold assumes
  `min(model max, 32k)` output tokens.
- **Image, video, TTS and ASR** managed calls are refused under enforce until
  they are metered.
- **Trial** has no ledger capacity; trial is disabled in production.
- **Requests in flight during a renewal, reclaim or sweep** count at their full
  hold in the refund. When they settle, the charge does not land on the new
  cycle (budget epoch). The platform keeps `hold − actual`.
- **5xx, network errors and timeouts** are charged the hold, because CVC may
  have billed partial output. Upstream 4xx rejections (including 429) are
  released at no charge.
- **The byte-based estimate over-holds.** Near a zero balance `max_tokens` is
  shrunk, and very large contexts may be refused although they would fit.
- **The shared key's CVC rate limits apply to the whole platform.**
- **Streams longer than `AICO_LEDGER_HOLD_TTL_SECONDS`** are charged their
  hold at expiry.
- **The primary key lives on the product server** (accepted risk). The
  reconcile alerts are the detector for spend that bypasses the ledger.
- **Shadow `would_refuse` is approximate.** It uses legacy settled usage, not
  ledger columns.
- **`packages/openapi` chat** reaches CVC only through the env key
  `CHEAPVIBECODE_API_KEY`, which is blank in production. That path does not
  work under shared mode, by design: it would be unmetered.

## Flagged ops issues (outside this change)

- The server crontab references a missing `openrouter-sync-cron.sh` and holds
  `CRON_SECRET` inline. Replace it with the 6-hourly `sync-openrouter-models`
  entry from `RENEWAL_SETTLEMENT_RUNBOOK.md`, reading `CRON_SECRET` from an env file.
- Delete the unrevokable unlimited CVC key `ace4a1f7-…` (prefix `sk-cvc-01780`)
  from the CVC dashboard.
- When the CVC primary key is rotated, update only
  `AICO_SHARED_INFERENCE_API_KEY` and `CHEAPVIBECODE_MANAGEMENT_API_KEY`.

Regression coverage:

- `packages/database/src/models/__tests__/aicoUsageLedger*.test.ts`
- `apps/server/src/services/aico/ledger/__tests__/`
- `*.ledger.test.ts` next to managedPolicy, keyService, renewalScheduler,
  orgBudgetSweep and the billing router
