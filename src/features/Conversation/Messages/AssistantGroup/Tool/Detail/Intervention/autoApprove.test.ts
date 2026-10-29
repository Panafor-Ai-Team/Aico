import { describe, expect, it } from 'vitest';

import { canAutoApprovePendingIntervention } from './autoApprove';

const plainManifest = {
  api: [{ humanIntervention: 'required' as const, name: 'runCommand' }],
};

describe('canAutoApprovePendingIntervention', () => {
  it('approves a plain "required" tool call', () => {
    expect(
      canAutoApprovePendingIntervention({
        apiName: 'runCommand',
        identifier: 'test-shell',
        manifest: plainManifest,
        requestArgs: JSON.stringify({ command: 'ls -la' }),
      }),
    ).toBe(true);
  });

  it('keeps asking for security-blacklisted arguments', () => {
    expect(
      canAutoApprovePendingIntervention({
        apiName: 'runCommand',
        identifier: 'test-shell',
        manifest: plainManifest,
        requestArgs: JSON.stringify({ command: 'rm -rf ~' }),
      }),
    ).toBe(false);
  });

  it('keeps asking for "always" policies', () => {
    expect(
      canAutoApprovePendingIntervention({
        apiName: 'publish',
        identifier: 'test-tool',
        manifest: { api: [{ humanIntervention: 'always', name: 'publish' }] },
        requestArgs: '{}',
      }),
    ).toBe(false);
  });

  it('follows the dynamic policy an audit asks with', () => {
    const dynamicManifest = (policy?: 'always' | 'required') => ({
      api: [
        {
          humanIntervention: { dynamic: { default: 'never' as const, policy, type: 'audit' } },
          name: 'run',
        },
      ],
    });

    expect(
      canAutoApprovePendingIntervention({
        apiName: 'run',
        identifier: 'test-tool',
        manifest: dynamicManifest('required'),
        requestArgs: '{}',
      }),
    ).toBe(true);
    expect(
      canAutoApprovePendingIntervention({
        apiName: 'run',
        identifier: 'test-tool',
        manifest: dynamicManifest('always'),
        requestArgs: '{}',
      }),
    ).toBe(false);
    expect(
      canAutoApprovePendingIntervention({
        apiName: 'run',
        identifier: 'test-tool',
        manifest: dynamicManifest(undefined),
        requestArgs: '{}',
      }),
    ).toBe(false);
  });

  it('never answers question cards for the user', () => {
    expect(
      canAutoApprovePendingIntervention({
        apiName: 'askUserQuestion',
        identifier: 'lobe-user-interaction',
        requestArgs: '{}',
      }),
    ).toBe(false);
  });
});
