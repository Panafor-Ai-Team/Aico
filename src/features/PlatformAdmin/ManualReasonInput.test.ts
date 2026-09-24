import { describe, expect, it } from 'vitest';

import { matchesEveryWord } from './ManualReasonInput';

describe('matchesEveryWord', () => {
  it('matches a reason containing every typed word, in any order or case', () => {
    expect(matchesEveryWord('Refund for outage on 22 Sep', 'outage refund')).toBe(true);
    expect(matchesEveryWord('Refund for outage on 22 Sep', 'OUT')).toBe(true);
  });

  it('rejects a reason missing one of the typed words', () => {
    expect(matchesEveryWord('Refund for outage', 'refund bonus')).toBe(false);
  });

  it('matches Persian text', () => {
    expect(matchesEveryWord('شارژ هدیه برای پشتیبانی', 'پشتیبانی هدیه')).toBe(true);
    expect(matchesEveryWord('شارژ هدیه برای پشتیبانی', 'بازپرداخت')).toBe(false);
  });

  it('offers everything before anything is typed', () => {
    expect(matchesEveryWord('Bank transfer', '')).toBe(true);
    expect(matchesEveryWord('Bank transfer', '   ')).toBe(true);
  });
});
