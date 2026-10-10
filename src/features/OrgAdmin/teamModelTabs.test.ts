import { describe, expect, it } from 'vitest';

import { buildTeamModelTabs, getTeamModelCost } from './teamModelTabs';

describe('buildTeamModelTabs', () => {
  it('orders tabs all → chat → image → video, then other types', () => {
    const tabs = buildTeamModelTabs([
      { id: 'v1', type: 'video' },
      { id: 'tts1', type: 'tts' },
      { id: 'i1', type: 'image' },
      { id: 'c1', type: 'chat' },
    ]);

    expect(tabs.map((tab) => tab.type)).toEqual(['all', 'chat', 'image', 'video', 'tts']);
    expect(tabs[0].items.map((model) => model.id).sort()).toEqual(['c1', 'i1', 'tts1', 'v1']);
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

  it('skips the all tab when the catalog has a single type', () => {
    const tabs = buildTeamModelTabs([
      { id: 'a', type: 'chat' },
      { id: 'b', type: 'chat' },
    ]);

    expect(tabs.map((tab) => tab.type)).toEqual(['chat']);
  });

  it('returns no tabs for an empty catalog', () => {
    expect(buildTeamModelTabs([])).toEqual([]);
  });

  it('sorts enabled models before disabled ones in every tab', () => {
    const models = [
      { id: 'c-off', type: 'chat' },
      { id: 'c-on', type: 'chat' },
      { id: 'i-off', type: 'image' },
      { id: 'i-on', type: 'image' },
    ];
    const isEnabled = (id: string) => id.endsWith('-on');

    const tabs = buildTeamModelTabs(models, isEnabled);

    expect(tabs.find((tab) => tab.type === 'chat')?.items.map((model) => model.id)).toEqual([
      'c-on',
      'c-off',
    ]);
    expect(tabs.find((tab) => tab.type === 'image')?.items.map((model) => model.id)).toEqual([
      'i-on',
      'i-off',
    ]);
    expect(tabs.find((tab) => tab.type === 'all')?.items.map((model) => model.id)).toEqual([
      'c-on',
      'i-on',
      'c-off',
      'i-off',
    ]);
  });

  it('keeps catalog order when no enabled predicate is given', () => {
    const tabs = buildTeamModelTabs([
      { id: 'b', type: 'chat' },
      { id: 'a', type: 'chat' },
    ]);

    expect(tabs[0].items.map((model) => model.id)).toEqual(['b', 'a']);
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
