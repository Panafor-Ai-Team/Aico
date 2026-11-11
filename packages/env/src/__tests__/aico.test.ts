// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('AICO_LLM_START_TIMEOUT_SECONDS', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const read = async (raw: string | undefined) => {
    vi.stubEnv('AICO_LLM_START_TIMEOUT_SECONDS', raw);
    const { getAicoConfig } = await import('../aico');
    return getAicoConfig().AICO_LLM_START_TIMEOUT_SECONDS;
  };

  it('defaults to 60 seconds when unset or empty', async () => {
    expect(await read(undefined)).toBe(60);
    expect(await read('')).toBe(60);
  });

  it('accepts a raised value within the range', async () => {
    expect(await read('120')).toBe(120);
  });

  it('clamps out-of-range values instead of failing startup', async () => {
    expect(await read('600')).toBe(240);
    expect(await read('5')).toBe(30);
  });

  it('falls back to the default for an unparsable value', async () => {
    expect(await read('two minutes')).toBe(60);
  });
});
