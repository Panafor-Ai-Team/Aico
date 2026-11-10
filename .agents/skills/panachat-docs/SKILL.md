---
name: panachat-docs
description: >-
  Keep the Panachat project docs (panachat-docs/: PRD.md, decisions.md,
  status.md, how_to_update_docs.md) current. Use in EVERY development session:
  read status.md at the start, record meaningful progress, decisions, blockers,
  test results and the next step before handing off. Also use when creating,
  rebuilding or auditing the docs, or when the user mentions PRD, decisions,
  status, T-/D- ids, 'مستندات', 'وضعیت', 'تصمیم'.
---

# Panachat docs (PRD / decisions / status)

Operational summary of `panachat-docs/how_to_update_docs.md` (Persian, the
canonical guide). When a rule here is unclear or a case is not covered, read
that file — it wins over this summary.

## Where the docs live

- Folder: `panachat-docs/` at the **repo root**. Product name is Panachat
  (پاناچت); the repo/code name stays Aico. Keep the folder name — never create
  a parallel `*-docs/` folder.
- Exactly four files: `PRD.md`, `decisions.md`, `status.md`,
  `how_to_update_docs.md`. Do not add bug lists, meeting notes or summaries as
  extra files unless the user explicitly changes the structure.
- In a git worktree the folder may be missing (it may be untracked in the main
  checkout). Before concluding it does not exist, check the main checkout:
  `git worktree list` → first line is the main checkout path → look for
  `<main>/panachat-docs/`. Edit the copy that actually exists; do not create a
  second one inside the worktree. If none exists anywhere, run the bootstrap
  flow below.

## What goes where

| File                    | Holds                                                                                      | Must not hold                                        |
| ----------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `PRD.md`                | Product definition, goals, scope, flows, requirements, constraints, acceptance criteria    | Coding logs, changelists                             |
| `decisions.md`          | Accepted important decisions: context, reason, basis, scope, change history                | Guesses, unapproved proposals, copies of PRD content |
| `status.md`             | Current implementation state, open tasks, blockers, test results, next step, short history | New requirements invented by the agent               |
| `how_to_update_docs.md` | The fixed rules of this system                                                             | Project-specific content                             |

One home per fact: **why** → decisions; **what is required** → PRD; **what was
done and verified** → status. Elsewhere, only a short reference (D-/T- id).

| Event                                         | Record in                                        |
| --------------------------------------------- | ------------------------------------------------ |
| New important decision accepted / changed     | `decisions.md` (+ follow-up task in `status.md`) |
| Code, config or guide changed                 | `status.md` history, sized to the real impact    |
| Check/test produced a useful result           | `status.md` history, with result and its limits  |
| Question, bug, blocker or inconsistency found | `status.md` open tasks, with a concrete action   |
| Proposal not yet accepted                     | `status.md` open tasks — **not** decisions       |
| Task cancelled, paused, reverted, reopened    | `status.md` current state + history              |
| Repetitive talk with no new result            | Usually nothing                                  |

## Authority rules

- An accepted PRD is the fixed baseline. Never rewrite it automatically;
  product changes go in a new explicit decision. Current requirement = accepted
  PRD + valid decisions that modify it, each only within its stated scope.
- A PRD reconstructed from the code stays "reconstructed draft / needs
  approval" until the owner accepts it (see the PRD header and its T- task).
- Code and tests are evidence of technical state, not permission to change the
  product definition. A code ↔ PRD mismatch is recorded in `status.md` as
  "mismatch to review" — do not silently side with either.
- On conflict, weigh source, date, scope and approval state. "Newer" or "it's
  in the code" alone does not make something authoritative.

## Session routine (always)

1. **Start:** confirm the folder and four files exist (else bootstrap). Read
   the top of `status.md` (current picture, open tasks, "continue from here"),
   the decisions index, the decisions and PRD sections relevant to the task.
2. **Before working:** find the existing T- task or create one with a clear
   goal and done-condition; set its state. Check the last T-/D- ids so you
   never reuse one.
3. **When an important decision becomes final:** record it in `decisions.md`
   before the implementation relies on it; track any action in `status.md`.
