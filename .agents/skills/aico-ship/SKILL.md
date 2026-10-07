---
name: aico-ship
description: >-
  Aico shipping: GitHub issues (English), finish-job closeout, and PRs to canary
  with Fixes #n. Use when creating an issue, opening a PR, finishing a shippable
  job, or the user asks for ship, submit, workflow, or closeout. Triggers on
  'issue', 'create issue', 'pr', 'create pr', 'ship', 'submit', 'workflow',
  'finish', 'closeout', 'ذخیره', 'ببند'.
---

# Aico ship (GitHub issue + PR)

Aico-owned overlay. **Do not edit** upstream LobeHub skills under `.agents/skills/`
(e.g. `pr`, `linear`) for Aico process — put overrides here instead.

## Ownership split

| Concern                                                | Use                             |
| ------------------------------------------------------ | ------------------------------- |
| Git branch / commit / push / `gh pr create` mechanics  | `pr` skill (untouched upstream) |
| Issue creation, no-search policy, finish-job, PR body  | **this skill** (`aico-ship`)    |
| Sync `upstream/canary` while keeping Aico fork changes | `aico-upstream-sync`            |

When `pr` says to search GitHub issues or link Linear (`LOBE-xxx`), **ignore that for Aico**. This fork tracks work with GitHub issues created from Cursor.

## Language

GitHub issues, PR titles/bodies, commits, review comments → **English**.

## No duplicate search

Do **not** run `gh issue list --search` before creating an issue. Agent work issues are expected to be created from Cursor in this session.

Only reuse an issue if this chat (or the user) already supplied a specific `#n`.

**Do not create a second GitHub issue** when this chat already has one for the same work (e.g. user says “issue 94” and you were about to open #95). Reuse every `#n` already in the thread.

## Creating an “issue”

Create a GitHub issue (EN) with `gh issue create`.

## Finish-job closeout

When implementation is done (or the user asks to ship / open a PR / “do the workflow”), run closeout — do not leave shippable code only as local uncommitted changes without this path.

### Auto-run vs suggest

**Run automatically** when any of:

- User asked for issue / PR / workflow / ship / submit
- Change is a real product bug fix or feature meant for `canary`
- This chat already has a GitHub `#n` for the work

**Suggest once** when:

- Scope is ambiguous and they never mentioned shipping
- Only docs / agent rules / local tooling changed
- Unrelated diffs are mixed — ask which slice to track

**Skip** when: pure Q\&A; user forbade commit/push/PR/issues; issue + PR already exist and are current.

### Checklist

1. If this chat has no `#n`, create a GitHub issue (EN) — **no** prior search
2. Follow the `pr` skill for branch (off `canary` if needed), gitmoji commit, push, and `gh pr create --base canary`
3. PR body **must** include `Fixes #n` (not only `Related to`) for **every** GitHub issue this PR finishes

## PR body (Aico)

GitHub auto-closes issues on merge when the PR body uses closing keywords (`Fixes`, `Closes`, or `Resolves`) — **one issue per line**. `Related to #n` does **not** close.

```markdown
#### 🔗 Related Issue

Fixes #123
Fixes #124
```

### Multiple issues in one PR

When one PR finishes several issues (same fix, duplicate issues, or a bundled closeout):

1. Collect **all** `#n` already in this chat — do not ship with only the newest duplicate.
2. Put **each** finished GitHub issue on its own `Fixes #n` line in the PR body (GitHub closes them on PR merge).
3. If duplicate GitHub issues exist for the same work, include **all** of them in `Fixes #n` so merge closes every duplicate — do not leave siblings open like #94 when #95 was the only `Fixes` line.

Example:

```markdown
Fixes #94
Fixes #95
```
