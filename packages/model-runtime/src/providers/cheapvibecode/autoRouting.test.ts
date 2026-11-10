import { describe, expect, it } from 'vitest';

import type { ChatStreamPayload } from '../../types/chat';
import {
  DEFAULT_CVC_AUTO_ROUTE,
  isAutoModelId,
  resolveAutoModel,
  resolveAutoRoute,
} from './autoRouting';

const payload = (overrides: Partial<ChatStreamPayload> = {}): ChatStreamPayload =>
  ({
    messages: [{ content: 'hi', role: 'user' }],
    model: 'openrouter/auto',
    temperature: 1,
    ...overrides,
  }) as ChatStreamPayload;

const imageMessage = {
  content: [
    { text: 'what is this', type: 'text' },
    { image_url: { url: 'data:image/png;base64,AA' }, type: 'image_url' },
  ],
  role: 'user',
};

describe('isAutoModelId', () => {
  it.each([
    'openrouter/auto',
    'cheapvibecode/auto',
    'aico/auto',
    'panachat/auto',
    'OpenRouter/Auto',
    '  openrouter/auto  ',
    'auto',
  ])('accepts %s', (id) => {
    expect(isAutoModelId(id)).toBe(true);
  });

  it.each(['gpt-5.6-luna', 'openrouter/autopilot', 'auto/openrouter', '', null, undefined])(
    'rejects %s',
    (id) => {
      expect(isAutoModelId(id)).toBe(false);
    },
  );
});

describe('resolveAutoModel', () => {
  it('leaves a concrete model id alone', () => {
    expect(resolveAutoModel(payload({ model: 'claude-sonnet-5' }))).toBe('claude-sonnet-5');
  });

  it('routes plain text to the best value model', () => {
    expect(resolveAutoModel(payload())).toBe(DEFAULT_CVC_AUTO_ROUTE.default);
  });

  it('routes a tool-calling text request to the default, which supports tools', () => {
    const resolved = resolveAutoModel(
      payload({ tools: [{ function: { name: 'search' }, type: 'function' }] as never }),
    );
    expect(resolved).toBe(DEFAULT_CVC_AUTO_ROUTE.default);
  });

  it('routes a reasoning request to the reasoning model', () => {
    expect(resolveAutoModel(payload({ thinking: { type: 'enabled' } } as never))).toBe(
      DEFAULT_CVC_AUTO_ROUTE.reasoning,
    );
  });

  it('treats a disabled or minimal reasoning effort as no reasoning', () => {
    expect(resolveAutoModel(payload({ reasoning_effort: 'none' } as never))).toBe(
      DEFAULT_CVC_AUTO_ROUTE.default,
    );
    expect(resolveAutoModel(payload({ reasoning_effort: 'minimal' } as never))).toBe(
      DEFAULT_CVC_AUTO_ROUTE.default,
    );
  });

  it('routes an image request to the cheapest vision model', () => {
    expect(resolveAutoModel(payload({ messages: [imageMessage] as never }))).toBe(
      DEFAULT_CVC_AUTO_ROUTE.vision,
    );
  });

  it('routes an image request that also needs tools to the vision+tools model', () => {
    // The cheap vision model does not declare tool calling, so needing both
    // costs more than needing either alone. Asserted so a table edit that
    // silently drops tool support from this slot fails here.
    const resolved = resolveAutoModel(
      payload({
        messages: [imageMessage] as never,
        tools: [{ function: { name: 'search' }, type: 'function' }] as never,
      }),
    );
    expect(resolved).toBe(DEFAULT_CVC_AUTO_ROUTE.visionTools);
  });

  it('prefers vision over reasoning when a request wants both', () => {
    const resolved = resolveAutoModel(
      payload({ messages: [imageMessage] as never, thinking: { type: 'enabled' } } as never),
    );
    expect(resolved).toBe(DEFAULT_CVC_AUTO_ROUTE.vision);
  });
});

describe('resolveAutoRoute', () => {
  it('falls back to the built-in table when unset', () => {
    expect(resolveAutoRoute(undefined)).toEqual(DEFAULT_CVC_AUTO_ROUTE);
    expect(resolveAutoRoute('   ')).toEqual(DEFAULT_CVC_AUTO_ROUTE);
  });

  it('overrides only the slots the config names', () => {
    const route = resolveAutoRoute('{"default":"mimo-v2.5"}');
    expect(route.default).toBe('mimo-v2.5');
    expect(route.reasoning).toBe(DEFAULT_CVC_AUTO_ROUTE.reasoning);
  });

  it('ignores a malformed config rather than taking chat down', () => {
    expect(resolveAutoRoute('not json')).toEqual(DEFAULT_CVC_AUTO_ROUTE);
    expect(resolveAutoRoute('{"default":42,"vision":"  "}')).toEqual(DEFAULT_CVC_AUTO_ROUTE);
  });

  it('routes through an override table', () => {
    const route = resolveAutoRoute('{"reasoning":"deepseek-v4.1-flash"}');
    expect(resolveAutoModel(payload({ thinking: { type: 'enabled' } } as never), route)).toBe(
      'deepseek-v4.1-flash',
    );
  });
});
