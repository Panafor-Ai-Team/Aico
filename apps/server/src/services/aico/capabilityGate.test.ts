import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assertCapability, isCapabilityEnabled } from './capabilityGate';

const flags = vi.hoisted(() => ({ state: {} as Record<string, unknown>, throws: false }));

vi.mock('@/server/featureFlags', () => ({
  getServerFeatureFlagsStateFromRuntimeConfig: vi.fn(async () => {
    if (flags.throws) throw new Error('runtime config unavailable');
    return flags.state;
  }),
}));

beforeEach(() => {
  flags.state = {};
  flags.throws = false;
});

describe('Aico capability gate', () => {
  it('is off by default for goals, projects and expertise', async () => {
    for (const capability of ['expertise', 'goals', 'projects'] as const) {
      expect(await isCapabilityEnabled('user-1', capability)).toBe(false);
    }
  });

  it('follows the operator flag for each capability independently', async () => {
    flags.state = { enableGoals: true, enableProjects: false };

    expect(await isCapabilityEnabled('user-1', 'goals')).toBe(true);
    expect(await isCapabilityEnabled('user-1', 'projects')).toBe(false);
    expect(await isCapabilityEnabled('user-1', 'expertise')).toBe(false);
  });

  it('fails closed without a user or when the flags cannot be read', async () => {
    flags.state = { enableGoals: true };
    expect(await isCapabilityEnabled(undefined, 'goals')).toBe(false);

    flags.throws = true;
    expect(await isCapabilityEnabled('user-1', 'goals')).toBe(false);
  });

  it('refuses with FORBIDDEN when the capability is off', async () => {
    await expect(assertCapability('user-1', 'projects')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'The projects feature is not enabled',
    });

    flags.state = { enableProjects: true };
    await expect(assertCapability('user-1', 'projects')).resolves.toBeUndefined();
  });
});
