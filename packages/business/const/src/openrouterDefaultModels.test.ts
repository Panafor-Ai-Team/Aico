import { describe, expect, it } from 'vitest';

import {
  computeDefaultEnabledOpenRouterModelIds,
  DEFAULT_AUTO_IMAGE_MODEL_ID,
  ensureOpenRouterAutoModel,
  ensureOpenRouterModels,
  isDefaultAutoImageModelId,
  isManagedAutoModelId,
  MANAGED_AUTO_MODEL_ID,
  OPENROUTER_AUTO_MODEL_ID,
  pickDefaultAutoImageModel,
  pickPreferredDefaultOpenRouterModelId,
} from './openrouterDefaultModels';

describe('computeDefaultEnabledOpenRouterModelIds', () => {
  it('always pins Auto plus the newest 4 chat models per family', () => {
    const enabled = computeDefaultEnabledOpenRouterModelIds([
      { id: 'openai/gpt-1', releasedAt: '2024-01-01', type: 'chat' },
      { id: 'openai/gpt-2', releasedAt: '2024-06-01', type: 'chat' },
      { id: 'openai/gpt-3', releasedAt: '2025-01-01', type: 'chat' },
      { id: 'openai/gpt-4', releasedAt: '2025-06-01', type: 'chat' },
      { id: 'openai/gpt-5', releasedAt: '2025-12-01', type: 'chat' },
      { id: 'anthropic/claude-1', releasedAt: '2024-01-01', type: 'chat' },
      { id: 'anthropic/claude-2', releasedAt: '2024-06-01', type: 'chat' },
      { id: 'anthropic/claude-3', releasedAt: '2025-01-01', type: 'chat' },
      { id: 'anthropic/claude-4', releasedAt: '2025-06-01', type: 'chat' },
      { id: 'google/gemini-b', releasedAt: '2024-06-01', type: 'chat' },
      { id: 'google/gemini-c', releasedAt: '2025-01-01', type: 'chat' },
      { id: 'google/gemini-d', releasedAt: '2025-06-01', type: 'chat' },
      { id: 'google/gemini-e', releasedAt: '2025-12-01', type: 'chat' },
      { id: 'deepseek/deepseek-chat', releasedAt: '2026-01-01', type: 'chat' },
    ]);

    expect(enabled.has(OPENROUTER_AUTO_MODEL_ID)).toBe(true);
    expect(enabled.has('openai/gpt-5')).toBe(true);
    expect(enabled.has('openai/gpt-1')).toBe(false);
    expect(enabled.has('deepseek/deepseek-chat')).toBe(false);
  });

  it('pins Auto even when the catalog snapshot omits it', () => {
    const enabled = computeDefaultEnabledOpenRouterModelIds([
      { id: 'openai/gpt-4o', releasedAt: '2025-01-01', type: 'chat' },
    ]);
    expect(enabled.has(OPENROUTER_AUTO_MODEL_ID)).toBe(true);
  });

  it('pins Nano Banana Image-tab ids and :image siblings of default chat models', () => {
    const enabled = computeDefaultEnabledOpenRouterModelIds([
      { id: 'google/gemini-e', releasedAt: '2025-12-01', type: 'chat' },
      { id: 'google/gemini-e:image', type: 'image' },
      { id: 'google/gemini-3.1-flash-image-preview:image', type: 'image' },
      { id: 'google/gemini-2.5-flash-image:image', type: 'image' },
    ]);

    expect(enabled.has('google/gemini-e:image')).toBe(true);
    expect(enabled.has('google/gemini-3.1-flash-image-preview:image')).toBe(true);
    expect(enabled.has('google/gemini-2.5-flash-image:image')).toBe(true);
  });

  it('enables every catalog image and video generator, not only Nano Banana', () => {
    const enabled = computeDefaultEnabledOpenRouterModelIds([
      { id: 'openai/gpt-4o', releasedAt: '2025-01-01', type: 'chat' },
      { id: 'black-forest-labs/flux-2', type: 'image' },
      { id: 'openai/gpt-image-1:image', type: 'image' },
      { id: 'google/veo-3', type: 'video' },
      { id: 'deepseek/deepseek-chat', releasedAt: '2026-01-01', type: 'chat' },
    ]);

    expect(enabled.has('black-forest-labs/flux-2')).toBe(true);
    expect(enabled.has('openai/gpt-image-1:image')).toBe(true);
    expect(enabled.has('google/veo-3')).toBe(true);
    expect(enabled.has('deepseek/deepseek-chat')).toBe(false);
  });

  it('pins gpt-4o even when newer generations push it out of the newest 4', () => {
    const enabled = computeDefaultEnabledOpenRouterModelIds([
      { id: 'openai/gpt-4o', releasedAt: '2024-05-01', type: 'chat' },
      { id: 'openai/gpt-5', releasedAt: '2025-08-01', type: 'chat' },
      { id: 'openai/gpt-5.1', releasedAt: '2025-11-01', type: 'chat' },
      { id: 'openai/gpt-5.2', releasedAt: '2026-01-01', type: 'chat' },
      { id: 'openai/gpt-5.3', releasedAt: '2026-03-01', type: 'chat' },
      { id: 'openai/gpt-5.4', releasedAt: '2026-05-01', type: 'chat' },
    ]);

    expect(enabled.has('openai/gpt-4o')).toBe(true);
  });

  it('pins DEFAULT_MINI_MODEL (gpt-4o-mini) even when newer generations push it out of the newest 4', () => {
    const enabled = computeDefaultEnabledOpenRouterModelIds([
      { id: 'openai/gpt-4o-mini', releasedAt: '2024-07-18', type: 'chat' },
      { id: 'openai/gpt-5', releasedAt: '2025-08-01', type: 'chat' },
      { id: 'openai/gpt-5.1', releasedAt: '2025-11-01', type: 'chat' },
      { id: 'openai/gpt-5.2', releasedAt: '2026-01-01', type: 'chat' },
      { id: 'openai/gpt-5.3', releasedAt: '2026-03-01', type: 'chat' },
      { id: 'openai/gpt-5.4', releasedAt: '2026-05-01', type: 'chat' },
    ]);

    expect(enabled.has('openai/gpt-4o-mini')).toBe(true);
  });

  it('enables every catalog embedding model', () => {
    const enabled = computeDefaultEnabledOpenRouterModelIds([
      { id: 'openai/gpt-4o', releasedAt: '2025-01-01', type: 'chat' },
      { id: 'openai/text-embedding-3-small', type: 'embedding' },
      { id: 'openai/text-embedding-3-large', type: 'embedding' },
      { id: 'google/text-embedding-005', type: 'embedding' },
    ]);

    expect(enabled.has('openai/text-embedding-3-small')).toBe(true);
    expect(enabled.has('openai/text-embedding-3-large')).toBe(true);
    expect(enabled.has('google/text-embedding-005')).toBe(true);
  });
});

