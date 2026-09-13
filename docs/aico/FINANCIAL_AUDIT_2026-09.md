# Aico Credit & Financial System — Audit Findings

**Date:** 2026-09-12 · **Branch audited:** `canary` @ `85a8545f92` · **Migration head:** `0148`
**Scope:** personal wallets, org member budgets, top-up, renewal, reclaim/sweep, trial, generation billing, and the read/display path.
**Status:** findings only. No fixes applied, no production writes performed.

---

## 1. Executive summary

The incident that prompted this audit — _"I used a model that cost $0.40 and nothing was deducted"_ — is **almost certainly not lost money.** Spend is capped upstream by OpenRouter, not by our database. What failed is our _record and display_ of it, and that failure is systemic rather than incidental.

Two numbers should headline this report once the probe has been run against production (`scripts/aico/financialReconcile.ts --with-openrouter`):

| Metric                                             | How to get it                                            | Expected                                |
| -------------------------------------------------- | -------------------------------------------------------- | --------------------------------------- |
| Unattributed spend                                 | Σ OpenRouter `key.usage` − Σ `usage_logs.cost_micro_usd` | ≈ **100% of all spend ever**            |
| Wallets where `key.limit ≠ raw_capacity_micro_usd` | INV-1 check in the probe                                 | unknown — this is the real risk surface |

The second number matters far more than the first. Because OpenRouter's key limit _is_ the enforcement mechanism, **any drift between `raw_capacity_micro_usd` and the pushed key limit is the only way this system can actually lose money** — and we found three confirmed paths that produce exactly that drift.

**Headline findings:**

- **FIN-013 (P0) — FIXED 2026-09-12.** Neither manual-credit UI sent an idempotency key, and a post-commit key-push failure was reported to the admin as _"credit failed"_. An admin retry double-credited both the balance **and** the purchased capacity, doubling the user's OpenRouter spend limit. This affected both money-entry points into the platform.
- **FIN-014 (P0) — FIXED 2026-09-12.** For period-scoped member budgets, a missing OpenRouter period counter silently fell back to the **lifetime** usage figure, corrupting the multiplier checkpoint and pushing a key limit that could exceed the funded cap by orders of magnitude. The fix also closes FIN-020, which is the same fallback in the settle path.
- **FIN-015 (P0) — FIXED 2026-09-12.** Account freeze zeroed `balance_micro_usd` but left `raw_capacity_micro_usd` intact and wrote no ledger row. Any later credit silently reactivated the wallet and granted the pre-freeze capacity for free.
- **FIN-016 (P1)** — The wallet page's Toman figure — the primary currency for the fa-IR user base — is raw cumulative deposits with **no `remaining` counterpart at all**. It can never move. This is the most likely direct explanation of the reported incident.

**What is working:** the money _storage_ layer is sound (integer micro-USD, atomic SQL increments, conditional `WHERE balance >= amount` guards, real DB transactions). Double-reclaim and sweep-then-remove are correctly guarded. Trial uniqueness is atomically enforced. Orphaned keys are retired on persist failure. Several suspicions raised during triage were investigated and **refuted** — they are recorded in §7 so nobody re-litigates them.

---

## 2. System as designed

This is an **upstream-ledger / derive-on-read** architecture. Understanding this is a prerequisite for grading anything here correctly.

| Concept         | Column                                | Meaning                                                                                               |
| --------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Money paid      | `user_wallets.balance_micro_usd`      | Cumulative. **Monotonic by design** — never decreases.                                                |
| Capacity bought | `user_wallets.raw_capacity_micro_usd` | Cumulative `deposit / M_at_payment`. The raw upstream spend that money buys.                          |
| Enforcement     | OpenRouter key `limit`                | `ensureUserKey` pushes `raw_capacity_micro_usd` as the key's **lifetime** limit (`limitReset: null`). |
| Spend           | _(derived)_                           | `remaining = balance − billedUsageFromCapacity(key.usage)`. Computed on every read; never stored.     |

Org budgets are the same shape with a **period-scoped** key (`limit_reset` mirrors the budget period) plus a cached projection in `member_budgets.settled_usage_micro_usd` and a cycle-scoped multiplier checkpoint.

**Three unit systems coexist**, and most bugs in this report live at their boundaries:

- **raw** — what OpenRouter actually charged.
- **billed** — raw × platform multiplier (`multiplier_bp`, default 12000 = 1.2×). What the user pays.
- **micro-USD** — integer storage for both.

### Docs say / code does

| Source                                                                                            | Claim                                                                                           | Reality                                                                                                          |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `usage_logs.settlement_status` + [RENEWAL\_SETTLEMENT\_RUNBOOK.md](RENEWAL_SETTLEMENT_RUNBOOK.md) | Usage is settled from `pending` → `synchronized`                                                | **No settlement job exists.** No row has ever left `pending`. The schema implies a process that was never built. |
| `keyService.ts:418-420` docstring                                                                 | "Never writes lifetime `info.usage` into `settledUsageMicroUsd`"                                | The final `else` branch at `keyService.ts:499-503` does exactly that.                                            |
| `keyService.ts:101-107` comment                                                                   | Using lifetime `info.usage` for a period-scoped key "would corrupt every subsequent conversion" | `rawMeteredUsageMicro` at `:125` does exactly that: `periodUsageUsd ?? info.usage ?? 0`.                         |
| `wallet_transactions.type` enum                                                                   | Includes `personal_freeze`                                                                      | Never written anywhere. Freezes are unledgered.                                                                  |
| Migration `0143` comment (FIN-003)                                                                | Manual credits are idempotent                                                                   | The key is optional and **no UI sends one**. The mechanism is dead.                                              |

### Invariant register

| ID        | Invariant                                                                       | Status                                           |
| --------- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| **INV-1** | `openrouter_key.limit == raw_capacity_micro_usd`                                | **At risk** — FIN-014, FIN-015, FIN-019, FIN-024 |
| **INV-2** | `raw_capacity == Σ tx.metadata.rawCapacityAddedMicroUsd`                        | Holds for unfrozen wallets only (FIN-015)        |
| **INV-3** | `balance + frozen == Σ credits`                                                 | Numerically holds; unauditable (FIN-015)         |
| **INV-4** | `member key.limit == keyLimitFromBilled(currentCycleLimitMicroUsd, checkpoint)` | **Violated** — FIN-014, FIN-019                  |
| **INV-5** | `org_wallet.balance + Σ reserved == Σ credits − Σ settled`                      | Not yet probed                                   |
| **INV-6** | `balance_after − balance_before == amount`, contiguous per wallet               | **Violated** — FIN-021                           |
| **INV-7** | `Σ usage_logs.cost ≈ OpenRouter spend`                                          | **Violated by construction** — FIN-017           |
| **INV-8** | Every user-visible credit figure derives from `remaining`                       | **Violated** — FIN-016                           |

### Severity rubric

**P0** unbounded/unmetered spend, user charged what they didn't owe, or unreconstructable ledger corruption · **P1** enforcement works but the record is wrong/absent, or a funded user is wrongly blocked · **P2** aggregates wrong, unlikely race, config-dependent · **P3** cosmetic or sub-cent with a proven bound.

Modifiers applied after the base grade: **+1 if silent**, **+1 if it scales with traffic**, **−1 if an upstream guard bounds the loss**. That last modifier is why most metering findings sit at P1 and not P0 — and it is the entire reason the reported $0.40 did not become $400. A finding is only P0 if the dollar formula for the loss can be written down.