4. **On meaningful progress or a blocker:** record result, effective changes,
   verification done and what remains. Not after every command, but do not
   postpone it to the end of a long job.
5. **End / hand-off:** sync `status.md` with reality — next step, unfinished
   work, tests not run, uncommitted changes, blockers.

If another person or agent may have edited the files, re-read before writing,
edit only the relevant section, never overwrite others' history with a stale
copy. Re-running an update must not create duplicate records (idempotent).

If a conflict is unresolved, pause only the work that depends on it.

## decisions.md format

Index of **still-valid** decisions at the top, then records **newest first**.

```md
# تصمیم‌های پروژه

## فهرست تصمیم‌های جاری

| شناسه | موضوع / محدودهٔ اثر فعلی |
| ----- | ------------------------ |
| D-001 | [موضوع و محدوده]         |

## D-001 — [عنوان روشن]

- تاریخ و وضعیت: [YYYY-MM-DD یا «تاریخ نامشخص»] | معتبر / بخشی جایگزین‌شده / جایگزین‌شده / لغوشده
- زمینه: [چه مسئله، نیاز یا محدودیتی وجود داشت؟]
- بررسی و دلیل: [گزینه‌هایی که واقعاً بررسی شدند و چرا این؛ اگر معلوم نیست: «دلیل ثبت نشده».]
- تصمیم: [انتخاب دقیق، دامنهٔ اثر، پیامد و محدودیت پذیرفته‌شده.]
- مبنا و منشأ: [تأیید صاحب پروژه، تصمیم قبلی، بخش PRD، سند یا شواهد قابل‌ارجاع.]
- جایگزینی / بازنگری: [در صورت وجود.]
```

- IDs start at `D-001`, stay fixed and unique, never reused.
- Only important **accepted** decisions: product behaviour changes,
  architecture choices with impact, business/security policy, accepted
  constraints, dropping a major path, changing a prior decision. Routine bug
  fixes, unapproved ideas and "we use library X" are not decisions.
- Routine technical choices need no re-approval; product behaviour changes need
  clear backing.
- Changing a decision's meaning = **new record** stating old choice, new
  choice, reason and exactly what is replaced; keep the old record with an
  updated status and a reference. Cancelling a new decision does not revive the
  old one.
- A valid decision is not necessarily implemented — remaining work lives in
  `status.md`.
- Never delete historical reasoning; correct a wrong record with a dated note.
- For anything recovered from memory, state origin and certainty.

## status.md format

Two layers: the **top** is rewritten to the latest state; the **history** keeps
past meaningful results, newest date first.

```md
# وضعیت پروژه

آخرین به‌روزرسانی: YYYY-MM-DD

## تصویر فعلی

- [۲ تا ۵ بولت از وضعیت بخش‌های اصلی، محدودیت مهم و تمرکز فعلی.]
- مبنای بررسی: [branch / commit / محیط / تغییرات commit‌نشده]
- سطح بررسی: [چه چیزی واقعاً وارسی یا تست شده و چه چیزی صرفاً گزارش شده]

## کارهای باز

| تسک   | هدف و شرط پایان    | وضعیت | پیشرفت / مانع / اقدام باقی‌مانده |
| ----- | ------------------ | ----- | -------------------------------- |
| T-001 | [نتیجهٔ قابل‌سنجش] | در صف | [اقدام مشخص]                     |

## ادامه از اینجا

- قدم بعدی: [نخستین اقدام مشخص + شناسهٔ تسک]
- اطلاعات لازم: [فایل، تصمیم، پیش‌نیاز یا دسترسی مؤثر]

## تاریخچهٔ کارها

### YYYY-MM-DD

#### T-001 — [عنوان] | [پیشرفت / تکمیل / توقف / ناموفق / لغو / بازگردانی / بازگشایی]

- انجام‌شده: [تغییر یا بررسی مشخص و اثر آن]
- بررسی: [روش/تست، دامنه، نسخه یا محیط و نتیجه؛ یا «اجرا نشده» با دلیل]
- باقی‌مانده / ارجاع: [اقدام باز، D/T مرتبط، فایل یا commit/PR]
```

