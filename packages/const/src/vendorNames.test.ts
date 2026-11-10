import { describe, expect, it } from 'vitest';

import { hasVendorName, scrubVendorNames, scrubVendorNamesDeep } from './vendorNames';

describe('scrubVendorNames', () => {
  it.each([
    ['CheapVibeCode API 502: Bad Gateway', 'Acme API 502: Bad Gateway'],
    ['provider cheapvibecode failed', 'provider Acme failed'],
    ['Cheap Vibe Code is down', 'Acme is down'],
    ['https://api.cheapvibecode.ru/v1/chat', 'https://api.Acme.ru/v1/chat'],
    ['OpenRouter: insufficient credits', 'Acme: insufficient credits'],
    ['model openrouter/auto', 'model Acme/auto'],
    ['https://openrouter.ai/api/v1', 'https://Acme.ai/api/v1'],
    ['Shared CVC account spent 3 µUSD', 'Shared Acme account spent 3 µUSD'],
    ['LobeHub could not start Codex', 'Acme could not start Codex'],
    ['No LobeChat authorization header', 'No Acme authorization header'],
    ['Lobe language model runtime error', 'Acme language model runtime error'],
    ['tool builtins.lobe-task failed', 'tool builtins.Acme-task failed'],
  ])('rewrites %s', (input, expected) => {
    expect(scrubVendorNames(input, 'Acme')).toBe(expected);
  });

  it('leaves unrelated words alone', () => {
    const text = 'globe lobes lobectomy cvcs ACVC router open';
    expect(scrubVendorNames(text, 'Acme')).toBe(text);
    expect(hasVendorName(text)).toBe(false);
  });

  it('reports vendor names consistently across repeated calls', () => {
    expect(hasVendorName('OpenRouter')).toBe(true);
    expect(hasVendorName('OpenRouter')).toBe(true);
    expect(hasVendorName('cvc')).toBe(true);
  });
});

describe('scrubVendorNamesDeep', () => {
  it('rewrites nested string values but keeps keys and non-plain objects', () => {
    const date = new Date(0);
    const input = {
      at: date,
      body: { error: { message: 'OpenRouter rate limit' }, provider: 'cheapvibecode' },
      count: 2,
      list: ['LobeHub', null],
      openrouterKeyId: 'k1',
    };

    const output = scrubVendorNamesDeep(input, 'Acme');

    expect(output).toEqual({
      at: date,
      body: { error: { message: 'Acme rate limit' }, provider: 'Acme' },
      count: 2,
      list: ['Acme', null],
      openrouterKeyId: 'k1',
    });
    expect(output.at).toBe(date);
    expect(input.body.provider).toBe('cheapvibecode');
  });
});
