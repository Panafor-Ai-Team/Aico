# Atomic Trial Quota Reservation

**Status:** Shipped (AICO-P1-010). Trial remains **disabled in production**: `AicoManagedPolicy.assertTrialAllowed` refuses every Trial call when `NODE_ENV=production`, whatever `AICO_ALLOW_TRIAL` says. Enabling Trial in production is a separate product decision.

## Problem (fixed)

`maxRequests` was never enforced on the live managed path (`AicoManagedPolicy.authorize`), and the legacy `AicoChatGuard` checked the count and incremented it later (check-then-act), so concurrent requests could overspend the cap.

## Design

1. `AicoBillingModel.incrementTrialRequest(userId)` **reserves** one unit with a single conditional statement:
   `UPDATE user_trials SET request_count = request_count + 1 WHERE user_id = … AND status = 'active' AND expires_at > now() AND (cap IS NULL OR request_count < cap) RETURNING …`, where the cap is `platform_trial_config.max_requests` read in the same statement. Postgres re-checks the condition on the locked row, so N concurrent requests for the last unit yield exactly one success.
2. `AicoManagedPolicy.authorize` reserves **after every check that can refuse** (wallet, key, decrypt), so a refusal never spends a unit. No row returned → `TRIAL_REQUEST_LIMIT` (`SubscriptionPlanLimit`), fail closed **before** any provider call. The context carries `trialRequestReserved: true`.
3. `initModelRuntimeFromDB` gives the unit back (`releaseTrialRequest`, never below zero) if building the runtime fails after `authorize`: the provider call never started.
4. Once the runtime exists the call starts, so the unit is consumed; a user abort does not refund it.
5. The unique phone fingerprint and the abuse blocklist are unchanged.

## Tests

- `packages/database/src/models/__tests__/aico.trialAbuse.test.ts` (AICO-P1-010 ×2) and `aicoBilling.trialReservation.test.ts`: concurrency, cap changes, unlimited, expiry, release.
- `apps/server/src/services/aico/managedPolicy.trial.test.ts`: reservation at the policy boundary, racing calls, no spend on refusal, production still refused.
- `apps/server/src/modules/ModelRuntime/managedLedger.test.ts`: the unit is given back when the runtime cannot be built.
