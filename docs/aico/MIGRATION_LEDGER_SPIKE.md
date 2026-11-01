# Spike: dual-journal migration ledger (design D2)

> **Date:** 2026-10-31 (updated 2026-11-01) · **Status:** **D2 adopted** — canary production ledger verified clean; the runner is the default · **Code:** `scripts/migrateServerDB/dualJournal/` (prototype, not wired into any deploy path)

## Why

Aico's migrations `0131`–`0159` occupy the same journal positions as upstream LobeHub's `0131`–`0159` (29 positions, all different), and Drizzle's stock migrator only applies an entry whose `when` is newer than the newest applied row. Merging upstream's journal as-is would therefore **silently skip upstream `0132`–`0161`** on every existing Aico database (confirmed earlier with `bun run db:audit-ledger --journal-dir=<upstream>` against a seeded ledger: 31 skipped, 36 applied).

D2 keeps **one ledger table** and **two journals** — upstream's verbatim, Aico's own in a second track with their original `when` values — and treats an entry as applied iff a ledger row's `created_at` equals its `when`. No row moves, no renumbering, and every future upstream sync can take upstream's journal unchanged.

## What was built

| File             | Role                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runner.ts`      | Prototype D2 runner: advisory lock, identity by `when`, equivalence map (upstream `0131_agents_add_name_column` ⇐ Aico `0134_agents_add_name_column`), one transaction per migration, hash drift reported and **never re-run** |
| `tracks.ts`      | Builds the two tracks: upstream's `packages/database/migrations` verbatim from a git ref; Aico's own 28 entries (0131, 0132, 0133, 0135–0159) with their original `when` values                                                |
| `spike.ts`       | Runs the scenarios on fresh in-memory PGlite (+pgvector, as `getTestDB`), prints JSON                                                                                                                                          |
| `runner.test.ts` | CI-safe unit tests on synthetic tracks (6 tests)                                                                                                                                                                               |

Run it: `bunx tsx scripts/migrateServerDB/dualJournal/spike.ts` (needs the `upstream/canary` ref; \~40 s).

## Results (upstream `canary` @ `7bc8d7ea4b`, Aico `canary` @ `3315b9bb54`)

Tracks: upstream 198 entries, Aico own 28, Aico today 160.

| ID  | Scenario                                                                                                                      | Result                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Fresh install: all upstream, then the Aico track                                                                              | ✅ 224 applied, 2 recorded-as-skipped (pg_search/BM25 on PGlite)                                                                                                                                                                                                                                                                                |
| S2  | Upgrade a database migrated with today's Aico journal, seeded with a user, an organization, a wallet and a wallet transaction | ✅ 66 upstream migrations applied; upstream `0131` satisfied by Aico `0134`; drift reported for `0090`/`0093`/`0111` (upstream comment/guard edits — not re-run); **catalog identical to S1** (columns, defaults, nullability, indexes, constraints, triggers, functions, enums); **every pre-existing table's rows unchanged** (md5 per table) |
| S3a | Ledger missing the `0142` row, tables present (manual-repair state)                                                           | ✅ `0142` applied once (idempotent), catalog = S1                                                                                                                                                                                                                                                                                               |
| S3b | `0142` and `0146` rows missing, `0142` tables dropped                                                                         | ✅ both applied in order, catalog = S1                                                                                                                                                                                                                                                                                                          |
| S4  | Old single-journal image after the D2 run (stock Drizzle selection)                                                           | ✅ nothing pending — the previous image is a no-op on boot                                                                                                                                                                                                                                                                                      |
| S5  | Injected failure inside upstream `0150`, then resume                                                                          | ✅ 149 migrations stayed committed, old image still a no-op at the partial state, resume applied the remaining 48, catalog = S1                                                                                                                                                                                                                 |
| S6  | `0132` recorded under an older file hash (`e90b647b…`)                                                                        | ✅ reported as drift, **not re-executed**                                                                                                                                                                                                                                                                                                       |
| S7  | `drizzle-kit generate` with only `aicoOrganization.ts` as schema                                                              | ✅ emits the 32 Aico tables with 18 `REFERENCES "public"."users"` FKs and does not try to create `users`                                                                                                                                                                                                                                        |

## Blockers from the plan, re-evaluated

| ID  | Blocker                                                   | Status after the spike                                                                                                          |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Old image re-migrates after a partial / non-atomic change | **Resolved by design** — S4, S5                                                                                                 |
| B2  | `0142` skipped on some database                           | **Handled** — D2 picks up missing entries regardless of age (S3). Production state still to be confirmed with `db:audit-ledger` |
| B3  | Upstream `0147` breaks `resourcePermission` upserts       | Downgraded — every call is gated on `ctx.workspaceId`; apply upstream's `targetWhere` with that migration                       |
| B4  | Lock storm from one big batch                             | **Mitigated** — one transaction per migration (S5). Lock timing on a production-sized clone still to measure                    |
| B5  | Stale Aico snapshot                                       | **Workable** — S7 shows drizzle-kit can generate the Aico track from its own schema file; needs a one-time baseline snapshot    |
| B6  | Non-replay-safe Aico SQL                                  | **Resolved by design** — drift is never re-executed (S6)                                                                        |
| B7  | Count-based deploy guards                                 | Not triggered — D2 moves no rows                                                                                                |

## Remaining gates before production (cannot be proven in this sandbox)

1. **Real ledgers:** run `bun run db:audit-ledger` on databases restored from preview and canary backups; every row must map to a journal entry by `when` (or be explained), and `0142`'s state must be known.
2. **Real Postgres + ParadeDB:** run the S1–S6 harness against ParadeDB in CI — PGlite skips the pg_search/BM25 statements and is single-connection.
3. **Concurrency:** two runners started together must serialize on the advisory lock (real Postgres only). The real executor must use one dedicated client (`pool.connect()`) for `BEGIN`/`COMMIT`.
4. **Lock / timing rehearsal** on a production-sized clone with the `CONCURRENTLY` pre-builds for upstream `0153`/`0156`/`0167`/`0196`.
5. ✅ **Schema layout for drizzle-kit:** closed by #744. The main config lists its files explicitly; each journal has a no-op baseline snapshot, and CI checks that both generators stay empty.

## Recommendation

Adopt **D2**. Next PR-sized steps, in order:

1. ✅ **Done (#728):** the runner ships as `scripts/migrateServerDB/dualJournalRunner.cjs`; `docker.cjs` and `pnpm db:migrate` use it over today's single journal when `AICO_MIGRATION_RUNNER=dual` (unset = stock Drizzle). Enable per environment after `db:audit-ledger` on a restored backup.
2. ✅ **Done:** `.github/workflows/migration-ledger.yml` runs the scenarios on ParadeDB (`spike.ts --pg-url … --assert`), including **S8** — two runners started together on separate connections must serialize (no duplicate ledger rows, one of them applies nothing). Upstream is pinned in the workflow (`UPSTREAM_SHA`). Covers gates 2–3. The same job runs `dualJournal/schemaDrift.ts`, which fails when the database built from Aico's migrations differs from the one `drizzle-kit` generates from `aicoOrganization.ts` (it found five FKs the schema declared but no migration created; `0160_aico_billing_foreign_keys` adds them).
3. ✅ **Done (#737):** on the stock path, every boot logs a read-only `dual-journal preview` and the deploy copies it into the Actions log. Canary production, 2026-11-01 (deploy of `637ce38fbb`): `pending=0 equivalent=0 drift=0 unknownRows=0` — every ledger row maps to a journal entry by `when`, nothing is missing (no skipped 0142) and no applied file changed. Closes gate 1 for canary production.
4. ✅ **Done (#739):** the runner became the default. Canary production, deploy of `70b2fc2b59`: `dual-journal runner: applied=0 skipped=0 equivalent=0 drift=0 unknownRows=0`.
5. ✅ **Done (#744):** the journal split.
   - `packages/database/migrations/` holds the upstream-shaped journal: 0000–0130 plus `0134_agents_add_name_column`, Aico's copy of upstream 0131, at idx 131. Its baseline snapshot is generated from the main schema.
   - `packages/database/migrations-aico/` holds Aico's 29 migrations (0131–0133, 0135–0160). Files, tags and `when` values are unchanged; only `idx` is renumbered. It has a single baseline snapshot.
   - drizzle-kit: `drizzle.config.ts` lists every schema file except `aicoOrganization.ts`; `drizzle.aico.config.ts` (`bun run db:generate:aico`) covers that file alone, with timestamp prefixes.
   - The runner applies main, then Aico (`readTracks`), with `AICO_EQUIVALENCES` (upstream 0131 ⇐ Aico 0134) ready for the merge. `AICO_MIGRATION_RUNNER=stock` is refused, because Drizzle's migrator runs one journal.
   - Gate 5 (schema layout) is closed. The new scenarios check that the split runner on a pre-split database applies nothing (S9), that a fresh split install equals a legacy install (S10), and that the previous image stays a no-op after a split install (S11). `legacyJournal.test.ts` pins the rebuilt pre-split journal to `__fixtures__/legacyJournal.json`, and `migrationLayout.test.ts` keeps Aico tables out of the main journal.
6. Only then take the first upstream merge stage, whose journal comes over verbatim.

D0 (renumber and re-stamp upstream on every sync) stays the fallback if a production ledger turns out not to map by `when`.
