import { describe, expect, it } from 'vitest';

import { filterOrgScopedImageModels } from './orgScopedImageModels';

const catalog = [
  { id: 'meta/muse-image', type: 'image' },
  { id: 'granted/image-model', type: 'image' },
  { id: 'ungranted/image-model', type: 'image' },
  { id: 'granted/chat-model', type: 'chat' },
] as any[];

describe('filterOrgScopedImageModels', () => {
  it('keeps only image models the team granted', () => {
    const result = filterOrgScopedImageModels(catalog, [
      'granted/image-model',
      'granted/chat-model',
    ]);

    expect(result.map((model) => model.id)).toEqual(['meta/muse-image', 'granted/image-model']);
  });

  it('always keeps the product default image model, even for a team that never granted it', () => {
    const result = filterOrgScopedImageModels(catalog, ['granted/image-model']);

    expect(result.map((model) => model.id)).toContain('meta/muse-image');
  });

  it('returns the default alone when the team grants no image model', () => {
    expect(filterOrgScopedImageModels(catalog, []).map((model) => model.id)).toEqual([
      'meta/muse-image',
    ]);
  });
});