Open-task states: `در صف`, `در حال انجام`, `منتظر بررسی`, `مسدود`, `متوقف`.

- Every trackable job has a fixed `T-NNN`; continuing a job keeps its id.
  Small same-goal steps are sub-steps of one task; independent work gets its
  own task.
- An open task needs a goal and a done-condition.
- History records are summaries of **meaningful actions and results** (paths,
  components, effect), not command transcripts.
- Mark `تکمیل` only when the done-condition and required verification really
  happened. "Code written", "tests passed", "merged" and "released" are four
  different claims.
- If a required test has not run, the task stays open (`منتظر بررسی` etc.).
  Do not invent unnecessary tests as a gate.
- Say what a test proves and what it does not. Do not generalise one
  environment/version to another. Mark unverified claims
  «گزارش‌شده؛ اینجا بررسی نشده».
- Done/cancelled tasks leave the open table but stay in history. Real leftovers
  need an open task or an explicit out-of-scope decision.
- Stops, failures, reopenings, rollbacks or later-found bugs update both the
  current state and history; never erase correct earlier history.
- Keep effective bugs and doc ↔ code mismatches open until resolved.

## Writing rules

- Write in fluent **Persian**; keep file names, ids, commands, tool names and
  technical terms exact.
- Dates `YYYY-MM-DD`; times include a timezone. Never guess past dates — use
  «تاریخ نامشخص؛ بازسازی در YYYY-MM-DD».
- Keep observed fact, confirmed decision, someone else's report and inference
  clearly separate. Report only checks and options that actually happened.
- Stable references: repo-relative paths, PRD section, D-/T- id, commit, PR,
  issue. "Per an earlier chat" is not a reference.
- **No secrets or private data:** no passwords, tokens, API keys, `.env`
  contents, production identifiers or user data. Describe security
  requirements without quoting secret values.
- Don't delete valid history or PRD content to look shorter; cut repetition
  instead. Target \~6–10 lines per decision, \~4–8 per task record, but never
  drop essential detail to hit the number.
- The docs must be usable by someone with no access to agent memory or past
  chats. If a repo, history, memory, service or test environment was not
  accessible, record the limitation and its impact instead of guessing.

## Bootstrap / rebuild (only when the folder or a file is missing or incomplete)

Creating empty files is not the end of the job. Full procedure: section ۴ of
`how_to_update_docs.md`. In short:

1. Create only the missing folder/files; never rewrite, blank or delete
   existing files without review. Keep `how_to_update_docs.md` in the folder.
2. Gather evidence proportionate to the project: repo structure, entry points,
   APIs, schema/migrations, README/issues, configs, CI, git branch/commit/
   status, PRs, tests (run only safe read-only ones), and real memory of past
   decisions. Ignore `node_modules`/build output as evidence.
3. If a real PRD exists elsewhere, **move** it unchanged (`git mv`) and fix
   references; never rewrite it. If none exists, write an evidence-based PRD
   (identity, goals/scope, user flows, functional, non-functional, boundaries,
   acceptance criteria, open questions) with a header stating status,
   rebuild date, basis and known limits; separate confirmed requirement,
   observed behaviour and inference.
4. Rebuild `decisions.md` from verifiable sources only; code-only evidence is a
   "technical observation", not a historical decision.
5. Rebuild `status.md` from today's reality with a dated
   «بازسازی اولیهٔ مستندات» record of what was and was not checked. Do not
   invent pre-rebuild history; distinguish "exists in code" from "implemented
   today".

## Final check before handing off

- Folder and all four files exist, one valid copy of the guide inside.
- Newcomer can tell what to build, why decisions were made, what is done and
  what remains.
- Valid decisions are separate from proposals; PRD/decision changes have an
  exact scope.
- No test, merge, release or completion is claimed beyond the evidence.
- Current state, history, decisions index and checked code are consistent, or
  mismatches are visible.
- Prior content preserved, no secrets added, no duplicate ids or records on
  re-run.
