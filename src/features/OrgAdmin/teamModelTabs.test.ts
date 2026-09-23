import { describe, expect, it } from 'vitest';

import { buildTeamModelTabs } from './teamModelTabs';

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
