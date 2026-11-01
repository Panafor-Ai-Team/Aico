---
name: aico-upstream-sync
description: >-
  Sync Aico fork with upstream lobehub/lobehub canary while preserving Aico
  customizations (B2B/platform admin, billing, OpenRouter key allocation,
  BRANDING_PROVIDER managed provider, fa-IR/RTL). Use when catching up to
  upstream, merging lobehub, syncing canary, rebasing on upstream, or the user
  asks for upstream sync / catch up / merge upstream / sync fork.
---

# Aico upstream sync

Bring `upstream/canary` (`lobehub/lobehub`) into Aico `origin/canary` **without
losing fork-only product**. Ship via **`aico-ship`** (GitHub issue + PR).

Remotes (expected):

| Remote     | Repo                   |
| ---------- | ---------------------- |
| `origin`   | `Panafor-Ai-Team/Aico` |
| `upstream` | `lobehub/lobehub`      |

Default base for the sync PR: **`canary`**. Never force-push `canary` / `main`.

## Ownership split

| Concern                                      | Use                                                         |
| -------------------------------------------- | ----------------------------------------------------------- |
| GitHub issue + PR closeout                   | `aico-ship`                                                 |
| Branch / commit / `gh pr create` mechanics   | `pr` (ignore Linear)                                        |
| Migration journals after merge               | **this skill** § Migrations; SQL review per `db-migrations` |
| Risk gates, conflict policy, protected paths | **this skill**                                              |

Do **not** edit upstream skills under `.agents/skills/` for process overrides.

## When to stop and ask

**Pause and ask the user** before resolving or merging further when any of:

1. Upstream touches a **protected surface** (see [PROTECTED.md](PROTECTED.md)) and the change is not a trivial import/format conflict
2. Conflict mixes Aico billing/OpenRouter/managed-provider semantics with upstream provider/auth/quota redesign
3. Upstream and Aico both add Drizzle migrations with overlapping sequence numbers
4. Upstream renames/moves files that Aico patched (provider settings, auth SPA, home shell)
5. You cannot tell whether keeping ours would drop a security/perf fix, or taking theirs would break B2B charging / key allocation / branding
6. Working tree is dirty, or another merge/rebase is already in progress
7. Divergence is huge and the user only asked for “status” (report first; do not merge yet)

When asking, show: file path, short “ours vs theirs” intent, recommended choice (`ours` / `theirs` / `manual`), and one risk sentence.

## Workflow checklist

Copy and track:

```
Upstream sync:
- [ ] 1. Preconditions
- [ ] 2. Fetch + divergence report
- [ ] 3. Impact / risk gate (ask if needed)
- [ ] 4. GitHub issue via aico-ship
- [ ] 5. Sync branch + merge
- [ ] 6. Resolve conflicts (policy below)
- [ ] 7. Verify
- [ ] 8. Push + PR (aico-ship closeout)
```

### 1. Preconditions

```bash
git status -sb
git remote -v # origin = Aico, upstream = lobehub/lobehub
test ! -f .git/MERGE_HEAD && test ! -d .git/rebase-merge
```

- Clean tree (or stash only with user OK).
- Prefer starting from up-to-date `origin/canary`.
- If not on a sync branch yet, do not merge into local `canary` directly — use `chore/sync-upstream-canary` (or `chore/sync-upstream-YYYYMMDD`).

### 2. Fetch + divergence report

```bash
git fetch upstream canary
git fetch origin canary

git rev-parse origin/canary upstream/canary
git merge-base origin/canary upstream/canary

git log --oneline origin/canary..upstream/canary | wc -l # behind
git log --oneline upstream/canary..origin/canary | wc -l # ahead
```

Report to the user:

- Commits behind / ahead
- Sample upstream themes (`git log --oneline origin/canary..upstream/canary | head`)
- Fork-only themes (billing, branding, deploy, fa-IR, …)
- Dry-run conflict signal:

```bash
git merge-tree "$(git merge-base origin/canary upstream/canary)" origin/canary upstream/canary \
  > /tmp/aico-merge-tree.txt
# Inspect "changed in both" / conflict markers in that output
```

Classify paths that appear in **both** sides against [PROTECTED.md](PROTECTED.md).

### 3. Impact / risk gate

Produce an **Impact brief** before merging:

| Bucket                          | Action                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Upstream-only, non-protected    | Safe to take upstream                                                                                   |
| Text conflict on protected      | Prefer Aico; verify still compiles/tests                                                                |
| Semantic overlap on protected   | **Ask user** with options                                                                               |
| Migration files                 | Take upstream's `packages/database/migrations/` verbatim; never touch `migrations-aico/` (§ Migrations) |
| Deleted-by-upstream + Aico edit | **Ask user**                                                                                            |

If the user only wanted analysis: stop after this brief. Do not create branch/PR unless they confirm.

### 4. GitHub issue (before or right after branch)

Follow **`aico-ship`**: create a GitHub issue (EN), **no prior duplicate search**.

Suggested title: `Sync upstream/canary into Aico (behind N)`

The body should list: behind/ahead counts, high-risk protected paths, and that the sync PR will target `canary`.

### 5. Sync branch + merge

```bash
git checkout origin/canary
git checkout -b chore/sync-upstream-canary # or dated name if branch exists
git merge upstream/canary --no-edit
```

If merge aborts due to unrelated local state, fix preconditions — do not `--force`.

### 6. Conflict resolution policy

1. Build two lists:

   ```bash
   git log --name-only --pretty=format: upstream/canary..origin/canary | sort -u > /tmp/fork-touched.txt
   git diff --name-only --diff-filter=U > /tmp/conflicts.txt
   ```

