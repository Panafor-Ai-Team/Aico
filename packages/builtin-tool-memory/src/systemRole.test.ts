import { describe, expect, it } from 'vitest';

import { systemPrompt } from './systemRole';

// Aico: nothing extracts memories in the background, so the chat model must save them itself.
describe('memory tool systemPrompt', () => {
  it('tells the model to save durable facts without being asked', () => {
    expect(systemPrompt).toContain('<proactive_saving>');
    expect(systemPrompt).toContain('Do not wait for the user to say "remember this"');
  });

  it('does not hand saving off to a downstream extractor', () => {
    expect(systemPrompt).not.toMatch(/downstream extractors/i);
    expect(systemPrompt).not.toContain('default to omission when uncertain');
  });
});
