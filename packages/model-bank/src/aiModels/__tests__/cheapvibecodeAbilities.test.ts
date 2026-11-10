import { describe, expect, it } from 'vitest';

import cheapvibecodeModels from '../cheapvibecode';

describe('cheapvibecode fallback abilities', () => {
  it('declares tool calling and vision on every chat row', () => {
    const chat = cheapvibecodeModels.filter((m) => m.type === 'chat');
    expect(chat.length).toBeGreaterThan(0);
    for (const model of chat) {
      expect(
        model.abilities,
        `${model.id} must serve functionCall + vision like the gateway honors`,
      ).toMatchObject({ functionCall: true, vision: true });
    }
  });
});
