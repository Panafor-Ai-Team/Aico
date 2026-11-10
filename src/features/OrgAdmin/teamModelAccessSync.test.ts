import { describe, expect, it, vi } from 'vitest';

import { mutate } from '@/libs/swr';

import { revalidateTeamModelAccess } from './teamModelAccessSync';

vi.mock('@/libs/swr', () => ({
  mutate: vi.fn(),
}));

describe('revalidateTeamModelAccess', () => {
  it('revalidates the member allow-list key the selectors subscribe to', () => {
    revalidateTeamModelAccess('org-1');

    // Same key shape as useEnabledChatModels / useEnabledImageModels use for
    // `aico-my-allowed-models`, so every mounted picker refreshes.
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(['aico-my-allowed-models', 'org-1']);
  });
});
