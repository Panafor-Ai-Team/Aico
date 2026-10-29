import { describe, expect, it } from 'vitest';

import { pluginHelpers } from './helpers';

describe('pluginHelpers.getToolFallbackName', () => {
  it('drops the internal lobe- prefix from a tool identifier', () => {
    expect(pluginHelpers.getToolFallbackName('lobe-activator')).toBe('activator');
  });

  it('keeps identifiers without the prefix', () => {
    expect(pluginHelpers.getToolFallbackName('web-search')).toBe('web-search');
  });
});
