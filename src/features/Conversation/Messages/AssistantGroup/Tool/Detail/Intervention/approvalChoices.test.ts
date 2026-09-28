import { describe, expect, it } from 'vitest';

import { resolveApprovalChoices } from './approvalChoices';

describe('resolveApprovalChoices', () => {
  it('offers approve and reject in manual mode', () => {
    expect(resolveApprovalChoices({ isAllowListMode: false })).toEqual(['approve', 'reject']);
  });

  it('adds "approve and remember" in allow-list mode', () => {
    expect(resolveApprovalChoices({ isAllowListMode: true })).toEqual([
      'approve',
      'approve-remember',
      'reject',
    ]);
  });

  it('offers only Confirm on confirm-only cards, with no reject or remember', () => {
    expect(resolveApprovalChoices({ confirmOnly: true, isAllowListMode: true })).toEqual([
      'approve',
    ]);
    expect(resolveApprovalChoices({ confirmOnly: true, isAllowListMode: false })).toEqual([
      'approve',
    ]);
  });
});
