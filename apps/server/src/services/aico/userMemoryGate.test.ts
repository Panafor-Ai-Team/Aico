import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assertUserMemoryEnabled, isUserMemoryEnabled } from './userMemoryGate';

const env = vi.hoisted(() => ({ AICO_USER_MEMORY_ENABLED: true as boolean | undefined }));

vi.mock('@/envs/aico', () => ({ aicoEnv: env }));

beforeEach(() => {
  env.AICO_USER_MEMORY_ENABLED = true;
});

describe('Aico user memory switch', () => {
  it('is on by default', () => {
    env.AICO_USER_MEMORY_ENABLED = undefined;
    expect(isUserMemoryEnabled()).toBe(true);
    expect(() => assertUserMemoryEnabled()).not.toThrow();
  });

  it('turns memory off when the operator sets it to false', () => {
    env.AICO_USER_MEMORY_ENABLED = false;

    expect(isUserMemoryEnabled()).toBe(false);
    expect(() => assertUserMemoryEnabled()).toThrow(
      expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
    );
  });
});

describe('AICO_USER_MEMORY_ENABLED parsing', () => {
  it.each([
    [undefined, true],
    ['1', true],
    ['true', true],
    ['0', false],
  ])('%s → %s', async (raw, expected) => {
    vi.resetModules();
    vi.doUnmock('@/envs/aico');
    const previous = process.env.AICO_USER_MEMORY_ENABLED;
    if (raw === undefined) delete process.env.AICO_USER_MEMORY_ENABLED;
    else process.env.AICO_USER_MEMORY_ENABLED = raw;
    try {
      const { getAicoConfig } = await import('@/envs/aico');
      expect(getAicoConfig().AICO_USER_MEMORY_ENABLED).toBe(expected);
    } finally {
      if (previous === undefined) delete process.env.AICO_USER_MEMORY_ENABLED;
      else process.env.AICO_USER_MEMORY_ENABLED = previous;
    }
  });
});
