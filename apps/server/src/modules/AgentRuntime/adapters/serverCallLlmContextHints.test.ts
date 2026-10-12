import { describe, expect, it } from 'vitest';

import { resolveServerCallLlmContextHints } from './serverCallLlmContextHints';

const hintsFor = (model: string, provider: string) =>
  resolveServerCallLlmContextHints({
    ctx: { agentConfig: undefined } as any,
    llmPayload: { messages: [] } as any,
    model,
    provider,
  });

describe('resolveServerCallLlmContextHints Auto router', () => {
  it('reports vision and tool use for the managed Auto router', async () => {
    // Regression: the static model bank carries no Auto card, so server-side
    // runs on Panachat Auto read as vision-less and context engineering
    // stripped image parts before the router resolved them to vision models.
    const { capabilities } = await hintsFor('openrouter/auto', 'cheapvibecode');

    expect(capabilities.isCanUseVision('openrouter/auto', 'cheapvibecode')).toBe(true);
    expect(capabilities.isCanUseFC('openrouter/auto', 'cheapvibecode')).toBe(true);
  });

  it('still reports no vision for unknown models', async () => {
    const { capabilities } = await hintsFor('missing-model', 'missing-provider');

    expect(capabilities.isCanUseVision('missing-model', 'missing-provider')).toBe(false);
  });

  it('reports vision for Auto alias spellings without a static card', async () => {
    // `aico/auto` has no static model-bank row; the router carve-out covers it.
    const { capabilities } = await hintsFor('aico/auto', 'aico');

    expect(capabilities.isCanUseVision('aico/auto', 'aico')).toBe(true);
  });
});
