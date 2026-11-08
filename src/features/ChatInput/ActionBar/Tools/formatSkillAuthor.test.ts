import { BRANDING_NAME } from '@lobechat/business-const';
import { describe, expect, it } from 'vitest';

import { formatSkillAuthor } from './formatSkillAuthor';

describe('formatSkillAuthor', () => {
  it('shows upstream authors under the product name', () => {
    expect(formatSkillAuthor('LobeHub')).toBe(BRANDING_NAME);
    expect(formatSkillAuthor('LobeHub Market')).toBe(`${BRANDING_NAME} Market`);
  });

  it('keeps other authors and empty values', () => {
    expect(formatSkillAuthor('Acme')).toBe('Acme');
    expect(formatSkillAuthor(undefined)).toBeUndefined();
  });
});
