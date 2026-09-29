// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { LobeCheapVibeCodeAI, params } from './index';

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

  describe('chatCompletion.handlePayload', () => {
    const handlePayload = params.chatCompletion.handlePayload!;

    it('forwards reasoning_effort to the upstream body', () => {
      const result = handlePayload({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'gpt-5.6-terra',
        reasoning_effort: 'medium',
      } as any);

      expect(result).toMatchObject({
        model: 'gpt-5.6-terra',
        reasoning_effort: 'medium',
      });
    });

    it('omits reasoning_effort when not set', () => {
      const result = handlePayload({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'gpt-5.6-terra',
      } as any);

      expect(result).not.toHaveProperty('reasoning_effort');
    });

    it('strips Google-shaped thinking fields', () => {
      const result = handlePayload({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'gemini-3.8-flash',
        thinking: { type: 'enabled' },
        thinkingLevel: 'high',
      } as any);

      expect(result).not.toHaveProperty('thinking');
      expect(result).not.toHaveProperty('thinkingLevel');
    });
  });
});
