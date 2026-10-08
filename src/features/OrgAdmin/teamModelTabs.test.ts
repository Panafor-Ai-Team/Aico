import { describe, expect, it } from 'vitest';

import { buildTeamModelTabs, getTeamModelCost } from './teamModelTabs';

describe('buildTeamModelTabs', () => {
  it('orders tabs chat → image → video, then other types', () => {
    const tabs = buildTeamModelTabs([
      { id: 'v1', type: 'video' },
      { id: 'tts1', type: 'tts' },
      { id: 'i1', type: 'image' },
      { id: 'c1', type: 'chat' },
    ]);

    expect(tabs.map((tab) => tab.type)).toEqual(['chat', 'image', 'video', 'tts']);
  });

  it('puts untyped models in the chat tab', () => {
    const tabs = buildTeamModelTabs([
      { id: 'a' },
      { id: 'b', type: null },
      { id: 'c', type: 'chat' },
    ]);

    expect(tabs).toHaveLength(1);
    expect(tabs[0].items.map((model) => model.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns no tabs for an empty catalog', () => {
    expect(buildTeamModelTabs([])).toEqual([]);
  });
});

describe('getTeamModelCost', () => {
  it('shows one coefficient when chat input equals output', () => {
    const cost = getTeamModelCost({
      id: 'm1',
      pricing: {
        currency: 'USD',
        units: [
          { name: 'textInput', rate: 0.16, strategy: 'fixed', unit: 'millionTokens' },
          { name: 'textOutput', rate: 0.16, strategy: 'fixed', unit: 'millionTokens' },
        ],
      },
      type: 'chat',
    });

    expect(cost).toEqual({ coefficient: '4×', kind: 'chat-single' });
  });

  it('shows input/output coefficients separately when they differ', () => {
    const cost = getTeamModelCost({
      id: 'm2',
      pricing: {
        currency: 'USD',
        units: [
          { name: 'textInput', rate: 0.04, strategy: 'fixed', unit: 'millionTokens' },
          { name: 'textOutput', rate: 0.16, strategy: 'fixed', unit: 'millionTokens' },
        ],
      },
      type: 'chat',
    });

    expect(cost).toEqual({ input: '1×', kind: 'chat-split', output: '4×' });
  });

  it('shows π per image from the catalog estimate', () => {
    const cost = getTeamModelCost({
      id: 'img1',
      pricing: { approximatePricePerImage: 0.04, currency: 'USD', units: [] },
      type: 'image',
    });

    expect(cost).toEqual({ kind: 'per-image', piAmount: '1,000' });
  });

  it('shows π per video from the generation unit', () => {
    const cost = getTeamModelCost({
      id: 'vid1',
      pricing: {
        currency: 'USD',
        units: [{ name: 'videoGeneration', rate: 0.08, strategy: 'fixed', unit: 'video' }],
      },
      type: 'video',
    });

    expect(cost).toEqual({ kind: 'per-video', piAmount: '2,000' });
  });

  it('returns null when the catalog has no usable price', () => {
    expect(getTeamModelCost({ id: 'm3', type: 'chat' })).toBeNull();
    expect(getTeamModelCost({ id: 'img2', type: 'image' })).toBeNull();
  });
});