2. **Conflicts ∩ fork-touched / protected** → resolve carefully; default **keep Aico behavior**, then re-apply useful upstream fixes by hand.

3. **Conflicts ∉ fork-touched** → default **take upstream** (`--theirs`), unless the hunk clearly reverts an Aico deploy/branding fix that landed via cherry-pick on a “shared” file.

4. Never leave `<<<<<<<` markers. After each batch: `git add` resolved files; do not commit until markers are gone and migrations are consistent.

5. **Migrations** (two journals, one ledger — see § Migrations below): take upstream's `packages/database/migrations/` **verbatim**, journal and snapshots included; do not renumber or re-stamp anything. Aico's migrations stay untouched in `packages/database/migrations-aico/`. Then:
   - run `bun run check --test scripts/aico/migrationLayout.test.ts scripts/migrateServerDB/dualJournal/legacyJournal.test.ts`: no upstream migration may touch a table declared in `aicoOrganization.ts`, and every shipped migration must keep its tag / hash / `when` (or be covered by `AICO_EQUIVALENCES`, as upstream `0131_agents_add_name_column` is by Aico 0134);
   - review every new upstream migration for locks on large tables (`db-migrations` § online index creation) before it reaches production;
   - the Migration Ledger CI job (schema drift, drizzle-kit baselines, ParadeDB scenarios) must pass.

6. **Branding**: defaults stay Aico via `packages/business/const` (`BRANDING_NAME`, `BRANDING_PROVIDER`, …). Do not reintroduce hard-coded `LobeHub` in user-facing Aico surfaces. Env overrides: `BRANDING_*` / `NEXT_PUBLIC_BRANDING_*`.

7. **Managed provider**: preserve `provider === 'aico' | BRANDING_PROVIDER` → OpenRouter key path (`managedPolicy`, `openrouter/*`, provider UI redirects). Upstream OpenRouter edits must be merged into Aico’s allocation/charging flow, not replace it.

8. **Locales**: keep `locales/fa-IR/**` and Aico namespaces; merge upstream en/zh keys, then ensure fa-IR still has Aico strings (missing keys fall back — do not delete fa-IR to “resolve”).

### 7. Verify

Minimum after conflict-free merge commit:

```bash
# conflict markers
rg -l '^<<<<<<<' -g '!node_modules/**' -g '!.git/**' -g '!*.lock' || true

# targeted check on touched / conflicted areas (prefer once)
bun run check --lint --test <resolved-or-sensitive-paths...>
```

Also sanity-grep protected invariants:

- `BRANDING_NAME` default / business-const still Aico-oriented
- `apps/server/src/services/aico` + `openrouter` still present
- Platform/Org admin + AicoBilling features still export
- No accidental drop of `packages/env/src/aico.ts`

Do **not** run full `bun run test`. If verification fails, fix on the sync branch; do not push a broken merge as “done.”

### 8. Commit, push, PR

Merge commit message (gitmoji), e.g.:

```text
🔀 merge: sync upstream/canary into Aico fork

Bring in N upstream commits while preserving Aico billing, managed
OpenRouter provider, branding, admin panels, and fa-IR/RTL.
```

Then **`aico-ship` finish-job**:

- Push sync branch to `origin`
- `gh pr create --base canary` with `Fixes #n`

PR description must include:

- Behind/ahead summary
- Conflict strategy (what stayed Aico vs taken upstream)
- New upstream migrations taken (tags), and any that need a manual `CONCURRENTLY` step
- Explicit “risks / follow-ups” if anything was deferred with user agreement

## Migrations

Aico has **two journals and one ledger** (since #744):

| Folder                               | Owner            | How it changes                                                                           |
| ------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------- |
| `packages/database/migrations/`      | upstream LobeHub | taken verbatim on sync (journal + snapshots)                                             |
| `packages/database/migrations-aico/` | Aico             | `bun run db:generate:aico` only (`drizzle.aico.config.ts`, schema `aicoOrganization.ts`) |

- `scripts/migrateServerDB/dualJournalRunner.cjs` applies main, then Aico, into the single `drizzle.__drizzle_migrations` table. A migration counts as applied iff a row's `created_at` equals its journal `when`, so **never edit a shipped migration file or its `when`**: a changed file is reported as drift and never re-run; a changed `when` would run it again (Aico's historical migrations reset FX rates, re-seed and delete data).
- Drizzle's own migrator can run only one journal and is refused (`AICO_MIGRATION_RUNNER=stock`).
- `AICO_EQUIVALENCES` maps an upstream tag to an Aico ledger row that already did its work (upstream `0131_agents_add_name_column` ⇐ Aico `0134_agents_add_name_column`, `when` 1785657510456). Add an entry only for an upstream migration Aico already shipped under another tag.
- Guards: `scripts/aico/migrationLayout.test.ts`, `scripts/migrateServerDB/dualJournal/legacyJournal.test.ts`, `scripts/aico/migrationLedger.test.ts`, and the Migration Ledger workflow.

## Anti-patterns

- Merging upstream straight into `canary` without a sync branch/PR
- Blind `git checkout --theirs` on `apps/server/src/services/aico/**`, `openrouter/**`, `PlatformAdmin`, `AicoBilling`, branding
- Renumbering **away** Aico migrations to match upstream numbers
- Patching `pr` / `linear` skills instead of using `aico-ship`
- Opening a PR without a GitHub issue when user asked to ship the sync
- Claiming “no risk” when protected paths appear in `changed in both`

## Additional resources

- Protected path inventory: [PROTECTED.md](PROTECTED.md)
- Issue + PR ship: `aico-ship`
- Migrations: `db-migrations`
