# CheapVibeCode provider — Phase 0 probe results

**Date:** 2026-09-14
**Purpose:** validate CheapVibeCode (CVC) as a managed-provider replacement for OpenRouter before
building the migration described in the managed-provider migration plan.
**Method:** live probes against a funded account, using the primary key and a scoped key with a
`token_limit` of 1,000,000.

All figures below are reproduced measurements, not documentation claims. CVC's published docs
describe considerably less of the API than actually exists, and in one respect (the charge formula)
are misleading.

---

## 1. Endpoint surface

| Endpoint                                                                                                                                        | Method                     | Result                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/v1/models`                                                                                                                                    | GET                        | 200 — 36 models, with `multiplier`, `base_multiplier`, `fast_multiplier`, `context_window`, `max_output_tokens`, `supports_tools/vision/reasoning`, `input_modalities`. No USD pricing, no cache rate. |
| `/v1/balance`                                                                                                                                   | GET                        | 200 — **scoped to the calling key** (see §2)                                                                                                                                                           |
| `/v1/chat/completions`                                                                                                                          | POST                       | 200 — OpenAI-shaped, streaming and tool calls both work                                                                                                                                                |
| `/v1/keys`                                                                                                                                      | POST                       | 201 — create only                                                                                                                                                                                      |
| `/v1/keys`                                                                                                                                      | GET / PATCH / DELETE       | **405**                                                                                                                                                                                                |
| `/v1/keys/{id}`                                                                                                                                 | GET / PATCH / PUT / DELETE | **404**                                                                                                                                                                                                |
| `/v1/usage`, `/v1/me`, `/v1/account`, `/v1/credits`, `/v1/limits`, `/v1/requests`, `/v1/stats`, `/v1/logs`, `/v1/keys/usage`, `/v1/models/{id}` | GET                        | **404**                                                                                                                                                                                                |

**There is no API revoke, disable, or update for keys.** A minted key is permanent as far as the API
is concerned; the dashboard's regenerate control is the only remedy. Plan around this.

## 2. `/v1/balance` is per-key

Called with the primary key it returns the account float; called with a scoped key it returns that
key's remaining allowance:

```
primary key            -> 272,202,472     (account float)
scoped key (1M limit)  ->     950,000     (= 1,000,000 - 50,000 already spent)
probe key (5k limit)   ->       4,987     (= 5,000 - 13 spent on one request)
```

This is the functional equivalent of OpenRouter's `getKey(hash).limitRemaining`, addressed by
authenticating _as_ the key rather than by id. Per-key usage is `token_limit - balance`.

**It is rate limited.** Three calls in immediate succession returned 200, 429, 429. No `Retry-After`
or `X-RateLimit-*` headers are exposed (Cloudflare fronted). It recovers within a few seconds.
Consequence: `/v1/balance` cannot be polled per request, or per member key in a tight settlement
loop. Batch it, space it, and handle 429 with backoff.

## 3. The charge formula — **does not match the published coefficients for all models**

Charge is measured as the balance delta across a single request.

For most models the rule is `charge = round(coefficient x total_tokens)`, with input and output
weighted equally:

| Model             | coeff | total | charged | coeff x total | effective |
| ----------------- | ----- | ----- | ------- | ------------- | --------- |
| `claude-sonnet-5` | 2     | 71    | 142     | 142.00        | 2.000     |
| `claude-sonnet-5` | 2     | 1367  | 2734    | 2734.00       | 2.000     |
| `claude-sonnet-5` | 2     | 1364  | 2728    | 2728.00       | 2.000     |
| `grok-4.6`        | 0.5   | 490   | 245     | 245.00        | 0.500     |
| `gpt-5.6-luna`    | 0.33  | 1083  | 357     | 357.39        | 0.330     |
| `glm-5.3-flash`   | 0.3   | 157   | 47      | 47.10         | 0.302     |

But two reasoning models bill `round(coefficient x (total_tokens + reasoning_tokens))` — charging
reasoning tokens twice, since they are already inside `completion_tokens`:

| Model                 | coeff | total | reasoning | charged | coeff x total | coeff x (total+reas) | effective |
| --------------------- | ----- | ----- | --------- | ------- | ------------- | -------------------- | --------- |
| `deepseek-v4.1-flash` | 0.3   | 127   | 56        | 55      | 38.10         | 54.90                | **0.433** |
| `deepseek-v4.1-flash` | 0.3   | 118   | 53        | 51      | 35.40         | 51.30                | **0.432** |
| `mimo-v2.5`           | 0.05  | 668   | 291       | 48      | 33.40         | 47.95                | **0.072** |
| `mimo-v2.5`           | 0.05  | 668   | 311       | 49      | 33.40         | 48.95                | **0.073** |

Both reproduce exactly. That is **\~44% above the advertised coefficient**, and `glm-5.3-flash` —
structurally identical usage, same reasoning field — does _not_ behave this way. There is no field
in `/v1/models` that predicts which rule applies.

**Implication for billing: do not compute charges from the usage block.** Any formula we derive will
silently under-charge on some models and we would absorb the difference. The balance delta must be
the authoritative figure; a computed estimate is acceptable only for display, reconciled against
balance at settlement.

## 4. Cached tokens do not reduce the charge

`claude-sonnet-5` reported `prompt_tokens_details.cached_tokens: 63` on three consecutive requests
and was billed the full `coefficient x total_tokens` every time. `/v1/models` publishes no cache
rate. Treat cache reporting as informational only.

## 5. Key creation exposes undocumented fields

`POST /v1/keys` returns considerably more than the docs suggest:

```json
{
  "key": "sk-cvc-...",
  "meta": {
    "id": "5c4a0a2b-...",
    "key_prefix": "sk-cvc-e2563",
    "name": "aico-migration-probe",
    "allowed_models": ["gpt-5.6-luna"],
    "rate_limit_rps": 6,
    "rate_limit_rpm": 120,
    "concurrency": 6,
    "is_primary": false,
    "token_limit": 5000,
    "tokens_used": 0,
    "daily_budget_rubles": 0,
    "claude_provider": "claude",
    "is_active": true,
    "output_guard_surcharge_active": false,
    "expires_at": null,
    "created_at": "2026-09-14T11:05:44Z"
  }
}
```

Notable: `daily_budget_rubles` (a **daily** cap concept), `expires_at`, `is_active`, `tokens_used`,
and per-key `rate_limit_rps` / `rate_limit_rpm` / `concurrency` (6 rps / 120 rpm / 6 concurrent by
default — a per-member ceiling worth knowing before rollout).

These appear in responses but there is no endpoint to read or modify them after creation, and it is
untested whether `daily_budget_rubles` / `expires_at` are honoured when supplied at create time.
**Worth testing next** — a working `daily_budget_rubles` would restore a native daily cap and
`expires_at` would give a way to retire keys without a revoke endpoint.

**Warning:** `POST /v1/keys` ignores unknown fields and always creates. Sending `{"id": ..., "is_active": false}`
in an attempt to update produced a _new_ key with `token_limit: null` (unlimited). Never treat POST
as an upsert.

## 6. `allowed_models` is enforced upstream

A scoped key restricted to `gpt-5.6-luna`, asked for `claude-sonnet-5`:

```
HTTP 403 {"error":{"message":"This API key is not allowed to use the requested model.",
                   "type":"permission_error","code":"model_not_allowed"}}
```

Useful as defence in depth. Note `/v1/models` is **not** filtered by `allowed_models` — a restricted
key still sees all 36 — so catalog filtering remains our responsibility.

## 7. Streaming and tool calling

Both OpenAI-shaped and working. Streaming returns usage in the final chunk when
`stream_options.include_usage` is set. Tool calls return a standard `tool_calls` array with
`function.name` / `function.arguments` and a `call_...` id.

## 8. Consequences for the migration plan

1. **Keep per-member keys.** Per-key remaining and upstream `allowed_models` enforcement both work.
2. **Balance deltas are the billing source of truth**, not computed charges (§3).
3. **Space out balance reads** (§2) — settlement must batch and back off, not poll per request.
4. **No revoke.** Retiring a member means ceasing to use the key; record it in `aico_key_outbox` for
   cleanup if CVC ever ships one. Safe only because managed keys never reach the browser
   (`disableBrowserRequest: true`).
5. **Test `daily_budget_rubles` and `expires_at` at create time** before committing to the
   checkpoint-emulation design — either would materially simplify it.
6. **Per-key rate limits (6 rps / 120 rpm / 6 concurrent)** need to be reflected in our error mapping
   and surfaced to org admins.