---

## 3. Findings index

| ID                  | Sev                  | Title                                                                                 | Direction                     | Conf      |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------- | ----------------------------- | --------- |
| [FIN-013](#fin-013) | ~~**P0**~~ **FIXED** | Manual credit is not idempotent and reports success as failure → double-credit        | platform-loses                | Confirmed |
| [FIN-014](#fin-014) | **P0**               | Lifetime-usage fallback corrupts period checkpoint → key limit exceeds funded cap     | platform-loses + user blocked | Confirmed |
| [FIN-015](#fin-015) | **P0**               | Freeze strands funds, leaves capacity, and a later credit grants it free              | platform-loses + user-loses   | Confirmed |
| [FIN-016](#fin-016) | P1                   | Wallet UI shows cumulative deposits, not remaining (Toman has no `remaining` at all)  | neither (trust)               | Confirmed |
| [FIN-017](#fin-017) | P1                   | `usage_logs` records hardcoded zeros, fire-and-forget, never settled                  | neither (attribution)         | Confirmed |
| [FIN-018](#fin-018) | P1                   | `getUserRemaining` swallows every failure and returns the full balance, unlogged      | neither (trust)               | Confirmed |
| [FIN-019](#fin-019) | P1                   | Key push runs outside the credit transaction with no outbox retry                     | user blocked / org-loses      | Confirmed |
| [FIN-020](#fin-020) | P1                   | `computeCycleUsageFromKeyInfo` writes lifetime usage, contradicting its own docstring | user-loses                    | Confirmed |
| [FIN-021](#fin-021) | P1                   | `balance_before` read without lock → ledger rows where `before + amount ≠ after`      | neither (audit)               | Confirmed |
| [FIN-022](#fin-022) | P1                   | `looksReset` over-refund guard is disarmed exactly when it is needed                  | platform-loses                | Confirmed |
| [FIN-023](#fin-023) | P1                   | Period change at renewal re-charges the new cycle with the old counter                | user-loses                    | Confirmed |
| [FIN-024](#fin-024) | P1                   | Renewal-lag window lets a member spend a second full cap                              | org-loses                     | Probable  |
| [FIN-025](#fin-025) | P1                   | Top-up destroys remaining trial headroom and bills trial spend against it             | user-loses                    | Confirmed |
| [FIN-026](#fin-026) | P1                   | Generation jobs re-authorize mid-flight → already-paid work is discarded              | user-loses                    | Confirmed |
| [FIN-027](#fin-027) | P1                   | Personal path has no key self-repair and no stale-key validation                      | user blocked                  | Confirmed |
| [FIN-028](#fin-028) | P1                   | `claimRenewalBatch` delete+reinsert is not a CAS → double funding                     | org-loses                     | Probable  |
| [FIN-029](#fin-029) | P1                   | Memory embeddings call the managed policy with no `modelId` → fail closed             | neither (function)            | Probable  |
| [FIN-030](#fin-030) | P2                   | Image models bypass the org allow-list                                                | org-loses                     | Confirmed |
| [FIN-031](#fin-031) | P2                   | `reclaimMemberKey` credits back the peeked amount, not the confirmed one              | platform-loses                | Confirmed |
| [FIN-032](#fin-032) | P2                   | Unique-violation recovery classifies by regex, not SQLSTATE                           | neither                       | Confirmed |
| [FIN-033](#fin-033) | P2                   | Sync vs renewal clobber: no CAS on `settled_usage` writes                             | user-loses                    | Confirmed |
| [FIN-034](#fin-034) | P2                   | Provider-reported cost overrides the multiplier-adjusted cost                         | platform-loses                | Confirmed |
| [FIN-035](#fin-035) | P2                   | Platform financials summed over a capped 200 rows                                     | neither (reporting)           | Confirmed |
| [FIN-036](#fin-036) | P2                   | `runExclusive` is in-process only → key sprawl on multi-instance                      | neither                       | Confirmed |
| [FIN-037](#fin-037) | P3                   | Default model has no pricing; optimistic debit never fires                            | neither (cosmetic)            | Confirmed |
| [FIN-038](#fin-038) | P3                   | FX fallback to env rate is silent and persisted                                       | either                        | Confirmed |
| [FIN-039](#fin-039) | P3                   | Trial wallets structurally display $0 remaining                                       | neither                       | Confirmed |
| [FIN-040](#fin-040) | **test-gap**         | Two existing tests encode the bugs as expected behaviour                              | —                             | Confirmed |

---

## 4. Findings

### <a id="fin-013"></a>FIN-013 · P0 · Manual credit is not idempotent, and a successful credit is reported as a failure

> **FIXED 2026-09-12.** `idempotencyKey` is now required on both `addManualCredit` and `addManualUserCredit`, and both admin forms send one (regenerated whenever the form is edited, so an edited retry cannot resolve to the previous amount). The mutations now split at the commit boundary: failures before the credit commits are reported honestly, while the key push and audit event afterwards are best-effort and can no longer turn a committed credit into a reported failure. A failed key push is retried through a new `sync_user_key` outbox action instead of leaving the wallet funded behind a stale limit. Concurrent submits of one key now resolve to a single credit — which required fixing `isUniqueConstraintViolation` in both models to walk the `cause` chain, since Drizzle wraps driver errors and the SQLSTATE `23505` check was missing them entirely (that also silently broke the existing `activateTrial` usage). Regression tests: `aicoBilling.manualCreditUser.test.ts` (`FIN-013 idempotency`) and `aico.rbacIdor.test.ts` (`FIN-013 a committed credit is never reported as a failure`).

**Invariant:** INV-2, INV-3 · **Category:** silent-money-loss · **Direction:** platform-loses, silent

`addManualUserCredit` and `addManualCredit` both accept an optional `idempotencyKey` ([platformAdmin.ts:439](../../apps/server/src/routers/lambda/platformAdmin.ts:439), [:309](../../apps/server/src/routers/lambda/platformAdmin.ts:309)). **Neither UI call site sends one:**

- [PlatformAdminPanel.tsx:1016-1021](../../src/features/PlatformAdmin/PlatformAdminPanel.tsx:1016) — user credit, no key.
- [PlatformAdminPanel.tsx:956-960](../../src/features/PlatformAdmin/PlatformAdminPanel.tsx:956) — org wallet credit, no key.

So `gateway_ref_id` is written `NULL`, and the unique index from migration `0143` is **partial** (`WHERE gateway_ref_id IS NOT NULL`) — it never fires. The entire FIN-003 idempotency mechanism is dead in production, on both of the platform's money-entry points.

This becomes a live double-credit because of the failure shape:

```ts
const result = await ctx.billingModel.manualCreditUser({ … });   // COMMITS
const keyService = new AicoOpenRouterKeyService(ctx.serverDB);
await keyService.ensureUserKey(userId);                          // platformAdmin.ts:476 — can throw
```

`ensureUserKey` rethrows any `updateKey` error that is not a 403/404 ([keyService.ts:185](../../apps/server/src/services/openrouter/keyService.ts:185)). The handler's blanket catch ([platformAdmin.ts:507-512](../../apps/server/src/routers/lambda/platformAdmin.ts:507)) converts it to `BAD_REQUEST`, and the UI shows `platform.userCreditFailed`. **The admin sees "failed" over a wallet that was funded.** They retry. Both `balance_micro_usd` and `raw_capacity_micro_usd` are incremented a second time — so the OpenRouter key limit doubles too.

**Money formula:** loss = credited amount × (retries − 1), delivered as real spendable upstream capacity.
**Trigger:** any OpenRouter 5xx/timeout during an admin credit, followed by the natural retry.
**Contrast:** where the key is _required_ (`allocateMemberCredit`, both sweeps), the UI does pass one — e.g. [OrgAdminMembers.tsx:652](../../src/features/OrgAdmin/OrgAdminMembers.tsx:652). The optionality is the whole bug.

**Fix:** generate a `crypto.randomUUID()` per form submission (stable across retries of that submit), make `idempotencyKey` required server-side, and stop reporting a committed credit as a failure (see FIN-019).
**Test:** credit twice with the same key → one transaction, one increment. Credit twice with `ensureUserKey` stubbed to throw → still one increment.

---

### <a id="fin-014"></a>FIN-014 · P0 · Lifetime-usage fallback corrupts the period checkpoint and inflates the key limit

> **FIXED 2026-09-12.** `rawMeteredUsageMicro` now returns `null` when a period-scoped budget has no matching OpenRouter period counter, and `isPeriodScopedBudget` (new, in `aicoMoney.ts`) makes the `total`-vs-period distinction explicit — lifetime `usage` remains correct for a `total` budget, which has no `limit_reset`. When the counter is unknown the checkpoint rebase is skipped entirely (holding the old baseline _and_ its rate, since usage is still expressed in it) rather than stamping the baseline with a lifetime figure, so the key limit can no longer exceed the funded cap. `peekMemberRemaining` falls back to the last settled figure instead of over-stating usage and under-refunding the org. The degraded state is now recorded in `member_budgets.last_sync_status` / `last_sync_error` — columns that existed but were never written by anything. Regression tests: `aico.keyFailureInjection.test.ts` (`FIN-014 a missing period counter must never fall back to lifetime usage`).

**Invariant:** INV-4 · **Category:** enforcement-bypass · **Direction:** platform/org-loses **and** user blocked, silent

[keyService.ts:117-126](../../apps/server/src/services/openrouter/keyService.ts:117):

```ts
const source = periodUsageUsd ?? info.usage ?? 0; // :125
```

The comment directly above it ([:101-107](../../apps/server/src/services/openrouter/keyService.ts:101)) states that using lifetime `info.usage` for a period-scoped key "would leave the baseline and the metered value in different units and corrupt every subsequent conversion." Line 125 does it anyway.

The period counters are **genuinely nullable** — [createKeyResponse.ts:25-27](../../apps/server/src/services/openrouter/createKeyResponse.ts:25) maps `data.usage_daily == null ? null : …`, so any OpenRouter response omitting them (older key shapes, keys created before a `limit_reset` was set, partial payloads) hits the fallback.

**Trace** — daily budget, $10 cap, M = 1.2, lifetime `info.usage` = $500, `usage_daily` absent:

1. `syncMemberCheckpoint` sees the platform bp changed → `rebaseCheckpoint({ rawUsage: 500_000_000 })`.
2. `usage_baseline_micro_usd := 500_000_000`; `billed_usage_before_baseline := billedBefore + 500e6 × M`. No clamp to the cycle cap.
3. Next `ensureMemberKey` → `keyLimitFromBilled` → `headroom = max(0, 10e6 − 600e6) = 0` → `limit = baselineRaw = 500_000_000`. **A $500 lifetime-raw limit is pushed against a $10/day funded cap.**
4. Simultaneously `computeCycleUsageFromKeyInfo` returns `usage = cap` → the member is _blocked_ in the UI while their key would allow 50× the cap.

**Money formula:** excess headroom = lifetime raw usage − funded cycle cap, unbounded above by anything in our system.
**Fix:** `rawMeteredUsageMicro` must return `null` when the period counter is missing for a period-scoped budget, and callers must skip the rebase/settle rather than substituting lifetime usage. Only `period === 'total'` may read `info.usage`.
**Test:** table-driven over `{period, usageDaily|Weekly|Monthly present/absent}` asserting the pushed `limitUsd` never exceeds `currentCycleLimitMicroUsd / M`.

---

### <a id="fin-015"></a>FIN-015 · P0 · Freeze strands funds, retains capacity, and a later credit grants that capacity for free

> **FIXED 2026-09-12.** Freeze and unfreeze are now a ledgered pair on `AicoBillingModel`. `freezePersonalWallet` parks the balance **and** the capacity it bought (new `user_wallets.frozen_raw_capacity_micro_usd`, migration `0149`, which also backfills wallets already frozen under the old behaviour) and writes the `personal_freeze` row that was declared in the type enum but never written. `unfreezePersonalWallet` restores both and writes a new `personal_unfreeze` row; `reactivateUser` now calls it, so a reactivated user gets their money and a working key instead of an empty wallet. `manualCreditUser` no longer flips `isActive` back on — crediting a disabled wallet is refused with `WALLET_INACTIVE`, so resurrecting an account is an explicit, auditable step. Both ledger rows satisfy INV-6 (`balance_after − balance_before == amount`, negative on the freeze). Regression tests: `aicoBilling.freezeWallet.test.ts`.

**Invariant:** INV-1, INV-2, INV-3 · **Category:** silent-money-loss, ledger-integrity · **Direction:** both, silent

[softDelete.ts:72-80](../../apps/server/src/services/aico/softDelete.ts:72) moves the whole balance into `frozen_micro_usd` and sets `is_active: false`. Three distinct defects compound:

**(a) `frozen_micro_usd` is a one-way trapdoor.** It has exactly **one writer in the entire codebase** — this line. There is no unfreeze path anywhere. `reactivateUser` ([platformAdmin.ts:766](../../apps/server/src/routers/lambda/platformAdmin.ts:766)) un-bans the user and sets `is_active: true`, then calls `ensureUserKey` — but `balance_micro_usd` is still 0, so `disabled: balanceMicro <= 0` is `true` and the key stays dead. The user is "reactivated" with zero spendable money and no recovery path. _Direction: user-loses._

**(b) The freeze is unledgered.** No `wallet_transactions` row is written. `personal_freeze` is declared in the type enum ([aicoOrganization.ts:423](../../packages/database/src/schemas/aicoOrganization.ts:423)) and **never written anywhere in the repo.** There is no record of when or why the money moved.

**(c) Capacity survives the freeze and is re-granted.** `raw_capacity_micro_usd` is untouched by the freeze. `manualCreditUser` increments it _and_ sets `is_active: true` ([aicoBilling.ts:185-186](../../packages/database/src/models/aicoBilling.ts:185)) — silently reactivating a deleted account's wallet, bypassing `reactivateUser` entirely. After the credit:

- `balance` = new credit only
- `raw_capacity` = pre-freeze capacity **+** new capacity
- `ensureUserKey` pushes the inflated capacity as the key limit

The user can spend the pre-freeze capacity again without paying for it. `blendedMultiplierBp = balance / capacity` is also depressed, so `billedUsageFromCapacity` under-bills and `remaining` reads healthier than it is.

**Money formula:** free upstream capacity = pre-freeze `raw_capacity_micro_usd` − raw already spent.
**Fix:** write a `personal_freeze` ledger row; zero or quarantine `raw_capacity_micro_usd` alongside the balance; add an explicit unfreeze that restores both; and stop `manualCreditUser` from silently flipping `is_active`.
**Test:** freeze → credit → assert pushed `limitUsd` equals only the newly purchased capacity. Freeze → assert a ledger row exists. Freeze → reactivate → assert funds are spendable.

---

### <a id="fin-016"></a>FIN-016 · P1 · The wallet UI shows cumulative deposits, not remaining — and Toman has no `remaining` at all

**Invariant:** INV-8 · **Category:** ux-truthfulness · **Direction:** neither (but destroys user trust), silent
**This is the most likely direct explanation of the reported incident.**

[AicoWallet/index.tsx:116-125](../../src/features/AicoWallet/index.tsx:116):

```tsx
<StatisticCard
  title={t('wallet.balanceUsd')}
  statistic={{ value: `$${Number(personalRemainingUsd ?? wallet?.balanceUsd ?? 0).toFixed(4)}` }}
/>
<StatisticCard
  statistic={{ value: Number(wallet?.balanceToman ?? 0).toLocaleString() }}
  title={t('wallet.balanceToman')}
/>
```

Two problems:

1. **The Toman card has no `remaining` counterpart at any layer.** `getMyBillingSources` returns `remainingMicroUsd`/`remainingUsd` only — there is no Toman equivalent anywhere in the pipeline. The Toman figure is `balance_toman`, pure cumulative deposits, and **it is structurally incapable of ever decreasing.** For the fa-IR primary user base this is the natural "my credit" number.
2. **The USD card silently falls back to raw balance.** When `personalRemainingUsd` is undefined — which is exactly what happens under FIN-018 — it renders `wallet.balanceUsd` under a label that reads as spendable credit. This is a _third_ fallback stacked on the two in FIN-018.

A user who tops up 500,000 Toman, spends $0.40, and looks at their wallet sees 500,000 Toman. Forever. Nothing is broken in the accounting; the number they are shown was never connected to spend.

**Fix:** derive and return a Toman `remaining` (`remainingMicroUsd × fxRate`), label the cumulative figures explicitly as "total paid", and remove the `?? wallet?.balanceUsd` fallback in favour of an explicit unknown state (see FIN-018).
**Test:** assert no component renders `balanceToman`/`balanceUsd` under a "credit"/"remaining" label.

---

### <a id="fin-017"></a>FIN-017 · P1 · `usage_logs` records hardcoded zeros, fire-and-forget, and is never settled

**Invariant:** INV-7 · **Category:** reporting-accuracy · **Direction:** neither (bounded upstream), silent

[route.ts:69-79](<../../src/app/(backend)/webapi/chat/[provider]/route.ts:69>) writes every chat's usage row as:

```ts
completionTokens: 0, costMicroUsd: 0, promptTokens: 0, totalTokens: 0,
```

Three compounding issues:

- **Zeros by construction.** No code path in the repo ever writes a non-zero `cost_micro_usd`. Platform revenue reporting (`sumUsageCostMicroUsd` → [platformAdmin.ts:620](../../apps/server/src/routers/lambda/platformAdmin.ts:620)) therefore reports total platform cost = $0.
- **Fire-and-forget after the response.** [route.ts:137](<../../src/app/(backend)/webapi/chat/[provider]/route.ts:137>) is `void recordManagedUsage(…).catch(console.error)`, fired after `modelRuntime.chat()` resolves — which is at **stream start**, not stream end, so no token data exists yet anyway. On a serverless host the detached promise can be killed by freeze-on-response, losing the row entirely.
- **No settlement job.** `settlement_status` defaults `'pending'` and is never advanced. The crons under `api/aico/cron/` are renewals, key-outbox and model-sync only.

The richer hook that _does_ accept real costs — `AicoChatGuard.afterManagedChat` ([chatGuard.ts:110-162](../../apps/server/src/services/aico/chatGuard.ts:110)) — is **dead code**, never instantiated outside tests. Generation paths (image/video) never call `recordUsage` at all.

**Why P1 and not P0:** OpenRouter's key limit still caps the spend, so no money is lost — but we cannot bill, refund, dispute, attribute per model/user, or detect any of the P0s above. The `−1 upstream guard` modifier applies; the guard is the key limit.
**Fix:** this is the finding the planned in-app metering rewrite subsumes. Run it in the stream's `onFinish`/`waitUntil`, never a detached promise.

---

### <a id="fin-018"></a>FIN-018 · P1 · `getUserRemaining` swallows every failure and returns the full balance, with no log

**Invariant:** INV-8 · **Category:** ux-truthfulness, config-fragility · **Direction:** neither, **silent to users and operators alike**

[keyService.ts:586-588](../../apps/server/src/services/openrouter/keyService.ts:586):

```ts
} catch {
  return { remainingMicroUsd: Math.max(0, balanceMicroUsd), usageMicroUsd: null };
}
```

There are **five distinct ways** `remaining` can equal the full balance while real spend exists, and every one is indistinguishable from "you have spent nothing":

| #   | Path                                                     | Location                 |
| --- | -------------------------------------------------------- | ------------------------ |
| a   | Bare catch — any OpenRouter error                        | `keyService.ts:586`      |
| b   | The caller swallows it again, same fallback              | `aicoBilling.ts:107-111` |
| c   | `isStaleManagedKeyId` short-circuit on `mock_` hashes    | `keyService.ts:563`      |
| d   | `MockOpenRouterManagementClient` returns usage 0 forever | `management.ts:183-203`  |
| e   | OpenRouter usage-propagation lag                         | —                        |

**Nothing logs when (a) fires.** This failure is currently unmeasurable in production, which makes adding a log the prerequisite to every other recommendation in this report.

The org path is strictly better here and shows the fix: it _persists_ the derived value into `settled_usage_micro_usd` and records `last_sync_status` / `last_sync_error`. The personal path has neither.

Note the config landmine behind (d): `createOpenRouterManagementClient` ([management.ts:241-294](../../apps/server/src/services/openrouter/management.ts:241)) **throws by design** when `OPENROUTER_MANAGEMENT_API_KEY` is set on a non-control-plane process — which is exactly the shape of this repo's local `.env`. That throw lands in the bare catch. Verify whether production shares it (§5).

**Fix:** add a `usageKnown: false` / `stale: true` discriminator to the response and render an explicit unknown state. Costs nothing; converts five silent failures into one visible one. Persist the derived value and a sync status on the personal wallet as the org path already does.

---

### <a id="fin-019"></a>FIN-019 · P1 · Key push runs outside the credit transaction with no outbox retry

**Invariant:** INV-1, INV-4 · **Direction:** user wrongly blocked; org-loses on an allocation decrease

Two instances of the same shape:

- **Personal:** [platformAdmin.ts:475-476](../../apps/server/src/routers/lambda/platformAdmin.ts:475) — credit commits, then `ensureUserKey`.
- **Org:** [organization.ts:851-860](../../apps/server/src/routers/lambda/organization.ts:851) — allocation commits (wallet debited/credited, `periodAmountMicroUsd` updated), then `ensureMemberKey`.

`ensureUserKey` rethrows non-403/404 failures ([keyService.ts:185](../../apps/server/src/services/openrouter/keyService.ts:185)) and **nothing is enqueued.** The outbox implements only `disable_member_key`, `disable_user_key` and `reclaim_member` ([renewalScheduler.ts:535-569](../../apps/server/src/services/aico/renewalScheduler.ts:535)) — there is no `ensure_user_key` / `ensure_member_key` limit-push action at all.

There is also no self-healing: repo-wide, `ensureUserKey`'s only callers are `platformAdmin.ts:476` and `:771`. No request path calls it. So a funded wallet whose key push failed stays capped at its stale limit until an operator manually re-runs the admin action.

On an allocation **decrease** the direction inverts: the org wallet has already been credited back while the member's key still carries the old higher limit — the member can outspend the reduced cap.

**Fix:** enqueue a `sync_user_key` / `ensure_member_key` outbox action inside the same transaction as the money move, and stop surfacing a committed credit as a failure (this is half of FIN-013's trigger).

---

### <a id="fin-020"></a>FIN-020 · P1 · `computeCycleUsageFromKeyInfo` writes lifetime usage, contradicting its own docstring

> **FIXED 2026-09-12** alongside FIN-014 — same root cause, same commit. The final `else` now holds the last settled figure for a period-scoped budget and reads lifetime `info.usage` only for a `total` budget.

**Direction:** user-loses, silent · [keyService.ts:499-503](../../apps/server/src/services/openrouter/keyService.ts:499)

The docstring at `:418-420` says "Never writes lifetime `info.usage` into `settledUsageMicroUsd`." The final `else` branch does exactly that. Reached when `limitRemaining == null` **and** the period counter is null.

`usage = min(currentCycle, lifetimeRaw × M)` — for any key older than one cycle this saturates at `currentCycle`, so `cycleRemaining = 0` → `MEMBER_BUDGET_UNFUNDED`, and at renewal the refund is computed as zero unused.

**Fix:** when neither `limit_remaining` nor the period counter is available for a period-scoped budget, leave `settled_usage` untouched and record a sync failure instead of guessing.

---

### <a id="fin-021"></a>FIN-021 · P1 · `balance_before` is read without a lock → ledger rows where `before + amount ≠ after`

**Invariant:** INV-6 · **Direction:** neither (stored balances are correct), silent
[aicoBilling.ts:168-199](../../packages/database/src/models/aicoBilling.ts:168); same shape at [organization.ts:1536-1560](../../packages/database/src/models/organization.ts:1536)

`balance_before` comes from a plain `findFirst` with no `FOR UPDATE`, while `balance_after` comes from the atomic `RETURNING`. Under READ COMMITTED, two concurrent credits to one wallet both snapshot `before = X`. Tx1 commits `after = X+a`. Tx2's `UPDATE` blocks, re-reads on unblock, returns `X+a+b` — writing `{before: X, amount: b, after: X+a+b}`. **`before + amount ≠ after` within a single row**, not merely a broken chain. An auditor reconstructing balances gets a wrong answer with no way to tell which row is at fault.

The org reclaim is _more_ exposed — sweep is sequential per org, but a concurrent member-removal outbox reclaim or `allocateMemberCredit` hits the same org row.

**Fix:** `SELECT … FOR UPDATE` on the wallet row, or simply derive `balanceBefore = balanceAfter − amount` from the `RETURNING` value.

---

### <a id="fin-022"></a>FIN-022 · P1 · The over-refund guard is disarmed exactly when it is needed

**Direction:** platform/org-loses, silent · [keyService.ts:475-481](../../apps/server/src/services/openrouter/keyService.ts:475)

`looksReset` is gated on `priorSettled > 0` — a _cached projection_. Branch table for `computeCycleUsageFromKeyInfo`:

| #      | State                                            | Result                                                                                                                         | Direction          |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| a1     | OR reset, Aico not renewed, `priorSettled > 0`   | correct                                                                                                                        | neither            |
| **a2** | **same but `priorSettled == 0`**                 | `remaining = full cap`, `usage = 0` → renewal refunds the **whole cap** for a fully spent cycle                                | **platform-loses** |
| b      | Aico renewed, OR counter not yet reset           | stale prior-cycle usage charged to the new cycle                                                                               | user-loses         |
| c      | `limitRemaining == null`, period counter present | correct                                                                                                                        | neither            |
| d      | both null                                        | lifetime usage (FIN-020)                                                                                                       | user-loses         |
| e      | multiplier _decreased_ mid-cycle                 | clause 1 can't fire (`periodUsageMicro` has `billedBefore` baked in); clause 2's threshold drops below 0.95×cap → guard misses | platform-loses     |

`priorSettled` is written by `syncMemberCycleUsage`, which runs per-request — but via `.catch(() => null)` ([chatGuard.ts:141](../../apps/server/src/services/aico/chatGuard.ts:141)). Any cycle where that sync failed leaves the guard disarmed.

**Fix:** drive the reset decision off `currentPeriodStart` vs OpenRouter's reset semantics (both UTC-aligned, see `periodBoundaries.ts`) rather than a heuristic over a cached number, and floor settled usage at `priorSettled` unconditionally at settlement time.

---

### <a id="fin-023"></a>FIN-023 · P1 · Period change at renewal re-charges the new cycle with the previous counter

**Direction:** user/org-loses, silent, deterministic · [renewalScheduler.ts:363-373](../../apps/server/src/services/aico/renewalScheduler.ts:363)

Renewal sets `period := nextPeriod` **and** zeroes the baseline, `billed_usage_before_baseline` and `settled_usage`. On a `daily → monthly` switch mid-month, the next sync reads `info.usageMonthly` — which already contains the whole month's spend made under the daily cycles — against a zero baseline. `settled_usage` jumps to `min(cap, monthToDate × M)`, and `ensureMemberKey` has already pushed `limit = cap/M` on a monthly-reset key whose counter is that same month-to-date. Real headroom is `cap/M − monthToDate`.

**Fix:** when the period changes, stamp the baseline with the _new_ period counter read from OpenRouter at renewal time instead of 0 — or recreate the key so the counter is genuinely fresh.

---

### <a id="fin-024"></a>FIN-024 · P1 · Renewal-lag window lets a member spend a second full cap

**Direction:** org-loses, silent, bounded by cap × cron latency · **Confidence: Probable**

OpenRouter resets the period counter at the UTC boundary; Aico renews when the cron next runs ([renewalScheduler.ts:94](../../apps/server/src/services/aico/renewalScheduler.ts:94)). In that window the member's key is still **enabled** (it is only disabled at `:219-232`, once renewal starts) carrying the closing cycle's limit, while OpenRouter's counter reads 0. The member can spend a second full cap that the org wallet was never debited for. The subsequent settle then lands in case a1/a2 above.

**Fix:** compute the OpenRouter limit against the _next_ boundary, or treat post-boundary spend as chargeable to the new cycle via an explicit baseline read.

---

### <a id="fin-025"></a>FIN-025 · P1 · Top-up destroys remaining trial headroom and bills trial spend against purchased capacity

**Direction:** user-loses, silent · [keyService.ts:158-199](../../apps/server/src/services/openrouter/keyService.ts:158)

`ensureTrialKey` funds the **OpenRouter key only**, crediting nothing — a trial user has `balance = 0`, `raw_capacity = 0`, and a real key with a real limit. The trial key is stored in `wallet.openrouter_key_id`, so the first top-up takes `ensureUserKey`'s update branch and overwrites the trial limit with `raw_capacity_micro_usd` alone.

Two losses, both to the user, both silent:

1. **Remaining trial headroom is destroyed at the moment of payment.**
2. **OpenRouter's `usage` is lifetime.** Trial spend already on that counter now counts against the newly-set purchased limit. A user who burned $0.40 of a $1 trial and then buys $5 of capacity gets $4.60 of usable spend.

The read side is consistently wrong in the same direction: `billedUsageFromCapacity` receives `info.usage` (including trial consumption) against a `balance` that excludes it.

It can never _increase_ the limit beyond what was paid — `limitMicro` is `raw_capacity` alone, which only grows inside the credit transaction. No free-capacity path exists here.

**Fix:** record the trial grant as capacity (a `trial_raw_capacity_micro_usd` column, or credit capacity at activation with a non-monetary balance marker) and compute `limitUsd = trialCapacity + rawCapacity`.

---

### <a id="fin-026"></a>FIN-026 · P1 · Generation jobs re-authorize mid-flight and discard already-paid work

**Direction:** user-loses, silent · [videoBackgroundPolling.ts:74-77](../../apps/server/src/services/generation/videoBackgroundPolling.ts:74), [async/image.ts:166-175](../../apps/server/src/routers/async/image.ts:166)

The poller re-runs `initModelRuntimeFromDB` → full `authorize` **after** the job was already submitted upstream. `authorize` rejects on `cycleRemaining <= 0`, `!wallet.isActive`, renewal-pending, or `balance <= 0`. The upstream spend has already happened; the poll then fails and marks the task `Error`. **The user paid for a video and gets an error.**

Trigger: a budget/period boundary crossed mid-job, a member deactivated, or the generation itself consuming the last of the cycle cap.

Also note `prechargeResult` is declared in `BackgroundPollingParams` ([videoBackgroundPolling.ts:39](../../apps/server/src/services/generation/videoBackgroundPolling.ts:39)) and never used — inert today because precharge is stubbed, but a live landmine if that stub is implemented.

**Fix:** on the completion/poll path use decrypt-only key resolution with no funds/allow-list gate. Authorization belongs at submission, not at collection.

---

### <a id="fin-027"></a>FIN-027 · P1 · Personal path has no key self-repair and no stale-key validation

**Direction:** funded user wrongly blocked, silent · [managedPolicy.ts:119](../../apps/server/src/services/aico/managedPolicy.ts:119)

The org path validates with `hasValidManagedKeyId` (`:179`, `:190`) and **repairs inline** via `ensureMemberKey` (`:178-187`). The personal path does neither — `:119` is a bare truthiness check.

Consequences: a `mock_`-prefixed key passes the gate, is decrypted, and is sent upstream as a real API key. Meanwhile `ensureUserKey` and `getUserRemaining` _do_ apply `isStaleManagedKeyId`, so `getUserRemaining` reports the full balance as spendable for a key `authorize` will then fail on — a confusing upstream 401 instead of a clean `MANAGED_KEY_UNAVAILABLE`. A wallet whose key creation failed stays unusable until a platform admin intervenes.

`chatGuard.ts:137` has the same truthiness bug when selecting an org billing context.

**Fix:** use `hasValidManagedKeyId` at both sites and give the personal branch the same repair fallback the org branch has.

---

### <a id="fin-028"></a>FIN-028 · P1 · `claimRenewalBatch` delete+reinsert is not a CAS

**Direction:** org-loses, silent · **Confidence: Probable** · [renewalScheduler.ts:154-167](../../apps/server/src/services/aico/renewalScheduler.ts:154)

```ts
if (existing.status !== 'failed') return null;
await db.delete(aicoRenewalBatches).where(eq(aicoRenewalBatches.id, existing.id));
batch = await tryInsert();
```

Delete-then-reinsert is not atomic. Two workers can both end up holding a non-null `batch` for the same logical period and both run `renewOrg`'s funding transaction — **double `period_refund` credit and double `grossRequired` debit**, recorded under distinct `renewal_batch_id`s so neither looks anomalous.

Secondary: `batchKey` derives from `Math.min(nextRenewalAt)` across whatever budget set the worker happened to load (`:181-184`). A budget crossing its boundary between two workers' `SELECT`s yields two different `batchKey`s covering overlapping members — the unique index does not protect that at all.

**Fix:** replace with a conditional `UPDATE … SET status='pending' WHERE batch_key = … AND status='failed' RETURNING` (a real CAS), and derive `batchKey` from the computed period boundary rather than the observed minimum.

---

### <a id="fin-029"></a>FIN-029 · P1 · Memory embeddings call the managed policy with no `modelId`

**Direction:** neither (money), user-loses (function) · **Confidence: Probable** · [userMemories.ts:134](../../apps/server/src/routers/lambda/userMemories.ts:134), `:183`

`initModelRuntimeFromDB(…, { billingContext })` is called with no `modelId`. When the provider resolves to the managed one, `authorize` throws `MODEL_ID_REQUIRED` ([managedPolicy.ts:102](../../apps/server/src/services/aico/managedPolicy.ts:102)). A fully funded user gets memory search/indexing failing closed.

**Fix:** pass the embedding model id as `modelId`.

---

### <a id="fin-030"></a>FIN-030 · P2 · Image models bypass the org allow-list

**Direction:** org-loses, silent, bounded by the member cap · [generationBilling.ts:13-14](../../apps/server/src/services/aico/generationBilling.ts:13)

`toManagedGenerationModelId` strips `:image` before `authorize`, but the runtime is invoked with the **unstripped** id — so `<allowed-chat-model>:image` passes the allow-list as `<allowed-chat-model>` while a different upstream id actually bills. More materially, `assertModelAllowed` bypasses the org allow-list outright for `isDefaultAutoImageModelId` and `OPENROUTER_AUTO_MODEL_ID` ([managedPolicy.ts:220-226](../../apps/server/src/services/aico/managedPolicy.ts:220)) — deliberate and documented, but it means **an org admin cannot prevent image spend on the org wallet.**

**Fix:** authorize and invoke on the same id; make the default-image bypass an org-level toggle.

---

### <a id="fin-031"></a>FIN-031 · P2 · `reclaimMemberKey` credits back the peeked amount, not the confirmed one

**Direction:** platform-loses, silent, bounded by one round-trip of streaming spend · [keyService.ts:405-412](../../apps/server/src/services/openrouter/keyService.ts:405)

`peekMemberRemaining` then `updateKey({disabled: true})` are two round-trips; the returned figure is the **peeked** one, never re-read. A member spending in the gap has that spend credited back to the org wallet — the platform already paid OpenRouter for it.

This is _not_ the same class as `ac32177188`: the sweep's `executeOrgBudgetSweep` correctly re-reads via `reclaimMemberKey` rather than reusing the preview figure.

**Fix:** re-`getKey` after the disable and take `min(peeked, confirmed)`.

---

### <a id="fin-032"></a>FIN-032 · P2 · Unique-violation recovery classifies by regex, not SQLSTATE

[aicoBilling.ts:214-220](../../packages/database/src/models/aicoBilling.ts:214), duplicated at [organization.ts:1452](../../packages/database/src/models/organization.ts:1452)

```ts
if (params.idempotencyKey && /gateway_ref|unique|duplicate/i.test(message)) {
```

`isUniqueConstraintViolation` (SQLSTATE `23505`) exists at [aicoBilling.ts:80](../../packages/database/src/models/aicoBilling.ts:80) and _is_ used correctly in `activateTrial` — but not here. Two defects: any unrelated failure whose text contains "duplicate" is masked as an idempotency conflict; and even on a true hit it **throws instead of returning the existing transaction**, so the check-then-act pre-check at `:149-160` is the only genuinely idempotent path. Moot today given FIN-013.

---

### <a id="fin-033"></a>FIN-033 · P2 · Sync vs renewal clobber — no CAS on `settled_usage` writes

[keyService.ts:596-613](../../apps/server/src/services/openrouter/keyService.ts:596), [organization.ts:1596-1625](../../packages/database/src/models/organization.ts:1596)

`runExclusive` covers only `ensureUserKey`/`ensureMemberKey`, not the sync/settle path, and both writes are bare `UPDATE … WHERE org_member_id = …`. Concurrent syncs do _not_ double-apply a rebase (`rebaseCheckpoint` is idempotent under a shared input). The real race is **sync vs renewal**: a sync that read the budget before renewal commits will write the closing cycle's `settled_usage` and baseline back over the freshly zeroed row — producing FIN-014/FIN-020-shaped damage.

**Fix:** add `WHERE current_period_start = <value read>` (or a version column) to both writes, and run member syncs under `runExclusive`.

---

### <a id="fin-034"></a>FIN-034 · P2 · Provider-reported cost overrides the multiplier-adjusted cost

**Direction: platform-loses (undercharge), not overcharge** — the direction determines who would be refunded, so it matters. [usageConverters/openai.ts:60-67](../../packages/model-runtime/src/core/usageConverters/openai.ts:60)

`withPricingOrProviderCost` lets the provider's **raw** cost override the multiplier-adjusted computed cost. If `usage.cost` ever does arrive, the figure shown (and optimistically debited) is the un-marked-up ≈0.83× number, inconsistent with `resolveManagedPricingContext`.

---

### <a id="fin-035"></a>FIN-035 · P2 · Platform financials summed over a capped 200 rows

[platformAdmin.ts:620-635](../../apps/server/src/routers/lambda/platformAdmin.ts:620), [aicoBilling.ts:565](../../packages/database/src/models/aicoBilling.ts:565) — "total revenue" sums `listRecentTransactions(200)` and B2C balance sums `listAllWallets()` capped at 200. Both silently under-report once the platform exceeds 200 rows. **Fix:** aggregate in SQL.

---

### <a id="fin-036"></a>FIN-036 · P2 · `runExclusive` is in-process only

[keyService.ts:27-36](../../apps/server/src/services/openrouter/keyService.ts:27) is a per-process `Map`. On ≥2 instances, concurrent `ensureUserKey` can create two OpenRouter keys; the second `updateUserOpenRouterKey` overwrites the first's ciphertext.

**Downgraded from the initial P0 suspicion.** The orphan's plaintext is never returned to a caller, so it cannot be spent — this is untracked key sprawl and an uncleaned limit, not a spend leak. `createAndPersistUserKey` ([keyService.ts:324-335](../../apps/server/src/services/openrouter/keyService.ts:324)) _does_ correctly retire the orphan on persist failure.

**Fix:** `pg_advisory_xact_lock` keyed on the wallet.

---

### <a id="fin-037"></a>FIN-037 · P3 · Default model has no pricing; the optimistic debit never fires

**Cosmetic by design** — the 1500 ms revalidate is the real path, so this cannot alone explain a _persistent_ no-change. Graded P3 deliberately so triage does not over-fund it.

`openrouter/auto` — the product's default meta-router — has **no `pricing` block** ([openrouter.ts:10-17](../../packages/model-bank/src/aiModels/openrouter.ts:10)); only 39 of 41 static entries have one, while the served catalog syncs hundreds of models from OpenRouter and pricing lookup reads only the _static_ bank. The OpenRouter chat payload also never sets `usage: {include: true}` (unlike `createImage.ts:350`). So `usage.cost` is `undefined` → [refreshAicoBillingBalance.ts:64](../../src/features/AicoBilling/refreshAicoBillingBalance.ts:64) skips the debit.

Adding `usage: {include: true}` is a near-free prerequisite for the metering rewrite and should be called out as such.

---

### <a id="fin-038"></a>FIN-038 · P3 · FX fallback to the env rate is silent and persisted

[fxService.ts:72-74](../../apps/server/src/services/aico/fxService.ts:72) falls back to `AICO_TOMAN_PER_USD` with no log. Bounded: admin credit passes `fxConfig.tomanPerUsd` and short-circuits on a positive admin rate, so only callers with no admin rate are affected. Where it applies, the wrong rate is **persisted** on the transaction row — not merely displayed. **Fix:** log/alert on the `env` fallback.

---

### <a id="fin-039"></a>FIN-039 · P3 · Trial wallets structurally display $0 remaining

With `balance = 0`, [keyService.ts:582](../../apps/server/src/services/openrouter/keyService.ts:582) returns `max(0, 0 − usage) = 0` regardless of real headroom. Does **not** block the user — `getBillingChatBlockReason` and `authorize` both have a `trialActive` escape. Cosmetic. **Fix:** surface `limit_remaining` when `trialActive && rawCapacity === 0`.

---

### <a id="fin-040"></a>FIN-040 · test-gap · Two existing tests encode the bugs as expected behaviour

This is a finding in its own right: these tests will not fail when the bugs are fixed, and one of them actively documents the gap as intended.

- [aico.multiOrgMigration.test.ts:177](../../packages/database/src/models/__tests__/aico.multiOrgMigration.test.ts:177) — `'AICO-P1-015: recordUsage can write rows but chat path does not call it'`.
- [aico.chatBypassProduction.test.ts:82-89](../../apps/server/src/services/aico/aico.chatBypassProduction.test.ts:82) — asserts the route's **source text** contains `recordUsage`. It passes today even though the route writes hardcoded zeros. A grep-level assertion, not a behavioural one.

**Coverage gaps.** `computeCycleUsageFromKeyInfo` has exactly one test ([aico.keyFailureInjection.test.ts:424-467](../../apps/server/src/services/openrouter/aico.keyFailureInjection.test.ts:424)) covering one branch. Nothing in the repo references `looksReset`. Nothing covers null period counters, `limitRemaining == null`, or the rebase path end-to-end. `renewalScheduler.test.ts:121` stubs `settleMemberPeriod` outright, so the settle→refund seam is untested by construction. No tests exist for `billingContext.ts`, the cached `usageMultiplier.ts` wrapper, `resolveTopupAmount.ts`, or any `aicoBilling`/`platformAdmin` router procedure.

---

## 5. Production diagnostics — run these first

Read-only. Run as a read-only role against a replica where possible.

```bash
DATABASE_URL=... bunx tsx scripts/aico/financialReconcile.ts --user=<userId>
```

That covers INV-2, INV-3, INV-6, INV-7 plus the mock-key and zero-capacity screens. Add `--with-openrouter` (control plane only) for INV-1 and the unattributed-spend figure.

**Then answer, in order:**

1. **Does a `usage_logs` row exist for the reported timestamp?** If **no row at all**, the detached `void` promise was dropped — that is a bigger finding than anything else here and changes the metering design (it must run in `onFinish`/`waitUntil`).
2. **Is `openrouter_key_id` NULL or `mock_`-prefixed?** Cheapest smoking gun. Note a `mock_` key cannot authenticate to OpenRouter, so if the chat _succeeded_, the key was real.
3. **Does `getMyBillingSources` return a `remaining` that differs from `balance` by ≈ $0.40 × M?** If yes, the accounting is correct and this is FIN-016 — the user was reading a cumulative figure.
4. **Which currency card was the user looking at?** If Toman: FIN-016 explains it completely and by construction.

**Config checks:** which of `OPENROUTER_MANAGEMENT_API_KEY` / `AICO_CONTROL_PLANE_URL` / `AICO_CONTROL_PLANE_SERVICE_TOKEN` / `AICO_IS_CONTROL_PLANE` / `AICO_OPENROUTER_MOCK` are set on **each** deployed process; `NODE_ENV`; and confirm migration `0148` actually ran (`drizzle.__drizzle_migrations`).

**Logs to grep:** `[aico] post-chat usage recording failed`, `user OpenRouter key update failed; recreating`, `failed to disable stale OpenRouter key`. And the absence-signal — if nothing logs _and_ rows are missing, suspect the dropped promise. Remember FIN-018: the most likely failure currently emits nothing at all.

---

## 6. Remediation sequencing

Ordered by (risk reduced ÷ effort). Findings **subsumed** by the metering rewrite are marked so triage does not fund them twice.

**Stage 0 — make the system observable (hours, no behaviour change).**
Log the bare catch at `keyService.ts:586` and the caller at `aicoBilling.ts:107`. Add the `usageKnown` discriminator. **Nothing else in this list can be measured until this lands.**

**Stage 1 — stop the confirmed P0s (days).**
FIN-013 (require the idempotency key; stop reporting committed credits as failures) · FIN-014 (null-out the lifetime fallback) · FIN-015 (ledger the freeze, quarantine capacity, add unfreeze).

**Stage 2 — restore truthfulness (days).**
FIN-016 (Toman `remaining`, relabel cumulative figures) · FIN-018 (persist derived usage + sync status on the personal wallet, mirroring the org path) · FIN-027 (`hasValidManagedKeyId` + personal self-repair).

**Stage 3 — durability of the money moves (1–2 weeks).**
FIN-019 (outbox action for the key push) · FIN-021 (`FOR UPDATE`) · FIN-028 (real CAS) · FIN-033 (CAS on sync writes) · FIN-032.

**Stage 4 — org cycle correctness (1–2 weeks).**
FIN-020, FIN-022, FIN-023, FIN-024, FIN-031 — and the table-driven branch tests from FIN-040 **first**, since every one of these is a behaviour change to code with no coverage.

**Stage 5 — in-app metering rewrite** (the direction already chosen).
_Subsumes_ FIN-017 and FIN-037. Prerequisite: `usage: {include: true}` on the OpenRouter chat payload. Must run in `onFinish`/`waitUntil`, never a detached promise. Also fixes generation attribution. **Framing:** this is observability, attribution and defence-in-depth — _not_ the thing that stops overspend, which already works. Saying otherwise oversells it.

**Stage 6 — remainder.** FIN-025, FIN-026, FIN-029, FIN-030, FIN-034, FIN-035, FIN-036, FIN-038, FIN-039.

---

## 7. Investigated and refuted

Recorded so these are not re-litigated. Each was suspected during triage and disproved by reading the code.

| Suspicion                                                         | Verdict                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Monotonic balance means the debit is missing — money is leaking" | **Wrong framing.** Monotonic by design; OpenRouter's key limit is the debit engine. Re-categorised as ledger-integrity, not money-loss.                                                                     |
| `platformAdmin.ts:736,766` is a balance writer                    | **No.** Those lines set `is_active` in deactivate/reactivate. The real writer set is `aicoBilling.ts:183` and `softDelete.ts:77` only.                                                                      |
| Multi-instance key race leaks spend                               | **No.** The orphan's plaintext is never returned, so it cannot be spent; and `createAndPersistUserKey` retires orphans on persist failure. Downgraded to P2 key sprawl (FIN-036).                           |
| Double-reclaim: sweep then remove member                          | **Correctly guarded.** The sweep's CAS settles the budget and nulls `openrouter_key_id`; the removal's outbox reclaim then finds no key and the CAS loses anyway.                                           |
| Pending-period double refund                                      | **Correctly guarded.** Renewal requires `isActive OR renewal_failed`; reclaim sets `isActive: false` + `settled`.                                                                                           |
| Renewal peek→confirm spend window                                 | **Does not apply.** `settleMemberPeriod` runs after every key in the batch is disabled.                                                                                                                     |
| One-trial-per-user is check-then-act                              | **Atomic.** Enforced by two unique indexes with a SQLSTATE-classified catch. Phone is read server-side from the verified user record — not client-supplied.                                                 |
| `AICO_ALLOW_TRIAL` production gate is bypassable                  | **No.** Two independent guards, both reading process env, resolved at module load. The admin panel only flips the third AND-ed condition.                                                                   |
| Generation cost computation silently returns 0                    | **No.** Every missing-pricing branch returns `undefined`, never 0.                                                                                                                                          |
| `refreshAicoBillingBalance` skipped on generation failure         | **No.** Both terminal states refresh.                                                                                                                                                                       |
| `resolvePreferredGenerationBilling` misattributes UI generations  | **No.** The image/video tabs pass an explicit context. Only agent-tool and memory-embedding paths use the preference (narrow residual risk noted).                                                          |
| The `≥ limit × 0.95` clause fires spuriously                      | **Not independently.** Its two conjuncts are near-contradictory unless the cache is already wrong. Symptom amplifier for FIN-020/FIN-023, not its own bug.                                                  |
| Concurrent syncs double-apply the multiplier rebase               | **No.** `rebaseCheckpoint` is idempotent under a shared input checkpoint. The real race is sync-vs-renewal (FIN-033).                                                                                       |
| `currentCycleLimitMicroUsd` mishandles some budget state          | **No live bug.** All states check out; FIN-001 holds. One latent trap (`periodAmount ≤ 0` with `pendingPeriodAmount > 0`) is unreachable through current write paths — worth an invariant check, not a fix. |

---

## 8. Appendix — units glossary

| Term          | Meaning                                                                                                                       | Where                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **raw**       | What OpenRouter actually charged. `key.usage`, `raw_capacity_micro_usd`, `usage_baseline_micro_usd`.                          | OpenRouter ↔ `aicoMoney.ts`        |
| **billed**    | raw × `multiplier_bp / 10000`. What the user pays. `balance_micro_usd`, `settled_usage_micro_usd`, `period_amount_micro_usd`. | user-facing                        |
| **micro-USD** | Integer storage, 1 USD = 1,000,000.                                                                                           | all `*_micro_usd` columns          |
| **bp**        | Basis points. Default 12000 = 1.2×. Min 10000, max 30000.                                                                     | `platform_usage_multiplier_config` |

Conversions: `applyMultiplierMicroUsd` (raw→billed, `Math.ceil`) · `removeMultiplierMicroUsd` (billed→raw, `Math.floor`) · `rawCapacityFromDeposit` · `billedUsageFromCapacity` · `keyLimitFromBilled` · `blendedMultiplierBp`. All in [aicoMoney.ts](../../packages/database/src/utils/aicoMoney.ts).

Round-tripping is deliberately lossy in the user-conservative direction, compensated by the `raw >= capacity ⇒ return balance` short-circuit ([aicoMoney.ts:360](../../packages/database/src/utils/aicoMoney.ts:360)) so `remaining` still lands exactly on zero when a wallet is spent out.
