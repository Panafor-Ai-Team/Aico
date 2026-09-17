// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { LobeCheapVibeCodeAI } from './index';

describe('LobeCheapVibeCodeAI', () => {
  // The usage ledger's hold assumes the upstream never produces more than the
  // injected output cap, so the cap must reach the request body unchanged.
  it('forwards max_tokens to the upstream request', async () => {
    const instance = new LobeCheapVibeCodeAI({ apiKey: 'test_api_key' });
    const create = vi
      .spyOn(instance['client'].chat.completions, 'create')
      .mockResolvedValue(new ReadableStream() as any);

    await instance.chat({
      max_tokens: 64,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'glm-5.3-flash',
      temperature: 0,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 64, model: 'glm-5.3-flash' }),
      expect.anything(),
    );
  });
});