describe('pickPreferredDefaultOpenRouterModelId', () => {
  it('prefers openrouter/auto over family models', () => {
    expect(
      pickPreferredDefaultOpenRouterModelId([
        'openai/gpt-4o',
        OPENROUTER_AUTO_MODEL_ID,
        'anthropic/claude-x',
      ]),
    ).toBe(OPENROUTER_AUTO_MODEL_ID);
  });
});

describe('ensureOpenRouterAutoModel', () => {
  it('injects Auto when missing', () => {
    const result = ensureOpenRouterAutoModel([{ id: 'openai/gpt-4o' }], {
      id: OPENROUTER_AUTO_MODEL_ID,
    });
    expect(result[0]?.id).toBe(OPENROUTER_AUTO_MODEL_ID);
    expect(result).toHaveLength(2);
  });

  it('does not duplicate Auto', () => {
    const result = ensureOpenRouterAutoModel([{ id: OPENROUTER_AUTO_MODEL_ID }], {
      id: OPENROUTER_AUTO_MODEL_ID,
    });
    expect(result).toHaveLength(1);
  });
});

describe('ensureOpenRouterModels', () => {
  it('injects every extra card missing from the snapshot', () => {
    const result = ensureOpenRouterModels(
      [{ id: 'openai/gpt-4o' }],
      [{ id: 'openai/text-embedding-3-small' }, { id: 'openai/gpt-4o' }],
    );
    expect(result.map((m) => m.id)).toEqual(['openai/text-embedding-3-small', 'openai/gpt-4o']);
  });

  it('is a no-op when every extra card already exists', () => {
    const models = [{ id: 'openai/gpt-4o' }, { id: 'openai/text-embedding-3-small' }];
    const result = ensureOpenRouterModels(models, [{ id: 'openai/text-embedding-3-small' }]);
    expect(result).toBe(models);
  });
});

