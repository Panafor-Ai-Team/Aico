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

    // CVC turns some models' text-format tool calls into JSON by the top-level
    // parameter type. A `[T, "null"]` list breaks it: arguments arrive cut off at
    // `{"details": ` and the call leaks into `content` as `<tool_call>` text.
    describe('nullable tool parameter types', () => {
      const tool = (properties: Record<string, any>) => ({
        function: {
          name: 'lobe-user-memory____addIdentityMemory',
          parameters: { properties, required: Object.keys(properties), type: 'object' },
        },
        type: 'function' as const,
      });

      it('rewrites a top-level [T, "null"] type to T', () => {
        const result = handlePayload({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'mimo-v2.6-pro',
          tools: [
            tool({
              details: { description: 'Optional detailed information', type: ['string', 'null'] },
              enabled: { type: ['null', 'boolean'] },
              limit: { type: ['number', 'null'] },
              sourceIds: { items: { type: 'string' }, type: ['array', 'null'] },
            }),
          ],
        } as any) as any;

        expect(result.tools[0].function.parameters.properties).toEqual({
          details: { description: 'Optional detailed information', type: 'string' },
          enabled: { type: 'boolean' },
          limit: { type: 'number' },
          sourceIds: { items: { type: 'string' }, type: 'array' },
        });
        expect(result.tools[0].function.parameters.required).toEqual([
          'details',
          'enabled',
          'limit',
          'sourceIds',
        ]);
      });

      it('leaves plain types, nested schemas and other unions untouched', () => {
        const properties = {
          either: { type: ['string', 'number'] },
          title: { type: 'string' },
          withIdentity: {
            properties: { episodicDate: { type: ['string', 'null'] } },
            type: 'object',
          },
        };

        const result = handlePayload({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'mimo-v2.6-pro',
          tools: [tool(properties)],
        } as any) as any;

        expect(result.tools[0].function.parameters.properties).toEqual(properties);
      });

      it('does not mutate the caller payload', () => {
        const tools = [tool({ details: { type: ['string', 'null'] } })];

        handlePayload({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'mimo-v2.6-pro',
          tools,
        } as any);

        expect(tools[0].function.parameters.properties.details.type).toEqual(['string', 'null']);
      });

      it('sends no tools key when the request has none', () => {
        const result = handlePayload({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'mimo-v2.6-pro',
        } as any);

        expect(result).not.toHaveProperty('tools');
      });
    });
  });
});

describe('params.baseURL', () => {
  const load = async () => {
    vi.resetModules();
    return (await import('./index')).params.baseURL;
  };

  it('defaults to the ru. origin', async () => {
    vi.stubEnv('CHEAPVIBECODE_CHAT_BASE_URL', '');
    await expect(load()).resolves.toBe('https://ru.cheapvibecode.ru/v1');
    vi.unstubAllEnvs();
  });

  it('can be pointed at another origin by env', async () => {
    vi.stubEnv('CHEAPVIBECODE_CHAT_BASE_URL', 'https://cheapvibecode.ru/v1');
    await expect(load()).resolves.toBe('https://cheapvibecode.ru/v1');
    vi.unstubAllEnvs();
  });
});
