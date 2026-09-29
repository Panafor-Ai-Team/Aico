import { describe, expect, it } from 'vitest';

import { qualityLabelKey } from './qualityLabelKey';

describe('qualityLabelKey', () => {
  it('maps GPT Image 2 quality tiers to distinct i18n keys', () => {
    expect(['low', 'medium', 'high', 'auto'].map(qualityLabelKey)).toEqual([
      'config.quality.options.low',
      'config.quality.options.medium',
      'config.quality.options.high',
      'config.quality.options.auto',
    ]);
  });

  it('keeps legacy standard/hd labels', () => {
    expect(qualityLabelKey('standard')).toBe('config.quality.options.standard');
    expect(qualityLabelKey('hd')).toBe('config.quality.options.hd');
  });

  it('returns null for unknown values so the UI can fall back to the raw enum', () => {
    expect(qualityLabelKey('ultra')).toBeNull();
  });
});
