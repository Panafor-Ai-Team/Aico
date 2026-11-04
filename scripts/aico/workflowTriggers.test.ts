import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Upstream syncs bring LobeHub's GitHub workflows with them. Any workflow that runs on its
 * own (push, schedule, PR/issue events) acts on Aico's repository and secrets, so each one
 * is reviewed before it may do that: everything else must stay `workflow_dispatch`-only.
 * Workflows that publish to a package registry are never automatic.
 *
 * M1 shipped `release-sdk.yml`, which publishes `@lobehub/sdk` to npm on every SDK change;
 * it failed only because the repo has no `NPM_TOKEN`.
 */
const workflowsDir = path.join(__dirname, '../../.github/workflows');

/** Reviewed automatic workflows, with the reason each may run on its own. */
const REVIEWED_AUTOMATIC: Record<string, string> = {
  'aico-tests.yml': 'Aico test gate (PRs and the canary deploy)',
  'auto-i18n.yml': 'daily translation PR for non-visible locales',
  'auto-tag-release.yml': 'tags releases when a PR merges into main',
  'deploy-canary.yml': 'Aico canary deploy',
  'deploy-preview.yml': 'Aico preview deploy',
  'docker-smoke.yml': 'Aico image smoke test on PRs',
  'issue-auto-close-duplicates.yml': 'issue housekeeping',
  'issue-auto-comments.yml': 'issue housekeeping',
  'lock-closed-issues.yml': 'issue housekeeping',
  'migration-ledger.yml': 'Aico migration scenarios on PRs',
  'release.yml': 'runs on v* release tags; pushes a README sync commit',
  'sync-database-schema.yml': 'schema docs sync on main',
  'sync-main-to-canary.yaml': 'opens the main → canary sync PR',
  'type-check.yml': 'type-check on PRs and pushes',
};

/** Steps that publish outside this repository's own deploy targets. */
const PUBLISH_COMMAND = /\b(?:npm|pnpm|yarn) publish\b|\bchangeset publish\b|\bsemantic-release\b/;

const workflows = readdirSync(workflowsDir)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort()
  .map((file) => {
    const source = readFileSync(path.join(workflowsDir, file), 'utf8');
    const doc = parse(source) as { on?: unknown; true?: unknown };
    // YAML 1.1 readers turn a bare `on:` key into `true`; accept both.
    const on = doc.on ?? doc.true;
    const triggers =
      typeof on === 'string'
        ? [on]
        : Array.isArray(on)
          ? (on as string[])
          : Object.keys((on as Record<string, unknown>) ?? {});
    const calls = [...source.matchAll(/uses:\s*\.\/\.github\/workflows\/([\w.-]+)/g)].map(
      ([, called]) => called,
    );
    return { calls, file, publishes: PUBLISH_COMMAND.test(source), triggers };
  });

/**
 * Triggers that start a workflow without a person. A reusable workflow's `workflow_call`
 * is automatic only when a workflow that calls it is.
 */
const automaticTriggers = (triggers: string[], file?: string, seen = new Set<string>()) =>
  triggers.filter((trigger) => {
    if (trigger === 'workflow_dispatch') return false;
    if (trigger !== 'workflow_call' || !file) return true;
    return workflows.some(
      (caller) =>
        caller.calls.includes(file) &&
        !seen.has(caller.file) &&
        automaticTriggers(caller.triggers, caller.file, new Set([...seen, file])).length > 0,
    );
  });

describe('GitHub workflow triggers', () => {
  it('parses every workflow and finds its triggers', () => {
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows.filter((workflow) => workflow.triggers.length === 0)).toEqual([]);
  });

  it('never publishes to a package registry automatically', () => {
    const automaticPublishers = workflows
      .filter(
        (workflow) =>
          workflow.publishes && automaticTriggers(workflow.triggers, workflow.file).length > 0,
      )
      .map(({ file, triggers }) => ({ file, triggers }));

    expect(automaticPublishers).toEqual([]);
  });

  it('runs on its own only when reviewed (new upstream workflows stay dispatch-only)', () => {
    const unreviewed = workflows
      .filter(
        (workflow) =>
          automaticTriggers(workflow.triggers, workflow.file).length > 0 &&
          !REVIEWED_AUTOMATIC[workflow.file],
      )
      .map(({ file, triggers }) => ({ file, triggers }));

    expect(unreviewed).toEqual([]);
  });

  it('treats a reusable workflow as automatic only through an automatic caller', () => {
    const reusable = workflows.filter((workflow) => workflow.triggers.includes('workflow_call'));
    expect(reusable.length).toBeGreaterThan(0);

    for (const workflow of reusable) {
      const automaticCaller = workflows.some(
        (caller) =>
          caller.calls.includes(workflow.file) &&
          automaticTriggers(caller.triggers, caller.file).length > 0,
      );
      expect(automaticTriggers(['workflow_call'], workflow.file).length > 0).toBe(automaticCaller);
    }
    expect(automaticTriggers(['workflow_call'], 'not-called-by-anything.yml')).toEqual([]);
  });

  it('keeps the reviewed list free of workflows that no longer exist', () => {
    const files = new Set(workflows.map((workflow) => workflow.file));

    expect(Object.keys(REVIEWED_AUTOMATIC).filter((file) => !files.has(file))).toEqual([]);
  });
});