describe('isDefaultAutoImageModelId', () => {
  it('matches the pinned default image model and its synthesized :image sibling', () => {
    expect(isDefaultAutoImageModelId(DEFAULT_AUTO_IMAGE_MODEL_ID)).toBe(true);
    expect(isDefaultAutoImageModelId(`${DEFAULT_AUTO_IMAGE_MODEL_ID}:image`)).toBe(true);
    expect(isDefaultAutoImageModelId('openai/gpt-image-2')).toBe(true);
    expect(isDefaultAutoImageModelId('google/gemini-2.5-flash-image:image')).toBe(false);
  });

  it('enables the pinned default image model out of the box', () => {
    const enabled = computeDefaultEnabledOpenRouterModelIds([
      { id: OPENROUTER_AUTO_MODEL_ID, type: 'chat' },
      { id: DEFAULT_AUTO_IMAGE_MODEL_ID, type: 'image' },
    ]);

    expect(enabled.has(DEFAULT_AUTO_IMAGE_MODEL_ID)).toBe(true);
  });
});

describe('default auto image model', () => {
  it('is GPT Image 2, with Muse still treated as a default for OpenRouter', () => {
    expect(DEFAULT_AUTO_IMAGE_MODEL_ID).toBe('gpt-image-2');
    expect(isDefaultAutoImageModelId('meta/muse-image')).toBe(true);
  });

  it('picks by preference order, not by list order', () => {
    const ids = ['meta/muse-image', 'gpt-image-2'];
    expect(pickDefaultAutoImageModel(ids, (id) => id)).toBe('gpt-image-2');
    expect(pickDefaultAutoImageModel(['meta/muse-image:image'], (id) => id)).toBe(
      'meta/muse-image:image',
    );
    expect(pickDefaultAutoImageModel(['some/other'], (id) => id)).toBeUndefined();
  });

  it('picks OpenRouter vendor-prefixed openai/gpt-image-2 as the product default', () => {
    expect(pickDefaultAutoImageModel(['meta/muse-image', 'openai/gpt-image-2'], (id) => id)).toBe(
      'openai/gpt-image-2',
    );
  });
});

describe('isManagedAutoModelId', () => {
  it.each([
    OPENROUTER_AUTO_MODEL_ID,
    MANAGED_AUTO_MODEL_ID,
    'cheapvibecode/auto',
    'aico/auto',
    'OpenRouter/AUTO',
    '  openrouter/auto ',
    'auto',
  ])('accepts %s', (id) => {
    expect(isManagedAutoModelId(id)).toBe(true);
  });

  it.each([
    'openai/gpt-4o',
    'openrouter/autopilot',
    'someoneelse/auto',
    'auto/openrouter',
    '',
    null,
    undefined,
  ])('rejects %s', (id) => {
    expect(isManagedAutoModelId(id)).toBe(false);
  });

  it('keeps the storage id stable — agent configs and the pinned catalog row hold it', () => {
    expect(MANAGED_AUTO_MODEL_ID).toBe('openrouter/auto');
  });
});

describe('a gateway catalog with no vendor prefixes', () => {
  // Shape of CheapVibeCode's live /v1/models: bare ids, no releasedAt.
  const cvcCatalog = [
    { id: 'claude-opus-5' },
    { id: 'gpt-6-astra' },
    { id: 'gemini-3.8-flash' },
    { id: 'glm-5.3-flash' },
    { id: 'deepseek-v4.1-flash' },
    { id: 'grok-4.6' },
  ];

  it('enables every chat model, because the per-family trim has nothing to rank on', () => {
    const enabled = computeDefaultEnabledOpenRouterModelIds(cvcCatalog);

    // Before this branch existed the trim bucketed nothing and the picker showed
    // only the pins — an effectively empty model list for every user.
    for (const model of cvcCatalog) {
      expect(enabled.has(model.id)).toBe(true);
    }
    expect(enabled.has(OPENROUTER_AUTO_MODEL_ID)).toBe(true);
  });

  it('still leaves a vendor-prefixed catalog curated', () => {
    const enabled = computeDefaultEnabledOpenRouterModelIds([
      { id: 'openai/gpt-4o' },
      { id: 'anthropic/claude-opus-5' },
      { id: 'some-vendor/tiny-experiment' },
    ]);

    expect(enabled.has('some-vendor/tiny-experiment')).toBe(false);
  });
});
