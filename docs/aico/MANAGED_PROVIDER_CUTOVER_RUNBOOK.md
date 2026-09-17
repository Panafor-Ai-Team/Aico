# Managed provider cutover runbook

Switching `AICO_MANAGED_PROVIDER` between `openrouter` and `cheapvibecode` in a
live deployment. Written for the OpenRouter → CheapVibeCode direction; every step
is symmetric, and the rollback is the same flip in reverse.

The premise of the whole design is that the switch is an **env change, not a
restore**: no key is deleted, no balance is revalued, and a wrong-looking result
at any step is undone by flipping the variable back.

## What the switch actually changes

|                                     | Before           | After                 |
| ----------------------------------- | ---------------- | --------------------- |
| Runtime the chat path dispatches to | `openrouter`     | `cheapvibecode`       |
| Gateway new keys are minted on      | OpenRouter       | CheapVibeCode         |
| Usage multiplier in force           | bp 12000 (1.20x) | bp 12500 (1.25x)      |
| Synced model catalog served         | OpenRouter's     | CheapVibeCode's       |
| Keys minted before the flip         | live             | **treated as absent** |

Stored provider ids are _not_ rewritten. `AicoManagedPolicy.resolveRuntimeProvider`
maps every managed id (`aico`, `openrouter`, `cheapvibecode`) onto whichever
gateway is active, so agent configs written before the flip keep working, and
browser-created configs — which always resolve `DEFAULT_PROVIDER` to the build
default, because `AICO_MANAGED_PROVIDER` has no `NEXT_PUBLIC_` twin — do too.

## Why a pre-cutover key is "absent"

`member_budgets.managed_key_provider_id` and `user_wallets.managed_key_provider_id`
(migration `0154`) record which gateway minted each key. A key whose stamp is not
the active provider authenticates against nothing, so every path treats it as
missing rather than as usable:

- `AicoManagedPolicy.authorize()` refuses it, then calls the repair hook, which
  mints a replacement on the active gateway and retries the same request.
- `ensureUserKey` / `ensureTrialKey` / `ensureMemberKey` mint a replacement sized
  to what the subject has **left**, never to their whole balance.
- `getUserRemaining`, `settleMemberPeriod`, `peekMemberRemaining` and
  `syncMemberCycleUsage` degrade to the last settled figure instead of reading
  the wrong gateway (which would be an auth error, and on the renewal path a
  failed renewal).
- `disableMemberKey` / `disableUserKey` / `reclaimMemberKey` leave a foreign key
  untouched — the live gateway does not own it.

A `NULL` stamp is not foreign: it predates migration `0154`, which backfills
`'openrouter'` wherever a key id exists, and can only be OpenRouter.

**Replacement sizing, stated plainly.** Spend on the old key after its last
successful sync is unmeasurable — the gateway that could report it is no longer
being called. The replacement is therefore sized from the last _settled_ figure,
which under-bills by at most one sync interval. That is the intended direction:
we do not charge for spend we cannot evidence, and the alternative (assuming the
key was fully spent) would strand funded users.

## Before the flip

1. `AICO_CVC_TOKENS_PER_USD` matches the rate the CVC account was actually
   funded at (default `25000000`). It re-denominates every price derived from a
   model's coefficient.
2. `platform_usage_multiplier_config` has a `cheapvibecode` row at bp 12500
   (migration `0151`). Without it the lookup falls back to the `'default'` row.
3. The CVC primary key is set **only** in `apps/aico-control-plane`
   (`CHEAPVIBECODE_MANAGEMENT_API_KEY`), never on the product server. It is both
   the management _and_ the inference credential: a leak spends the account
   float directly.
4. The catalog sync cron has run at least once against CVC, or the picker serves
   the static model-bank snapshot until it does.
5. Master account float is funded enough to cover every key that will be minted
   in the first hours — each migrating user mints one.

## The flip

1. Set `AICO_MANAGED_PROVIDER=cheapvibecode` and restart.
2. Watch for `[aico] personal managed key belongs to another gateway` and
   `[aico] member managed key belongs to another gateway` — one per subject, at
   their first request after the flip. A second one for the same subject means a
   mint is failing; check the control-plane proxy.
3. Trial users first (they carry the least money), then personal wallets, then
   orgs. Org members re-key at their first request or at the next renewal
   boundary, whichever comes first.
4. Old keys stay live upstream on purpose. Do not revoke them until the CVC path
   has been proven across at least one full renewal cycle.

## Rolling back

Set `AICO_MANAGED_PROVIDER=openrouter` and restart. The OpenRouter keys are
untouched and immediately usable again; keys minted on CVC in the interim become
the foreign ones and are re-minted by the same machinery, with spend on them
carried through the same last-settled arithmetic. Nothing is restored from a
backup, and no balance is revalued.

## Shared-key ledger mode

CVC caps how many keys an account may create, so per-subject keys do not scale
on CVC. With `AICO_MANAGED_INFERENCE_KEY=shared` and
`AICO_BILLING_LEDGER_MODE=enforce`, all managed traffic runs on the CVC primary
key. Every call is metered by the hold-and-settle usage ledger (migration 0156)
instead of per-key upstream limits. After that cutover:

- Top-ups and renewals no longer create keys.
- Balances come from ledger columns, not key reads.
- Rolling back to per-key limits requires a reverse snapshot that is not built.

The shadow measurement, cutover snapshot, emergency pause and limitations are
in [SHARED\_KEY\_LEDGER\_RUNBOOK.md](./SHARED_KEY_LEDGER_RUNBOOK.md).

## Invariants this must never break

- **`user_wallets.raw_capacity_micro_usd` is a single blended pool denominated in
  the active provider's raw USD.** It is only coherent because exactly one
  managed provider is live per deployment. Never run two simultaneously without
  first splitting capacity per provider.
- **A rate change never revalues money already paid.** `checkpoint_multiplier_bp`
  and `raw_capacity_micro_usd` are historical records of the rate money was
  bought at; the lazy rebase in `syncMemberCheckpoint` freezes usage-to-date at
  the old rate and restarts the meter. A balance topped up at 1.20x and spent
  after the flip buys slightly more CVC than 1.25x intends. That is correct.
- **Unknown spend is never zero spend.** Every degraded read holds the last
  settled figure; reporting zero would refund money that was already spent.

Regression coverage: `apps/server/src/services/openrouter/aico.providerCutover.test.ts`.
